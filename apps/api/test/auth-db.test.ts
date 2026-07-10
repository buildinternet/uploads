import { describe, expect, it } from "vitest";
import {
  DEFAULT_ENROLLMENT_SECONDS,
  DEFAULT_TOKEN_SECONDS,
  createEnrollment,
  exchangeEnrollment,
  findActiveToken,
  parseScopes,
} from "../src/auth-db";

type Row = Record<string, unknown>;

class FakeStatement {
  values: unknown[] = [];

  constructor(
    readonly db: FakeD1,
    readonly sql: string,
  ) {}

  bind(...values: unknown[]): FakeStatement {
    this.values = values;
    return this;
  }

  first<T>(): Promise<T | null> {
    return Promise.resolve(this.db.first(this) as T | null);
  }

  run(): Promise<D1Result> {
    return Promise.resolve(this.db.run(this) as unknown as D1Result);
  }
}

class FakeD1 {
  enrollments: Row[] = [];
  tokens: Row[] = [];
  failBatchAt: number | null = null;

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql.replace(/\s+/g, " ").trim());
  }

  first(statement: FakeStatement): Row | null {
    const { sql, values } = statement;
    if (sql.startsWith("SELECT id, workspace, code_hash")) {
      const [hash, now] = values as string[];
      return (
        this.enrollments.find(
          (row) =>
            row.code_hash === hash && row.used_at === null && (row.expires_at as string) > now,
        ) ?? null
      );
    }
    if (sql.startsWith("SELECT id, workspace, token_hash")) {
      const [workspace, hash, now] = values as string[];
      return (
        this.tokens.find(
          (row) =>
            row.workspace === workspace &&
            row.token_hash === hash &&
            row.revoked_at === null &&
            (row.expires_at === null || (row.expires_at as string) > now),
        ) ?? null
      );
    }
    throw new Error(`unsupported first: ${sql}`);
  }

  run(statement: FakeStatement): { meta: { changes: number }; success: true; results: never[] } {
    const { sql, values } = statement;
    if (sql.startsWith("INSERT INTO auth_enrollments")) {
      const [id, workspace, codeHash, label, scopes, createdAt, expiresAt, tokenExpiresAt] = values;
      this.enrollments.push({
        id,
        workspace,
        code_hash: codeHash,
        label,
        scopes,
        created_at: createdAt,
        expires_at: expiresAt,
        token_expires_at: tokenExpiresAt,
        used_at: null,
      });
      return result(1);
    }
    if (sql.startsWith("INSERT INTO auth_tokens") && sql.includes("SELECT ?")) {
      const [id, tokenHash, createdAt, enrollmentId, codeHash, now] = values;
      const enrollment = this.enrollments.find(
        (row) =>
          row.id === enrollmentId &&
          row.code_hash === codeHash &&
          row.used_at === null &&
          (row.expires_at as string) > (now as string),
      );
      if (!enrollment) return result(0);
      this.tokens.push({
        id,
        workspace: enrollment.workspace,
        token_hash: tokenHash,
        label: enrollment.label,
        scopes: enrollment.scopes,
        created_at: createdAt,
        expires_at: enrollment.token_expires_at,
        revoked_at: null,
      });
      return result(1);
    }
    if (sql.startsWith("UPDATE auth_enrollments SET used_at")) {
      const [usedAt, enrollmentId, codeHash, now] = values;
      const enrollment = this.enrollments.find(
        (row) =>
          row.id === enrollmentId &&
          row.code_hash === codeHash &&
          row.used_at === null &&
          (row.expires_at as string) > (now as string),
      );
      if (!enrollment) return result(0);
      enrollment.used_at = usedAt;
      return result(1);
    }
    throw new Error(`unsupported run: ${sql}`);
  }

  async batch(statements: FakeStatement[]): Promise<D1Result[]> {
    const enrollmentSnapshot = structuredClone(this.enrollments);
    const tokenSnapshot = structuredClone(this.tokens);
    try {
      return statements.map((statement, index) => {
        if (this.failBatchAt === index) throw new Error("injected batch failure");
        return this.run(statement) as unknown as D1Result;
      });
    } catch (error) {
      this.enrollments = enrollmentSnapshot;
      this.tokens = tokenSnapshot;
      throw error;
    }
  }
}

function result(changes: number) {
  return { meta: { changes }, success: true as const, results: [] as never[] };
}

function database(fake: FakeD1): D1Database {
  return fake as unknown as D1Database;
}

describe("D1 enrollment exchange", () => {
  it("stores only a hash and applies the 10 minute / 90 day defaults", async () => {
    const fake = new FakeD1();
    const now = new Date("2026-07-10T12:00:00.000Z");
    const enrollment = await createEnrollment(database(fake), {
      workspace: "default",
      scopes: ["files:read", "files:write"],
      now,
    });

    expect(enrollment.code).toMatch(/^upe_/);
    expect(JSON.stringify(fake.enrollments)).not.toContain(enrollment.code);
    expect(Date.parse(enrollment.expiresAt) - now.getTime()).toBe(
      DEFAULT_ENROLLMENT_SECONDS * 1000,
    );
    expect(Date.parse(enrollment.tokenExpiresAt) - now.getTime()).toBe(
      DEFAULT_TOKEN_SECONDS * 1000,
    );
  });

  it("atomically exchanges once and creates a scoped, expiring token", async () => {
    const fake = new FakeD1();
    const now = new Date("2026-07-10T12:00:00.000Z");
    const enrollment = await createEnrollment(database(fake), {
      workspace: "default",
      label: "codex",
      scopes: ["files:read", "files:write"],
      now,
    });

    const [first, replay] = await Promise.all([
      exchangeEnrollment(database(fake), enrollment.code, now),
      exchangeEnrollment(database(fake), enrollment.code, now),
    ]);
    const successes = [first, replay].filter((value) => value !== null);
    expect(successes).toHaveLength(1);
    expect(fake.tokens).toHaveLength(1);
    expect(JSON.stringify(fake.tokens)).not.toContain(successes[0]?.token);
    expect(successes[0]?.scopes).toEqual(["files:read", "files:write"]);

    const active = await findActiveToken(database(fake), "default", successes[0]?.token ?? "", now);
    expect(parseScopes(active?.scopes ?? "[]")).toEqual(["files:read", "files:write"]);
  });

  it("rolls back consumption when the transactional batch fails", async () => {
    const fake = new FakeD1();
    const now = new Date("2026-07-10T12:00:00.000Z");
    const enrollment = await createEnrollment(database(fake), {
      workspace: "default",
      scopes: ["files:read", "files:write"],
      now,
    });
    fake.failBatchAt = 1;

    await expect(exchangeEnrollment(database(fake), enrollment.code, now)).rejects.toThrow(
      "injected batch failure",
    );
    expect(fake.enrollments[0].used_at).toBeNull();
    expect(fake.tokens).toHaveLength(0);

    fake.failBatchAt = null;
    await expect(exchangeEnrollment(database(fake), enrollment.code, now)).resolves.not.toBeNull();
  });

  it("rejects expired and unknown codes identically", async () => {
    const fake = new FakeD1();
    const now = new Date("2026-07-10T12:00:00.000Z");
    const enrollment = await createEnrollment(database(fake), {
      workspace: "default",
      scopes: ["files:read", "files:write"],
      enrollmentSeconds: 60,
      now,
    });
    const later = new Date(now.getTime() + 61_000);

    expect(await exchangeEnrollment(database(fake), enrollment.code, later)).toBeNull();
    expect(await exchangeEnrollment(database(fake), "upe_unknown", later)).toBeNull();
  });
});
