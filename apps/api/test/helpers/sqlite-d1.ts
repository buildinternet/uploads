/// <reference types="node" />

/**
 * Shared node:sqlite-backed fake D1, parameterized by the migration file(s)
 * to apply on construction. Used by suites (file-metadata-sqlite.test.ts,
 * galleries-sqlite.test.ts) that need real SQL semantics — foreign keys,
 * uniqueness, GROUP BY/HAVING, transactions — rather than a hand-rolled map.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, URL as NodeURL } from "node:url";

// Resolve migration paths against apps/api rather than process.cwd(), so the
// helper works under both per-package vitest (cwd = apps/api) and the unified
// root runner (cwd = repo root). Absolute paths pass through resolve() unchanged.
const API_ROOT = fileURLToPath(new NodeURL("../../", import.meta.url));

type SqliteValue = string | number | bigint | null | Uint8Array;

/** D1's hard cap on bound parameters per query, enforced by `bind()` below. */
export const D1_MAX_BOUND_PARAMS = 100;

export class SqliteStatement {
  private values: SqliteValue[] = [];

  constructor(
    readonly owner: SqliteD1,
    readonly sql: string,
  ) {}

  bind(...values: unknown[]) {
    // node:sqlite allows 32k bound parameters; D1 allows 100 and rejects the
    // query with "too many SQL variables". Without this the fake happily runs
    // statements that 500 in production (issue: the screenshots by-path route).
    if (values.length > D1_MAX_BOUND_PARAMS) {
      throw new Error(`D1_ERROR: too many SQL variables at offset ${values.length}: SQLITE_ERROR`);
    }
    this.values = values as SqliteValue[];
    return this;
  }

  async first<T>(): Promise<T | null> {
    return (this.owner.db.prepare(this.sql).get(...this.values) as T | undefined) ?? null;
  }

  async all<T>(): Promise<D1Result<T>> {
    return {
      success: true,
      results: this.owner.db.prepare(this.sql).all(...this.values) as T[],
      meta: {},
    } as D1Result<T>;
  }

  async run(): Promise<D1Result> {
    return this.runSync() as unknown as D1Result;
  }

  runSync() {
    // SELECTs need `.all()` — `.run()` executes them but never returns rows.
    // Mutations use `.run()` so callers (e.g. inside `db.batch()`) can still
    // read `meta.changes`. This is a simple, readable heuristic, not a SQL
    // parser: strip leading `--` line comments and whitespace, then also
    // match a leading `WITH` so `WITH ... SELECT` CTEs are recognized as
    // row-returning too — both used to fall through to `.run()`, which
    // silently discards their rows.
    const withoutLeadingComments = this.sql.replace(/^(\s*--[^\n]*\n)*\s*/, "");
    if (/^(SELECT|WITH)\b/i.test(withoutLeadingComments)) {
      return {
        success: true,
        results: this.owner.db.prepare(this.sql).all(...this.values),
        meta: {},
      };
    }
    const result = this.owner.db.prepare(this.sql).run(...this.values);
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    };
  }
}

export class SqliteD1 {
  readonly db = new DatabaseSync(":memory:");

  /**
   * @param migrationPaths One or more migration file paths (relative to
   *   apps/api), applied in order.
   * @param pragmas Optional PRAGMA statements to run before the migrations
   *   (e.g. `["PRAGMA foreign_keys = ON"]`).
   */
  constructor(migrationPaths: string | string[], pragmas: string[] = []) {
    for (const pragma of pragmas) this.db.exec(pragma);
    const paths = Array.isArray(migrationPaths) ? migrationPaths : [migrationPaths];
    for (const path of paths) this.db.exec(readFileSync(resolve(API_ROOT, path), "utf8"));
  }

  prepare(sql: string) {
    return new SqliteStatement(this, sql);
  }

  async batch(statements: SqliteStatement[]): Promise<D1Result[]> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.runSync() as unknown as D1Result);
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.db.close();
  }

  /** D1 Sessions API stub (see src/db-session.ts) — this fake has no
   *  primary/replica split, so a "session" is just itself. */
  withSession() {
    return this;
  }
}

export function database(sqlite: SqliteD1): D1Database {
  return sqlite as unknown as D1Database;
}
