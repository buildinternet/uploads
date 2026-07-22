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
    expiresAt: string;
    usedAt?: string | null;
    codeHash?: string;
  },
) {
  sqlite.db
    .prepare(
      `INSERT INTO auth_enrollments (
        id, workspace, code_hash, label, scopes, created_at, expires_at, token_expires_at, used_at
      ) VALUES (?, 'default', ?, NULL, '["files:write"]', ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.codeHash ?? `hash_${row.id}`,
      row.expiresAt,
      row.expiresAt,
      row.expiresAt,
      row.usedAt ?? null,
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
});
