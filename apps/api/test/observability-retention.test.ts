/// <reference types="node" />

import { describe, expect, it } from "vitest";
import {
  ENROLLMENT_RETENTION_DAYS,
  OBSERVABILITY_RETENTION_BATCH_SIZE,
  OBSERVABILITY_RETENTION_MAX_BATCHES,
  runObservabilityRetention,
  TELEMETRY_RETENTION_DAYS,
} from "../src/observability-retention";
import { SqliteD1, database } from "./helpers/sqlite-d1";

const MIGRATIONS = [
  "migrations/20260710120000_auth.sql",
  "migrations/20260711120000_invite_pages.sql",
  "migrations/20260715120000_uploads_cli_observability.sql",
  "migrations/20260722180100_auth_enrollments_expires_at_idx.sql",
  "migrations/20260827160000_auth_enrollments_kind.sql",
  "migrations/20260827170000_auth_enrollments_multi_use.sql",
];

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function env(db: D1Database): Env {
  return { DB: db } as unknown as Env;
}

function insertTelemetry(
  sqlite: SqliteD1,
  row: { id: string; timestamp: number; command?: string },
) {
  sqlite.db
    .prepare(
      `INSERT INTO uploads_telemetry_events (
        id, anon_id, timestamp, surface, client_kind, command, cli_version
      ) VALUES (?, ?, ?, 'cli', 'external', ?, '0.10.0')`,
    )
    .run(row.id, "11111111-2222-3333-4444-555555555555", row.timestamp, row.command ?? "put");
}

function insertEnrollment(
  sqlite: SqliteD1,
  row: {
    id: string;
    expiresAt: string | null;
    usedAt?: string | null;
    codeHash?: string;
    kind?: "token" | "member";
    maxUses?: number | null;
    useCount?: number;
  },
) {
  sqlite.db
    .prepare(
      `INSERT INTO auth_enrollments (
        id, workspace, code_hash, label, scopes, created_at, expires_at, token_expires_at, used_at,
        kind, max_uses, use_count
      ) VALUES (?, 'default', ?, NULL, '["files:write"]', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.codeHash ?? `hash_${row.id}`,
      row.expiresAt ?? new Date().toISOString(),
      row.expiresAt,
      row.expiresAt ?? new Date().toISOString(),
      row.usedAt ?? null,
      row.kind ?? "token",
      row.maxUses ?? null,
      row.useCount ?? 0,
    );
}

describe("runObservabilityRetention", () => {
  it("returns zeros when DB is missing", async () => {
    const result = await runObservabilityRetention({} as Env);
    expect(result).toEqual({
      telemetryDeleted: 0,
      enrollmentsDeleted: 0,
      telemetryTruncated: false,
      enrollmentsTruncated: false,
    });
  });

  it("deletes old telemetry and keeps recent rows", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const now = new Date("2026-07-22T12:00:00.000Z");
      const oldTs = now.getTime() - (TELEMETRY_RETENTION_DAYS + 10) * MS_PER_DAY;
      const freshTs = now.getTime() - 2 * MS_PER_DAY;

      insertTelemetry(sqlite, { id: "tel_old", timestamp: oldTs });
      insertTelemetry(sqlite, { id: "tel_fresh", timestamp: freshTs });

      const result = await runObservabilityRetention(env(database(sqlite)), now);
      expect(result.telemetryDeleted).toBe(1);
      expect(result.telemetryTruncated).toBe(false);

      const remaining = sqlite.db
        .prepare("SELECT id FROM uploads_telemetry_events ORDER BY id")
        .all() as Array<{ id: string }>;
      expect(remaining.map((r) => r.id)).toEqual(["tel_fresh"]);
    } finally {
      sqlite.close();
    }
  });

  it("deletes used/expired enrollments past the window and keeps live unused ones", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const now = new Date("2026-07-22T12:00:00.000Z");
      const past = new Date(
        now.getTime() - (ENROLLMENT_RETENTION_DAYS + 2) * MS_PER_DAY,
      ).toISOString();
      const recentUsed = new Date(now.getTime() - 1 * MS_PER_DAY).toISOString();
      const liveExpires = new Date(now.getTime() + 2 * MS_PER_DAY).toISOString();

      insertEnrollment(sqlite, {
        id: "enr_used_old",
        expiresAt: past,
        usedAt: past,
      });
      insertEnrollment(sqlite, {
        id: "enr_expired_old",
        expiresAt: past,
        usedAt: null,
      });
      insertEnrollment(sqlite, {
        id: "enr_used_recent",
        expiresAt: liveExpires,
        usedAt: recentUsed,
      });
      insertEnrollment(sqlite, {
        id: "enr_live_unused",
        expiresAt: liveExpires,
        usedAt: null,
      });

      const result = await runObservabilityRetention(env(database(sqlite)), now);
      expect(result.enrollmentsDeleted).toBe(2);
      expect(result.enrollmentsTruncated).toBe(false);

      const remaining = sqlite.db
        .prepare("SELECT id FROM auth_enrollments ORDER BY id")
        .all() as Array<{ id: string }>;
      expect(remaining.map((r) => r.id)).toEqual(["enr_live_unused", "enr_used_recent"]);
    } finally {
      sqlite.close();
    }
  });

  // Issue #876: `kind: 'member'` rows never set `used_at`, so a fully
  // redeemed but still-live multi-use link, and a standing non-expiring
  // link, must both survive the purge — the sweep only bases its DELETE on
  // `expires_at`/`used_at`, and `expires_at IS NULL` never satisfies
  // `expires_at < cutoff`.
  it("never purges a live non-expiring or still-under-cap member link", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const now = new Date("2026-07-22T12:00:00.000Z");
      const past = new Date(
        now.getTime() - (ENROLLMENT_RETENTION_DAYS + 2) * MS_PER_DAY,
      ).toISOString();
      const liveExpires = new Date(now.getTime() + 2 * MS_PER_DAY).toISOString();

      insertEnrollment(sqlite, {
        id: "enr_member_never_expires",
        expiresAt: null,
        kind: "member",
        maxUses: null,
        useCount: 5,
      });
      insertEnrollment(sqlite, {
        id: "enr_member_exhausted_but_live",
        expiresAt: liveExpires,
        kind: "member",
        maxUses: 3,
        useCount: 3,
      });
      // Sanity control: an old, expired token-kind row still purges.
      insertEnrollment(sqlite, {
        id: "enr_token_expired_old",
        expiresAt: past,
        usedAt: null,
      });

      const result = await runObservabilityRetention(env(database(sqlite)), now);
      expect(result.enrollmentsDeleted).toBe(1);

      const remaining = sqlite.db
        .prepare("SELECT id FROM auth_enrollments ORDER BY id")
        .all() as Array<{ id: string }>;
      expect(remaining.map((r) => r.id)).toEqual([
        "enr_member_exhausted_but_live",
        "enr_member_never_expires",
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("purges more than one batch of old telemetry", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const now = new Date("2026-07-22T12:00:00.000Z");
      const oldTs = now.getTime() - (TELEMETRY_RETENTION_DAYS + 5) * MS_PER_DAY;
      const count = OBSERVABILITY_RETENTION_BATCH_SIZE + 50;

      for (let i = 0; i < count; i++) {
        insertTelemetry(sqlite, { id: `tel_batch_${i}`, timestamp: oldTs });
      }
      insertTelemetry(sqlite, {
        id: "tel_keep",
        timestamp: now.getTime() - MS_PER_DAY,
      });

      const result = await runObservabilityRetention(env(database(sqlite)), now);
      expect(result.telemetryDeleted).toBe(count);
      expect(result.telemetryTruncated).toBe(false);

      const remaining = sqlite.db
        .prepare("SELECT id FROM uploads_telemetry_events")
        .all() as Array<{ id: string }>;
      expect(remaining).toEqual([{ id: "tel_keep" }]);
    } finally {
      sqlite.close();
    }
  });

  it("caps telemetry deletes at MAX_BATCHES and reports truncation", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const now = new Date("2026-07-22T12:00:00.000Z");
      const oldTs = now.getTime() - (TELEMETRY_RETENTION_DAYS + 5) * MS_PER_DAY;
      const cap = OBSERVABILITY_RETENTION_BATCH_SIZE * OBSERVABILITY_RETENTION_MAX_BATCHES;
      const total = cap + 1;

      const insert = sqlite.db.prepare(
        `INSERT INTO uploads_telemetry_events (
          id, anon_id, timestamp, surface, client_kind, command, cli_version
        ) VALUES (?, '11111111-2222-3333-4444-555555555555', ?, 'cli', 'external', 'put', '0.10.0')`,
      );
      for (let i = 0; i < total; i++) {
        insert.run(`tel_cap_${i}`, oldTs);
      }

      const result = await runObservabilityRetention(env(database(sqlite)), now);
      expect(result.telemetryDeleted).toBe(cap);
      expect(result.telemetryTruncated).toBe(true);

      const left = (
        sqlite.db.prepare("SELECT COUNT(*) AS n FROM uploads_telemetry_events").get() as {
          n: number;
        }
      ).n;
      expect(left).toBe(1);
    } finally {
      sqlite.close();
    }
  });

  it("exact daily cap is not reported as truncated", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const now = new Date("2026-07-22T12:00:00.000Z");
      const oldTs = now.getTime() - (TELEMETRY_RETENTION_DAYS + 5) * MS_PER_DAY;
      // Exactly MAX_BATCHES full pages — +1 lookahead must not invent leftovers.
      const exactCap = OBSERVABILITY_RETENTION_BATCH_SIZE * OBSERVABILITY_RETENTION_MAX_BATCHES;

      const insert = sqlite.db.prepare(
        `INSERT INTO uploads_telemetry_events (
          id, anon_id, timestamp, surface, client_kind, command, cli_version
        ) VALUES (?, '11111111-2222-3333-4444-555555555555', ?, 'cli', 'external', 'put', '0.10.0')`,
      );
      for (let i = 0; i < exactCap; i++) {
        insert.run(`tel_exact_${i}`, oldTs);
      }

      const result = await runObservabilityRetention(env(database(sqlite)), now);
      expect(result.telemetryDeleted).toBe(exactCap);
      expect(result.telemetryTruncated).toBe(false);

      const left = (
        sqlite.db.prepare("SELECT COUNT(*) AS n FROM uploads_telemetry_events").get() as {
          n: number;
        }
      ).n;
      expect(left).toBe(0);
    } finally {
      sqlite.close();
    }
  });
});
