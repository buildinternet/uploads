/// <reference types="node" />

import { describe, expect, it } from "vitest";
import { ServiceUnavailableError, ValidationError } from "@uploads/errors";
import { buildTokenRecord } from "../src/auth-db";
import { createTokenIdempotently } from "../src/token-idempotency";
import { secretsKeyRingFromEnv } from "../src/secrets";
import { SqliteD1, database } from "./helpers/sqlite-d1";

const MIGRATIONS = [
  "migrations/20260710120000_auth.sql",
  "migrations/20260712230000_token_minting_user.sql",
  "migrations/20260817180000_token_last_used.sql",
  "migrations/20260824120000_idempotency_requests.sql",
];

const KEY = "0123456789abcdef0123456789abcdef"; // >= 16 chars
const RING = secretsKeyRingFromEnv({ WORKSPACE_SECRETS_KEY: KEY });

async function mintInput(
  workspace: string,
  opts: { scopes?: string[]; label?: string | null; ttlSeconds?: number | null } = {},
) {
  const scopes = (opts.scopes ?? ["files:read", "files:write"]) as ("files:read" | "files:write")[];
  const ttlSeconds = opts.ttlSeconds ?? 3600;
  const { record } = await buildTokenRecord({
    workspace,
    label: opts.label ?? undefined,
    scopes,
    expiresAt: ttlSeconds === null ? undefined : new Date("2026-08-24T13:00:00Z"),
    mintedByUserId: "u-1",
  });
  const response = {
    token: `up_${workspace}_` + record.id,
    workspace,
    scopes,
    label: record.label,
    expiresAt: record.expires_at,
  };
  return {
    record,
    response,
    fingerprint: { scopes, label: record.label, ttlSeconds } as const,
  };
}

function countTokens(sqlite: SqliteD1): number {
  const row = sqlite.db.prepare("SELECT COUNT(*) AS c FROM auth_tokens").get() as { c: number };
  return row.c;
}

describe("token creation idempotency", () => {
  it("replays the exact original plaintext token and mints one row", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const now = new Date("2026-08-24T12:00:00Z");
      const first = await mintInput("alpha");
      const firstResult = await createTokenIdempotently(database(sqlite), {
        workspace: "alpha",
        principal: "u-1",
        key: "mint-1",
        record: first.record,
        fingerprint: first.fingerprint,
        response: first.response,
        masterSecret: KEY,
        ring: RING,
        now,
      });

      // A retry supplies a fresh token/record (client re-generates), same key.
      const retry = await mintInput("alpha");
      const retryResult = await createTokenIdempotently(database(sqlite), {
        workspace: "alpha",
        principal: "u-1",
        key: "mint-1",
        record: retry.record,
        fingerprint: retry.fingerprint,
        response: retry.response,
        masterSecret: KEY,
        ring: RING,
        now: new Date("2026-08-24T12:00:05Z"),
      });

      expect(firstResult).toEqual({ value: first.response, replayed: false });
      expect(retryResult.replayed).toBe(true);
      expect(retryResult.value).toEqual(first.response);
      // The retry's freshly-minted token is discarded; the original replays.
      expect(retryResult.value.token).toBe(first.response.token);
      expect(retryResult.value.token).not.toBe(retry.response.token);
      expect(countTokens(sqlite)).toBe(1);
    } finally {
      sqlite.close();
    }
  });

  it("never stores the plaintext token in the replay row", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const first = await mintInput("alpha");
      await createTokenIdempotently(database(sqlite), {
        workspace: "alpha",
        principal: "u-1",
        key: "mint-secret",
        record: first.record,
        fingerprint: first.fingerprint,
        response: first.response,
        masterSecret: KEY,
        ring: RING,
      });
      const row = sqlite.db.prepare("SELECT response_body FROM idempotency_requests").get() as {
        response_body: string;
      };
      expect(row.response_body.startsWith("enc:v1:")).toBe(true);
      expect(row.response_body).not.toContain(first.response.token);
    } finally {
      sqlite.close();
    }
  });

  it("conflicts when the same key is reused with a changed request", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const first = await mintInput("alpha", { scopes: ["files:read"] });
      await createTokenIdempotently(database(sqlite), {
        workspace: "alpha",
        principal: "u-1",
        key: "mint-2",
        record: first.record,
        fingerprint: first.fingerprint,
        response: first.response,
        masterSecret: KEY,
        ring: RING,
      });
      const changed = await mintInput("alpha", { scopes: ["files:read", "files:write"] });
      await expect(
        createTokenIdempotently(database(sqlite), {
          workspace: "alpha",
          principal: "u-1",
          key: "mint-2",
          record: changed.record,
          fingerprint: changed.fingerprint,
          response: changed.response,
          masterSecret: KEY,
          ring: RING,
        }),
      ).rejects.toMatchObject({ code: "idempotency_key_reused" });
      expect(countTokens(sqlite)).toBe(1);
    } finally {
      sqlite.close();
    }
  });

  it("isolates replay records by principal and by workspace", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const a = await mintInput("alpha");
      const b = await mintInput("alpha");
      const c = await mintInput("beta");
      const ra = await createTokenIdempotently(database(sqlite), {
        workspace: "alpha",
        principal: "u-1",
        key: "shared",
        record: a.record,
        fingerprint: a.fingerprint,
        response: a.response,
        masterSecret: KEY,
        ring: RING,
      });
      // Same key, different user → its own mint, not u-1's replay.
      const rb = await createTokenIdempotently(database(sqlite), {
        workspace: "alpha",
        principal: "u-2",
        key: "shared",
        record: b.record,
        fingerprint: b.fingerprint,
        response: b.response,
        masterSecret: KEY,
        ring: RING,
      });
      // Same key, same user, different workspace → its own mint.
      const rc = await createTokenIdempotently(database(sqlite), {
        workspace: "beta",
        principal: "u-1",
        key: "shared",
        record: c.record,
        fingerprint: c.fingerprint,
        response: c.response,
        masterSecret: KEY,
        ring: RING,
      });
      expect(ra.replayed).toBe(false);
      expect(rb.replayed).toBe(false);
      expect(rc.replayed).toBe(false);
      expect(rb.value.token).not.toBe(ra.value.token);
      expect(rc.value.token).not.toBe(ra.value.token);
      expect(countTokens(sqlite)).toBe(3);
    } finally {
      sqlite.close();
    }
  });

  it("fails closed with no encryption key: no token, no replay row", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const first = await mintInput("alpha");
      await expect(
        createTokenIdempotently(database(sqlite), {
          workspace: "alpha",
          principal: "u-1",
          key: "mint-nokey",
          record: first.record,
          fingerprint: first.fingerprint,
          response: first.response,
          masterSecret: undefined,
          ring: {},
        }),
      ).rejects.toBeInstanceOf(ServiceUnavailableError);
      expect(countTokens(sqlite)).toBe(0);
      const rows = sqlite.db.prepare("SELECT COUNT(*) AS c FROM idempotency_requests").get() as {
        c: number;
      };
      expect(rows.c).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  it("rejects an invalid Idempotency-Key before any write", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const first = await mintInput("alpha");
      await expect(
        createTokenIdempotently(database(sqlite), {
          workspace: "alpha",
          principal: "u-1",
          key: "bad key with space",
          record: first.record,
          fingerprint: first.fingerprint,
          response: first.response,
          masterSecret: KEY,
          ring: RING,
        }),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(countTokens(sqlite)).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  it("lets an expired key be reused for a new mint", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const first = await mintInput("alpha");
      const r1 = await createTokenIdempotently(database(sqlite), {
        workspace: "alpha",
        principal: "u-1",
        key: "mint-exp",
        record: first.record,
        fingerprint: first.fingerprint,
        response: first.response,
        masterSecret: KEY,
        ring: RING,
        now: new Date("2026-08-24T12:00:00Z"),
      });
      // 25h later the first claim has expired; the same key starts fresh.
      const second = await mintInput("alpha");
      const r2 = await createTokenIdempotently(database(sqlite), {
        workspace: "alpha",
        principal: "u-1",
        key: "mint-exp",
        record: second.record,
        fingerprint: second.fingerprint,
        response: second.response,
        masterSecret: KEY,
        ring: RING,
        now: new Date("2026-08-25T13:00:00Z"),
      });
      expect(r1.replayed).toBe(false);
      expect(r2.replayed).toBe(false);
      expect(r2.value.token).not.toBe(r1.value.token);
      expect(countTokens(sqlite)).toBe(2);
    } finally {
      sqlite.close();
    }
  });

  it("replays after the encryption key rotates (previous key still decrypts)", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const oldKey = "old-master-key-0123456789";
      const newKey = "new-master-key-9876543210";
      const first = await mintInput("alpha");
      await createTokenIdempotently(database(sqlite), {
        workspace: "alpha",
        principal: "u-1",
        key: "mint-rotate",
        record: first.record,
        fingerprint: first.fingerprint,
        response: first.response,
        masterSecret: oldKey,
        ring: { current: oldKey },
      });
      const retry = await mintInput("alpha");
      const result = await createTokenIdempotently(database(sqlite), {
        workspace: "alpha",
        principal: "u-1",
        key: "mint-rotate",
        record: retry.record,
        fingerprint: retry.fingerprint,
        response: retry.response,
        masterSecret: newKey,
        ring: { current: newKey, previous: oldKey },
      });
      expect(result.replayed).toBe(true);
      expect(result.value.token).toBe(first.response.token);
    } finally {
      sqlite.close();
    }
  });

  it("bounds the replay lookup without racing the write batch", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const first = await mintInput("alpha");
      await createTokenIdempotently(database(sqlite), {
        workspace: "alpha",
        principal: "u-1",
        key: "stalled",
        record: first.record,
        fingerprint: first.fingerprint,
        response: first.response,
        masterSecret: KEY,
        ring: RING,
      });

      const underlying = database(sqlite);
      let batchCompleted = false;
      const stalledDb = {
        async batch(statements: D1PreparedStatement[]) {
          const results = await underlying.batch(statements);
          batchCompleted = true;
          return results;
        },
        prepare(sql: string) {
          const stmt = underlying.prepare(sql);
          if (sql.includes("SELECT fingerprint")) {
            return {
              bind: (...v: unknown[]) => {
                stmt.bind(...v);
                return { first: () => new Promise(() => {}) };
              },
            } as unknown as D1PreparedStatement;
          }
          return stmt;
        },
      } as unknown as Parameters<typeof createTokenIdempotently>[0];

      const retry = await mintInput("alpha");
      await expect(
        createTokenIdempotently(stalledDb, {
          workspace: "alpha",
          principal: "u-1",
          key: "stalled",
          record: retry.record,
          fingerprint: retry.fingerprint,
          response: retry.response,
          masterSecret: KEY,
          ring: RING,
          readEnv: { DATA_READ_TIMEOUT_MS: "20" },
        }),
      ).rejects.toMatchObject({ code: "data_unavailable" });
      expect(batchCompleted).toBe(true);
    } finally {
      sqlite.close();
    }
  });
});
