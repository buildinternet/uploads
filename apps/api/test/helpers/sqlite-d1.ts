/// <reference types="node" />

/**
 * Shared node:sqlite-backed fake D1, parameterized by the migration file(s)
 * to apply on construction. Used by suites (file-metadata-sqlite.test.ts,
 * galleries-sqlite.test.ts) that need real SQL semantics — foreign keys,
 * uniqueness, GROUP BY/HAVING, transactions — rather than a hand-rolled map.
 */

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

type SqliteValue = string | number | bigint | null | Uint8Array;

export class SqliteStatement {
  private values: SqliteValue[] = [];

  constructor(
    readonly owner: SqliteD1,
    readonly sql: string,
  ) {}

  bind(...values: unknown[]) {
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
    for (const path of paths) this.db.exec(readFileSync(path, "utf8"));
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
}

export function database(sqlite: SqliteD1): D1Database {
  return sqlite as unknown as D1Database;
}
