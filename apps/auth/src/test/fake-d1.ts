/**
 * In-memory D1 test harness (node:sqlite-backed) — see the follow-up flagged
 * in internal-routes.test.ts. Implements just enough of the `D1Database`
 * surface that drizzle-orm's D1 driver (`drizzle-orm/d1/session.cjs`) and
 * Better Auth's `drizzleAdapter` issue: `prepare().bind().run()/.all()`,
 * `.raw()` (used when a query has field selectors — see `SQLiteD1Session`'s
 * `values()` path), and `client.batch(...)`.
 *
 * Schema is loaded by applying the real `apps/api/migrations/*.sql` files in
 * order (issue #754: apps/auth's dedicated D1 folds into the main one, so
 * that is now the single source of truth for this worker's tables too) —
 * drift between `src/schema.ts` and the migrations is caught by tests
 * instead of only at `wrangler d1 migrations apply` time. Those files also
 * create apps/api's own tables, which is harmless here — no table/index name
 * collides (see .context/754-auth-d1-merge-plan.md) and this worker's tests
 * never touch them.
 *
 * `apps/auth/migrations/*.sql` still exists and still drives the OLD
 * dedicated auth D1 in production until the item-1 cutover lands; it is
 * intentionally no longer the source this harness reads from, since new auth
 * schema changes should land in apps/api/migrations going forward.
 *
 * Deliberately NOT a full D1 emulator: no `.dump()`, no `sessions`/bookmark
 * API, and `meta` fields are minimal stubs. Good enough for drizzle+Better
 * Auth's query patterns against this worker's tables.
 */
/// <reference types="node" />
// Test-only file (never bundled into the Worker): pulls in Node's global
// types locally via the reference above rather than adding "node" to the
// worker-wide tsconfig, since this repo deliberately keeps Workers-runtime
// source free of Node ambient globals.
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "api", "migrations");

function applyMigrations(db: DatabaseSync): void {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f: string) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    db.exec(sql);
  }
}

type D1Meta = {
  duration: number;
  size_after: number;
  rows_read: number;
  rows_written: number;
  last_row_id: number;
  changed_db: boolean;
  changes: number;
};

function emptyMeta(): D1Meta {
  return {
    duration: 0,
    size_after: 0,
    rows_read: 0,
    rows_written: 0,
    last_row_id: 0,
    changed_db: false,
    changes: 0,
  };
}

/** Rows as returned by node:sqlite's `.all()` — plain objects, one per row. */
type Row = Record<string, unknown>;

class FakeBoundStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly params: unknown[],
  ) {}

  private stmt(): StatementSync {
    return this.db.prepare(this.sql);
  }

  async run(): Promise<{ success: true; results: []; meta: D1Meta }> {
    const stmt = this.stmt();
    const info = stmt.run(...(this.params as never[]));
    return {
      success: true,
      results: [],
      meta: {
        duration: 0,
        size_after: 0,
        rows_read: 0,
        rows_written: Number(info.changes ?? 0),
        last_row_id: Number(info.lastInsertRowid ?? 0),
        changed_db: Number(info.changes ?? 0) > 0,
        changes: Number(info.changes ?? 0),
      },
    };
  }

  async all<T = Row>(): Promise<{ success: true; results: T[]; meta: D1Meta }> {
    const stmt = this.stmt();
    const rows = stmt.all(...(this.params as never[])) as T[];
    return { success: true, results: rows, meta: emptyMeta() };
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    const stmt = this.stmt();
    const rows = stmt.all(...(this.params as never[])) as Row[];
    return rows.map((row) => Object.values(row)) as T[];
  }

  async first<T = Row>(column?: string): Promise<T | null> {
    const { results } = await this.all<Row>();
    const row = results[0];
    if (!row) return null;
    if (column) return (row[column] as T) ?? null;
    return row as T;
  }
}

class FakePreparedStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
  ) {}

  bind(...params: unknown[]): FakeBoundStatement {
    return new FakeBoundStatement(this.db, this.sql, params);
  }

  // Drizzle's D1 batch path binds with zero params directly against the
  // prepared statement when a query has none — support calling the
  // bound-statement methods with no `.bind()` call too.
  run() {
    return new FakeBoundStatement(this.db, this.sql, []).run();
  }
  all() {
    return new FakeBoundStatement(this.db, this.sql, []).all();
  }
  raw() {
    return new FakeBoundStatement(this.db, this.sql, []).raw();
  }
  first(column?: string) {
    return new FakeBoundStatement(this.db, this.sql, []).first(column);
  }
}

export type FakeD1Database = D1Database & {
  /** Test-only escape hatch to run raw SQL/assertions outside drizzle. */
  __sqlite: DatabaseSync;
};

/**
 * Create a fresh in-memory D1-shaped database with the real migrations
 * applied. Each call gets an isolated `DatabaseSync(":memory:")` — tests
 * should call this in `beforeEach` rather than sharing one instance.
 */
export function createFakeD1(): FakeD1Database {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);

  const fake = {
    prepare(sql: string) {
      return new FakePreparedStatement(sqlite, sql) as unknown as D1PreparedStatement;
    },
    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      const results: D1Result<T>[] = [];
      for (const statement of statements) {
        const bound = statement as unknown as FakeBoundStatement;
        results.push((await bound.all()) as unknown as D1Result<T>);
      }
      return results;
    },
    async exec(sql: string) {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
    async dump() {
      throw new Error("FakeD1Database.dump() is not implemented");
    },
    __sqlite: sqlite,
  };

  return fake as unknown as FakeD1Database;
}
