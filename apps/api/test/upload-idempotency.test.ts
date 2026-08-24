/// <reference types="node" />

import { ConflictError, ValidationError } from "@uploads/errors";
import { describe, expect, it, vi } from "vitest";
import {
  PENDING_TTL_MS,
  putObjectIdempotently,
  type UploadFingerprintInput,
} from "../src/upload-idempotency";
import { IDEMPOTENCY_RETENTION_HOURS } from "../src/idempotency-core";
import { database, SqliteD1 } from "./helpers/sqlite-d1";

const MIGRATIONS = ["migrations/20260824120000_idempotency_requests.sql"];

function fingerprint(overrides: Partial<UploadFingerprintInput> = {}): UploadFingerprintInput {
  return {
    finalKey: "f/abc/photo.png",
    contentSha256: "a".repeat(64),
    visibility: undefined,
    replace: false,
    metadata: undefined,
    ...overrides,
  };
}

function response(key: string) {
  return { key, url: `https://uploads.test/${key}`, embedUrl: null, size: 10 };
}

describe("upload PUT idempotency", () => {
  it("stores a completed row on fresh success and returns replayed:false", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const run = vi.fn(async () => response("f/abc/photo.png"));
      const reconcile = vi.fn(async () => null);
      const result = await putObjectIdempotently(database(sqlite), {
        workspace: "alpha",
        principal: "d1-token:one",
        key: "put-1",
        fingerprint: fingerprint(),
        run,
        reconcile,
        now: new Date("2026-08-24T12:00:00Z"),
      });
      expect(result).toEqual({ value: response("f/abc/photo.png"), replayed: false });
      expect(run).toHaveBeenCalledTimes(1);
      const row = sqlite.db
        .prepare("SELECT state, response_body FROM idempotency_requests WHERE key_hash IS NOT NULL")
        .get() as { state: string; response_body: string };
      expect(row.state).toBe("completed");
      expect(JSON.parse(row.response_body)).toEqual(response("f/abc/photo.png"));
    } finally {
      sqlite.close();
    }
  });

  it("replays the stored value on retry without calling run again", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const first = await putObjectIdempotently(database(sqlite), {
        workspace: "alpha",
        principal: "d1-token:one",
        key: "put-2",
        fingerprint: fingerprint(),
        run: async () => response("f/abc/photo.png"),
        reconcile: async () => null,
        now: new Date("2026-08-24T12:00:00Z"),
      });
      expect(first.replayed).toBe(false);

      const run = vi.fn(async () => {
        throw new Error("must not run again");
      });
      const retry = await putObjectIdempotently(database(sqlite), {
        workspace: "alpha",
        principal: "d1-token:one",
        key: "put-2",
        fingerprint: fingerprint(),
        run,
        reconcile: async () => null,
        now: new Date("2026-08-24T12:00:30Z"),
      });
      expect(retry).toEqual({ value: response("f/abc/photo.png"), replayed: true });
      expect(run).not.toHaveBeenCalled();
    } finally {
      sqlite.close();
    }
  });

  it("rejects same key with a different fingerprint", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      await putObjectIdempotently(database(sqlite), {
        workspace: "alpha",
        principal: "d1-token:one",
        key: "put-3",
        fingerprint: fingerprint(),
        run: async () => response("f/abc/photo.png"),
        reconcile: async () => null,
        now: new Date("2026-08-24T12:00:00Z"),
      });

      await expect(
        putObjectIdempotently(database(sqlite), {
          workspace: "alpha",
          principal: "d1-token:one",
          key: "put-3",
          fingerprint: fingerprint({ contentSha256: "b".repeat(64) }),
          run: async () => response("f/abc/other.png"),
          reconcile: async () => null,
          now: new Date("2026-08-24T12:00:30Z"),
        }),
      ).rejects.toMatchObject({ code: "idempotency_key_reused" });
    } finally {
      sqlite.close();
    }
  });

  it("reconciles a key_exists failure to the prior upload and completes the claim", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const reconciled = response("f/abc/photo.png");
      const run = vi.fn(async () => {
        throw new ConflictError("exists", { code: "key_exists" });
      });
      const reconcile = vi.fn(async () => reconciled);
      const result = await putObjectIdempotently(database(sqlite), {
        workspace: "alpha",
        principal: "d1-token:one",
        key: "put-4",
        fingerprint: fingerprint(),
        run,
        reconcile,
        now: new Date("2026-08-24T12:00:00Z"),
      });
      expect(result).toEqual({ value: reconciled, replayed: true });
      expect(reconcile).toHaveBeenCalledTimes(1);
      const row = sqlite.db
        .prepare("SELECT state, response_body FROM idempotency_requests")
        .get() as { state: string; response_body: string };
      expect(row.state).toBe("completed");
      expect(JSON.parse(row.response_body)).toEqual(reconciled);
    } finally {
      sqlite.close();
    }
  });

  it("rethrows key_exists and releases the claim when reconcile finds nothing", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      await expect(
        putObjectIdempotently(database(sqlite), {
          workspace: "alpha",
          principal: "d1-token:one",
          key: "put-5",
          fingerprint: fingerprint(),
          run: async () => {
            throw new ConflictError("exists", { code: "key_exists" });
          },
          reconcile: async () => null,
          now: new Date("2026-08-24T12:00:00Z"),
        }),
      ).rejects.toMatchObject({ code: "key_exists" });
      expect(
        sqlite.db.prepare("SELECT COUNT(*) AS c FROM idempotency_requests").get(),
      ).toMatchObject({ c: 0 });
    } finally {
      sqlite.close();
    }
  });

  it("releases the claim on a non-key_exists failure and lets a corrected retry succeed", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      await expect(
        putObjectIdempotently(database(sqlite), {
          workspace: "alpha",
          principal: "d1-token:one",
          key: "put-6",
          fingerprint: fingerprint(),
          run: async () => {
            throw new ValidationError("nope", { code: "empty_body" });
          },
          reconcile: async () => null,
          now: new Date("2026-08-24T12:00:00Z"),
        }),
      ).rejects.toMatchObject({ code: "empty_body" });
      expect(
        sqlite.db.prepare("SELECT COUNT(*) AS c FROM idempotency_requests").get(),
      ).toMatchObject({ c: 0 });

      const retry = await putObjectIdempotently(database(sqlite), {
        workspace: "alpha",
        principal: "d1-token:one",
        key: "put-6",
        fingerprint: fingerprint(),
        run: async () => response("f/abc/photo.png"),
        reconcile: async () => null,
        now: new Date("2026-08-24T12:00:05Z"),
      });
      expect(retry).toEqual({ value: response("f/abc/photo.png"), replayed: false });
    } finally {
      sqlite.close();
    }
  });

  it("re-claims a stale pending row past PENDING_TTL but never a live completed row", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const start = new Date("2026-08-24T12:00:00Z");

      // Establish a pending claim that never completes (simulating a crash
      // between the R2 write and the completing UPDATE), then age it past
      // PENDING_TTL directly in the table.
      const firstCall = putObjectIdempotently(database(sqlite), {
        workspace: "alpha",
        principal: "d1-token:two",
        key: "stale-key",
        fingerprint: fingerprint(),
        run: () => new Promise(() => {}), // never resolves; we abandon it below
        reconcile: async () => null,
        now: start,
      });
      // Let the claim land, then abandon the in-flight run() (simulating a crash).
      await new Promise((resolve) => setTimeout(resolve, 10));
      void firstCall;

      // Age the pending row past PENDING_TTL directly.
      sqlite.db
        .prepare(
          `UPDATE idempotency_requests SET expires_at = ?
           WHERE workspace = 'alpha' AND principal = 'd1-token:two' AND operation = 'upload.put.v1'`,
        )
        .run(new Date(start.getTime() - 1000).toISOString());

      const after = new Date(start.getTime() + PENDING_TTL_MS + 1000);
      const run = vi.fn(async () => response("f/abc/photo.png"));
      const retry = await putObjectIdempotently(database(sqlite), {
        workspace: "alpha",
        principal: "d1-token:two",
        key: "stale-key",
        fingerprint: fingerprint(),
        run,
        reconcile: async () => null,
        now: after,
      });
      expect(retry).toEqual({ value: response("f/abc/photo.png"), replayed: false });
      expect(run).toHaveBeenCalledTimes(1);

      // A completed row inside its 24h window must never be re-claimed.
      const wellWithinRetention = new Date(
        after.getTime() + PENDING_TTL_MS + 1000, // still nowhere near 24h
      );
      const shouldNotRun = vi.fn(async () => {
        throw new Error("must not re-run a completed claim");
      });
      const replay = await putObjectIdempotently(database(sqlite), {
        workspace: "alpha",
        principal: "d1-token:two",
        key: "stale-key",
        fingerprint: fingerprint(),
        run: shouldNotRun,
        reconcile: async () => null,
        now: wellWithinRetention,
      });
      expect(replay).toEqual({ value: response("f/abc/photo.png"), replayed: true });
      expect(shouldNotRun).not.toHaveBeenCalled();
      expect(wellWithinRetention.getTime() - after.getTime()).toBeLessThan(
        IDEMPOTENCY_RETENTION_HOURS * 3600e3,
      );
    } finally {
      sqlite.close();
    }
  });

  it("reports in_progress for a live pending claim owned by someone else", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      // Kick off (and never resolve) a first call so its pending claim stays live.
      const stuck = putObjectIdempotently(database(sqlite), {
        workspace: "alpha",
        principal: "d1-token:one",
        key: "in-progress-key",
        fingerprint: fingerprint(),
        run: () => new Promise(() => {}),
        reconcile: async () => null,
        now: new Date("2026-08-24T12:00:00Z"),
      });
      void stuck;
      await new Promise((resolve) => setTimeout(resolve, 10));

      await expect(
        putObjectIdempotently(database(sqlite), {
          workspace: "alpha",
          principal: "d1-token:one",
          key: "in-progress-key",
          fingerprint: fingerprint(),
          run: async () => response("f/abc/photo.png"),
          reconcile: async () => null,
          now: new Date("2026-08-24T12:00:01Z"),
        }),
      ).rejects.toMatchObject({ code: "idempotency_request_in_progress" });
    } finally {
      sqlite.close();
    }
  });

  it("isolates the same key by principal and workspace", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const now = new Date("2026-08-24T12:00:00Z");
      const scopes: [string, string][] = [
        ["alpha", "d1-token:one"],
        ["alpha", "d1-token:two"],
        ["beta", "d1-token:one"],
      ];
      for (const [workspace, principal] of scopes) {
        const result = await putObjectIdempotently(database(sqlite), {
          workspace,
          principal,
          key: "shared-key",
          fingerprint: fingerprint(),
          run: async () => response("f/abc/photo.png"),
          reconcile: async () => null,
          now,
        });
        expect(result.replayed).toBe(false);
      }
      expect(
        sqlite.db.prepare("SELECT COUNT(*) AS c FROM idempotency_requests").get(),
      ).toMatchObject({ c: 3 });
    } finally {
      sqlite.close();
    }
  });

  it("canonicalizes metadata key order so retries replay instead of conflicting", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      await putObjectIdempotently(database(sqlite), {
        workspace: "alpha",
        principal: "d1-token:one",
        key: "meta-order",
        fingerprint: fingerprint({ metadata: { b: "2", a: "1" } }),
        run: async () => response("f/abc/photo.png"),
        reconcile: async () => null,
        now: new Date("2026-08-24T12:00:00Z"),
      });

      const run = vi.fn(async () => {
        throw new Error("must not run again");
      });
      const retry = await putObjectIdempotently(database(sqlite), {
        workspace: "alpha",
        principal: "d1-token:one",
        key: "meta-order",
        fingerprint: fingerprint({ metadata: { a: "1", b: "2" } }),
        run,
        reconcile: async () => null,
        now: new Date("2026-08-24T12:00:05Z"),
      });
      expect(retry).toEqual({ value: response("f/abc/photo.png"), replayed: true });
      expect(run).not.toHaveBeenCalled();
    } finally {
      sqlite.close();
    }
  });

  it("rejects blank, control-character, and oversized keys", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      for (const key of ["", "has space", "line\nbreak", "x".repeat(256)]) {
        await expect(
          putObjectIdempotently(database(sqlite), {
            workspace: "alpha",
            principal: "d1-token:one",
            key,
            fingerprint: fingerprint(),
            run: async () => response("f/abc/photo.png"),
            reconcile: async () => null,
            now: new Date("2026-08-24T12:00:00Z"),
          }),
        ).rejects.toMatchObject({ code: "idempotency_key_invalid" });
      }
    } finally {
      sqlite.close();
    }
  });
});
