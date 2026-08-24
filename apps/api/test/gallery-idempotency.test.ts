/// <reference types="node" />

import { describe, expect, it } from "vitest";
import { buildGallery } from "../src/galleries";
import { emptyOwnerGallery } from "../src/gallery-service";
import {
  createGalleryIdempotently,
  purgeExpiredIdempotencyRequests,
} from "../src/gallery-idempotency";
import { SqliteD1, database } from "./helpers/sqlite-d1";

const MIGRATIONS = [
  "migrations/20260711180000_galleries.sql",
  "migrations/20260824120000_idempotency_requests.sql",
];

function gallery(workspace: string, title: string, now: Date) {
  const result = buildGallery({ workspace, title, now });
  if (result.status !== "ok") throw new Error(`build failed: ${result.status}`);
  return result.value;
}

describe("gallery creation idempotency", () => {
  it("projects an empty response without resolving workspace storage", () => {
    const record = gallery("alpha", "Shots", new Date("2026-08-24T12:00:00Z"));
    const response = emptyOwnerGallery(
      { WEB_ORIGIN: "https://uploads.test" } as unknown as Env,
      record,
    );
    expect(response).toMatchObject({ id: record.id, title: "Shots", items: [] });
  });

  it("replays the exact response and creates one gallery", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const now = new Date("2026-08-24T12:00:00Z");
      const firstRecord = gallery("alpha", "Shots", now);
      const firstResponse = { id: firstRecord.id, title: firstRecord.title, items: [] };
      const first = await createGalleryIdempotently(database(sqlite), {
        workspace: "alpha",
        principal: "d1-token:one",
        key: "gallery-create-1",
        record: firstRecord,
        response: firstResponse,
        now,
      });
      const retryRecord = gallery("alpha", "Shots", new Date("2026-08-24T12:01:00Z"));
      const retry = await createGalleryIdempotently(database(sqlite), {
        workspace: "alpha",
        principal: "d1-token:one",
        key: "gallery-create-1",
        record: retryRecord,
        response: { id: retryRecord.id, title: retryRecord.title, items: [] },
        now: new Date("2026-08-24T12:01:00Z"),
      });

      expect(first).toEqual({ status: "ok", value: firstResponse, replayed: false });
      expect(retry).toEqual({ status: "ok", value: firstResponse, replayed: true });
      expect(sqlite.db.prepare("SELECT COUNT(*) AS count FROM galleries").get()).toMatchObject({
        count: 1,
      });
    } finally {
      sqlite.close();
    }
  });

  it("bounds the replay lookup without racing the write batch", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const now = new Date("2026-08-24T12:00:00Z");
      const firstRecord = gallery("alpha", "Shots", now);
      await createGalleryIdempotently(database(sqlite), {
        workspace: "alpha",
        principal: "d1-token:one",
        key: "stalled-replay",
        record: firstRecord,
        response: { id: firstRecord.id },
        now,
      });

      const underlying = database(sqlite);
      let batchCompleted = false;
      const stalledReplayDb = {
        async batch(statements: D1PreparedStatement[]) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          const results = await underlying.batch(statements);
          batchCompleted = true;
          return results;
        },
        prepare(sql: string) {
          const statement = underlying.prepare(sql);
          if (!sql.includes("SELECT fingerprint, owner_nonce")) return statement;
          return {
            bind() {
              return this;
            },
            first: () => new Promise<never>(() => {}),
          } as unknown as D1PreparedStatement;
        },
      } as unknown as D1Database;
      const retryRecord = gallery("alpha", "Shots", new Date("2026-08-24T12:01:00Z"));

      await expect(
        createGalleryIdempotently(stalledReplayDb, {
          workspace: "alpha",
          principal: "d1-token:one",
          key: "stalled-replay",
          record: retryRecord,
          response: { id: retryRecord.id },
          readEnv: { DATA_READ_TIMEOUT_MS: "5" },
          now: new Date("2026-08-24T12:01:00Z"),
        }),
      ).rejects.toMatchObject({ code: "data_unavailable" });
      expect(batchCompleted).toBe(true);
    } finally {
      sqlite.close();
    }
  });

  it("lets concurrent callers create once and replay once", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const now = new Date("2026-08-24T12:00:00Z");
      const records = [gallery("alpha", "Shots", now), gallery("alpha", "Shots", now)];
      const results = await Promise.all(
        records.map((record) =>
          createGalleryIdempotently(database(sqlite), {
            workspace: "alpha",
            principal: "d1-token:one",
            key: "concurrent-key",
            record,
            response: { id: record.id },
            now,
          }),
        ),
      );

      expect(results.map((result) => result.status === "ok" && result.replayed).sort()).toEqual([
        false,
        true,
      ]);
      expect(sqlite.db.prepare("SELECT COUNT(*) AS count FROM galleries").get()).toMatchObject({
        count: 1,
      });
    } finally {
      sqlite.close();
    }
  });

  it("rolls back the claim when the gallery insert fails", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const now = new Date("2026-08-24T12:00:00Z");
      const record = gallery("alpha", "Shots", now);
      sqlite.db
        .prepare(
          `INSERT INTO galleries
           (id, workspace, title, description, visibility, cover_item_id, version, created_at, updated_at, deleted_at)
           VALUES (?, ?, ?, NULL, 'public', NULL, 1, ?, ?, NULL)`,
        )
        .run(record.id, record.workspace, record.title, record.created_at, record.updated_at);

      await expect(
        createGalleryIdempotently(database(sqlite), {
          workspace: "alpha",
          principal: "d1-token:one",
          key: "failing-key",
          record,
          response: { id: record.id },
          now,
        }),
      ).rejects.toThrow();
      expect(
        sqlite.db.prepare("SELECT COUNT(*) AS count FROM idempotency_requests").get(),
      ).toMatchObject({ count: 0 });
    } finally {
      sqlite.close();
    }
  });

  it("rejects reuse with a different effective request", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const now = new Date("2026-08-24T12:00:00Z");
      const first = gallery("alpha", "Shots", now);
      await createGalleryIdempotently(database(sqlite), {
        workspace: "alpha",
        principal: "session-user:one",
        key: "same-key",
        record: first,
        response: { id: first.id },
        now,
      });
      const changed = gallery("alpha", "Changed", now);
      await expect(
        createGalleryIdempotently(database(sqlite), {
          workspace: "alpha",
          principal: "session-user:one",
          key: "same-key",
          record: changed,
          response: { id: changed.id },
          now,
        }),
      ).rejects.toMatchObject({ code: "idempotency_key_reused" });
    } finally {
      sqlite.close();
    }
  });

  it("isolates the same key by principal and workspace", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const now = new Date("2026-08-24T12:00:00Z");
      for (const [workspace, principal] of [
        ["alpha", "d1-token:one"],
        ["alpha", "d1-token:two"],
        ["beta", "d1-token:one"],
      ] as const) {
        const record = gallery(workspace, "Shots", now);
        await expect(
          createGalleryIdempotently(database(sqlite), {
            workspace,
            principal,
            key: "shared-key",
            record,
            response: { id: record.id },
            now,
          }),
        ).resolves.toMatchObject({ status: "ok", replayed: false });
      }
      expect(sqlite.db.prepare("SELECT COUNT(*) AS count FROM galleries").get()).toMatchObject({
        count: 3,
      });
    } finally {
      sqlite.close();
    }
  });

  it("allows a fresh create after expiry and purges expired rows", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const start = new Date("2026-08-24T12:00:00Z");
      const first = gallery("alpha", "First", start);
      await createGalleryIdempotently(database(sqlite), {
        workspace: "alpha",
        principal: "legacy-token:one",
        key: "expiring-key",
        record: first,
        response: { id: first.id },
        now: start,
      });

      const afterExpiry = new Date("2026-08-25T12:00:01Z");
      const second = gallery("alpha", "Second", afterExpiry);
      await expect(
        createGalleryIdempotently(database(sqlite), {
          workspace: "alpha",
          principal: "legacy-token:one",
          key: "expiring-key",
          record: second,
          response: { id: second.id },
          now: afterExpiry,
        }),
      ).resolves.toMatchObject({ status: "ok", replayed: false });

      await expect(
        purgeExpiredIdempotencyRequests(database(sqlite), new Date("2026-08-26T12:00:02Z")),
      ).resolves.toEqual({ deleted: 1, truncated: false });
      expect(sqlite.db.prepare("SELECT COUNT(*) AS count FROM galleries").get()).toMatchObject({
        count: 2,
      });
    } finally {
      sqlite.close();
    }
  });

  it("rejects blank, control-character, and oversized keys", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const now = new Date("2026-08-24T12:00:00Z");
      for (const key of ["", "has space", "line\nbreak", "x".repeat(256)]) {
        const record = gallery("alpha", "Shots", now);
        await expect(
          createGalleryIdempotently(database(sqlite), {
            workspace: "alpha",
            principal: "d1-token:one",
            key,
            record,
            response: { id: record.id },
            now,
          }),
        ).rejects.toMatchObject({ code: "idempotency_key_invalid" });
      }
    } finally {
      sqlite.close();
    }
  });
});
