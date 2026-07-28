# Operator Adoption Metrics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an operator-only `/admin/metrics` page showing registrations, uploads per day, active workspaces, and feature adoption, backed by a D1 daily-rollup table plus an optional Analytics Engine breakdown.

**Architecture:** A new `daily_metrics` table in `uploads-production` accumulates per-day counters, written from a single never-throwing helper hooked into the existing accounting choke points. Reads go through pure query functions (reusable by a future digest-email cron) behind a KV-cached `/admin-ui/metrics/overview` endpoint. Signup history comes from the auth worker's own D1 over the `AUTH` service binding. Analytics Engine is layered on last and is additive-only.

**Tech Stack:** Cloudflare Workers, Hono, D1 (raw SQL in apps/api, drizzle-orm in apps/auth), KV, Analytics Engine, Astro (apps/web), Vitest with `node:sqlite`-backed fake D1.

Spec: `docs/superpowers/specs/2026-07-28-operator-adoption-metrics-design.md`

## Global Constraints

Every task's requirements implicitly include these.

- **A metrics failure must never fail an upload.** All recording is wrapped and logged as structured JSON, following `recordUsageSafe` in `apps/api/src/usage.ts`.
- **`count` and `bytes` are always non-negative.** A delete records positive bytes under the `delete` metric, never negative bytes under `upload`.
- **`daily_metrics` describes change over time only.** `workspace_usage` remains the source of truth for current absolute state. Never derive current stored bytes from `daily_metrics`.
- **The `ANALYTICS` binding is optional everywhere.** An absent binding is a silent no-op — self-hosters, tests, and local dev must work without it.
- **The Analytics Engine read path fails soft.** Missing token, missing account id, or an API error returns `{ available: false, reason }`; the rest of the page is unaffected.
- **apps/api never reads the auth D1 directly.** All auth data comes over the `AUTH` service binding, per the ownership note atop `apps/api/src/org-workspaces.ts`.
- **KV cache keys live under the `metrics:` prefix only**, never colliding with `ws:` records. The `mutateWorkspaceRecord` discipline governs `ws:` keys and does not apply here.
- **Auth `created_at` columns are epoch SECONDS**, not milliseconds — drizzle `integer(..., { mode: "timestamp" })` divides by 1000 on write. Grouping SQL uses `strftime('%Y-%m-%d', created_at, 'unixepoch')` with no `/1000`.
- **Formatting is oxfmt, linting is oxlint** (not prettier/eslint). The pre-commit hook runs both plus `wrangler types`.
- Run the full suite with `pnpm test` from the repo root, or a single file with `pnpm vitest run <path>`.

---

### Task 1: `daily_metrics` table and the recording helper

**Files:**

- Create: `apps/api/migrations/20260728120000_daily_metrics.sql`
- Create: `apps/api/src/adoption.ts`
- Test: `apps/api/test/adoption-sqlite.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `type AdoptionMetric = "upload" | "delete" | "workspace_created" | "gallery_created" | "comment_posted" | "repo_linked"`
  - `type UploadSurface = "api" | "mcp" | "promote"`
  - `interface AdoptionDimensions { surface?: UploadSurface; contentType?: string; client?: string; plan?: string; repo?: string }`
  - `interface AdoptionEvent { metric: AdoptionMetric; workspace: string; bytes?: number; dimensions?: AdoptionDimensions }`
  - `function utcDay(now?: Date): string`
  - `function bumpDailyMetric(db: D1Database, event: AdoptionEvent, now?: Date): Promise<void>` — throws on D1 failure
  - `function recordAdoptionSafe(env: Env, event: AdoptionEvent, now?: Date): Promise<void>` — never throws

> **Naming note:** the spec sketched `recordAdoption(env, event, ctx?)`. This plan uses `recordAdoptionSafe` and drops the `ExecutionContext` parameter, so the helper matches the established `recordUsageSafe` shape and is awaited on paths that already await D1. A floating un-awaited promise risks cancellation when the response returns; one extra `db.batch` on a path already doing several is the cheaper trade.

- [ ] **Step 1: Write the migration**

Create `apps/api/migrations/20260728120000_daily_metrics.sql`:

```sql
-- Per-day adoption counters (operator metrics surface). Describes CHANGE OVER
-- TIME only: `workspace_usage` remains the source of truth for current
-- absolute stored bytes/objects. `count`/`bytes` are always non-negative — a
-- delete records positive bytes under the `delete` metric rather than negative
-- bytes under `upload`, so net change is `upload.bytes - delete.bytes` at read
-- time.
--
-- Every recorded event writes TWO rows: the per-workspace row and a
-- platform-total row (`workspace = ''`). The platform row exists so the
-- headline trend charts cost exactly one index entry per day in the window
-- instead of one per (workspace, day) — D1 bills rows read, and that query
-- runs on every page load. D1 has a single writer per database, so the
-- "hot row" contention concern of a multi-master store does not apply.
--
-- Key order is (metric, day, workspace) so one metric's day range is
-- contiguous. Retention is unbounded: every query is windowed by `day >= ?`,
-- so old rows are never scanned and rolling them up would buy nothing.

CREATE TABLE daily_metrics (
  metric    TEXT NOT NULL,
  day       TEXT NOT NULL,               -- 'YYYY-MM-DD', UTC
  workspace TEXT NOT NULL DEFAULT '',    -- '' = the platform-total row
  count     INTEGER NOT NULL DEFAULT 0,
  bytes     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (metric, day, workspace)
);

-- Covering: carries count/bytes so grouped per-workspace scans are served
-- entirely from the index with no per-row table lookup. Same reasoning as
-- 20260722180000_file_metadata_value_covering_idx.sql.
CREATE INDEX daily_metrics_window_idx
  ON daily_metrics (metric, day, workspace, count, bytes);

-- Partial + covering: the headline trend series reads exactly one entry per
-- day in the window. Partial-index precedent: auth_tokens_minting_user_idx.
CREATE INDEX daily_metrics_platform_idx
  ON daily_metrics (metric, day, count, bytes)
  WHERE workspace = '';
```

- [ ] **Step 2: Write the failing test**

Create `apps/api/test/adoption-sqlite.test.ts`:

```ts
/// <reference types="node" />

import { describe, expect, it } from "vitest";
import { bumpDailyMetric, recordAdoptionSafe, utcDay } from "../src/adoption";
import { SqliteD1, database } from "./helpers/sqlite-d1";

const MIGRATION = "migrations/20260728120000_daily_metrics.sql";

interface Row {
  metric: string;
  day: string;
  workspace: string;
  count: number;
  bytes: number;
}

async function rows(db: D1Database): Promise<Row[]> {
  const result = await db
    .prepare(
      `SELECT metric, day, workspace, count, bytes FROM daily_metrics ORDER BY metric, day, workspace`,
    )
    .all<Row>();
  return result.results;
}

describe("utcDay", () => {
  it("formats as YYYY-MM-DD in UTC", () => {
    expect(utcDay(new Date("2026-07-28T23:59:59.000Z"))).toBe("2026-07-28");
  });

  it("rolls over on the UTC boundary, not local time", () => {
    expect(utcDay(new Date("2026-07-29T00:00:00.000Z"))).toBe("2026-07-29");
  });
});

describe("bumpDailyMetric", () => {
  it("writes both a workspace row and a platform row", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      const db = database(sqlite);
      await bumpDailyMetric(
        db,
        { metric: "upload", workspace: "acme", bytes: 100 },
        new Date("2026-07-28T10:00:00Z"),
      );
      expect(await rows(db)).toEqual([
        { metric: "upload", day: "2026-07-28", workspace: "", count: 1, bytes: 100 },
        { metric: "upload", day: "2026-07-28", workspace: "acme", count: 1, bytes: 100 },
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("accumulates repeat events into the same rows", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      const db = database(sqlite);
      const at = new Date("2026-07-28T10:00:00Z");
      await bumpDailyMetric(db, { metric: "upload", workspace: "acme", bytes: 100 }, at);
      await bumpDailyMetric(db, { metric: "upload", workspace: "acme", bytes: 50 }, at);
      expect(await rows(db)).toEqual([
        { metric: "upload", day: "2026-07-28", workspace: "", count: 2, bytes: 150 },
        { metric: "upload", day: "2026-07-28", workspace: "acme", count: 2, bytes: 150 },
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("separates days and keeps workspaces independent", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      const db = database(sqlite);
      await bumpDailyMetric(
        db,
        { metric: "upload", workspace: "acme", bytes: 10 },
        new Date("2026-07-28T10:00:00Z"),
      );
      await bumpDailyMetric(
        db,
        { metric: "upload", workspace: "beta", bytes: 20 },
        new Date("2026-07-29T10:00:00Z"),
      );
      expect(await rows(db)).toEqual([
        { metric: "upload", day: "2026-07-28", workspace: "", count: 1, bytes: 10 },
        { metric: "upload", day: "2026-07-28", workspace: "acme", count: 1, bytes: 10 },
        { metric: "upload", day: "2026-07-29", workspace: "", count: 1, bytes: 20 },
        { metric: "upload", day: "2026-07-29", workspace: "beta", count: 1, bytes: 20 },
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("stores deletes as positive bytes under their own metric", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      const db = database(sqlite);
      const at = new Date("2026-07-28T10:00:00Z");
      await bumpDailyMetric(db, { metric: "delete", workspace: "acme", bytes: 400 }, at);
      const all = await rows(db);
      expect(all.every((row) => row.bytes >= 0 && row.count >= 0)).toBe(true);
      expect(all).toContainEqual({
        metric: "delete",
        day: "2026-07-28",
        workspace: "acme",
        count: 1,
        bytes: 400,
      });
    } finally {
      sqlite.close();
    }
  });

  it("defaults bytes to 0 for non-byte metrics", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      const db = database(sqlite);
      await bumpDailyMetric(
        db,
        { metric: "workspace_created", workspace: "acme" },
        new Date("2026-07-28T10:00:00Z"),
      );
      expect(await rows(db)).toContainEqual({
        metric: "workspace_created",
        day: "2026-07-28",
        workspace: "acme",
        count: 1,
        bytes: 0,
      });
    } finally {
      sqlite.close();
    }
  });

  it("clamps a negative byte figure to 0 rather than storing it", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      const db = database(sqlite);
      await bumpDailyMetric(
        db,
        { metric: "delete", workspace: "acme", bytes: -400 },
        new Date("2026-07-28T10:00:00Z"),
      );
      const all = await rows(db);
      expect(all.every((row) => row.bytes === 0)).toBe(true);
    } finally {
      sqlite.close();
    }
  });
});

describe("recordAdoptionSafe", () => {
  it("swallows and logs a D1 failure instead of throwing", async () => {
    const failing = {
      prepare: () => {
        throw new Error("D1 exploded");
      },
    } as unknown as D1Database;
    const env = { DB: failing } as unknown as Env;
    await expect(
      recordAdoptionSafe(env, { metric: "upload", workspace: "acme", bytes: 1 }),
    ).resolves.toBeUndefined();
  });

  it("writes through to D1 on the happy path", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      const db = database(sqlite);
      const env = { DB: db } as unknown as Env;
      await recordAdoptionSafe(
        env,
        { metric: "upload", workspace: "acme", bytes: 7 },
        new Date("2026-07-28T10:00:00Z"),
      );
      expect(await rows(db)).toHaveLength(2);
    } finally {
      sqlite.close();
    }
  });

  it("is a no-op, not a crash, when the ANALYTICS binding is absent", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      const env = { DB: database(sqlite) } as unknown as Env;
      await expect(
        recordAdoptionSafe(env, {
          metric: "upload",
          workspace: "acme",
          bytes: 7,
          dimensions: { surface: "api", contentType: "image/png" },
        }),
      ).resolves.toBeUndefined();
    } finally {
      sqlite.close();
    }
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run apps/api/test/adoption-sqlite.test.ts`
Expected: FAIL — `Failed to resolve import "../src/adoption"`.

- [ ] **Step 4: Write the implementation**

Create `apps/api/src/adoption.ts`:

```ts
/**
 * Adoption metrics recording (`daily_metrics` D1 table) — the operator
 * metrics surface's write side.
 *
 * Describes CHANGE OVER TIME only. `workspace_usage` (src/usage.ts) remains
 * the source of truth for current absolute stored bytes/objects; nothing here
 * should ever be used to derive current state.
 *
 * Like `recordUsageSafe`, metering is best-effort: `recordAdoptionSafe` logs
 * and continues on failure, because a metrics write must never fail an upload.
 */

export type AdoptionMetric =
  | "upload"
  | "delete"
  | "workspace_created"
  | "gallery_created"
  | "comment_posted"
  | "repo_linked";

/**
 * Which server-side entry point wrote an upload. There is no way to tell a
 * CLI request from any other API request server-side, so finer-grained client
 * identity comes from the provenance bag's `client` value instead.
 */
export type UploadSurface = "api" | "mcp" | "promote";

/** Analytics Engine dimensions. Never written to D1 — see the module docs. */
export interface AdoptionDimensions {
  surface?: UploadSurface;
  contentType?: string;
  client?: string;
  plan?: string;
  repo?: string;
}

export interface AdoptionEvent {
  metric: AdoptionMetric;
  workspace: string;
  /** Non-negative bytes attributable to this event. Omitted/negative → 0. */
  bytes?: number;
  dimensions?: AdoptionDimensions;
}

/** The platform-total row's workspace sentinel. */
const PLATFORM = "";

/** UTC calendar day as `YYYY-MM-DD` — the rollup bucket. */
export function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Bytes are a non-negative magnitude; direction is carried by the metric. */
function normalizeBytes(bytes: number | undefined): number {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.round(bytes);
}

/**
 * Upsert the per-workspace row and the platform-total row for `event`.
 * Blind upserts — no preceding SELECT — issued as one batch so the pair is a
 * single round trip and cannot half-apply. Throws on D1 failure; callers on a
 * request path should use `recordAdoptionSafe` instead.
 */
export async function bumpDailyMetric(
  db: D1Database,
  event: AdoptionEvent,
  now = new Date(),
): Promise<void> {
  const day = utcDay(now);
  const bytes = normalizeBytes(event.bytes);
  const sql = `INSERT INTO daily_metrics (metric, day, workspace, count, bytes)
               VALUES (?, ?, ?, 1, ?)
               ON CONFLICT(metric, day, workspace) DO UPDATE SET
                 count = count + 1,
                 bytes = bytes + excluded.bytes`;
  await db.batch([
    db.prepare(sql).bind(event.metric, day, event.workspace, bytes),
    db.prepare(sql).bind(event.metric, day, PLATFORM, bytes),
  ]);
}

/**
 * Best-effort adoption recording: log and continue if the write fails.
 * Safe to await on any request path — it never throws.
 */
export async function recordAdoptionSafe(
  env: Env,
  event: AdoptionEvent,
  now = new Date(),
): Promise<void> {
  try {
    await bumpDailyMetric(env.DB, event, now);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({
        message: "adoption metric write failed",
        metric: event.metric,
        workspace: event.workspace,
        error: message,
      }),
    );
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run apps/api/test/adoption-sqlite.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/api/migrations/20260728120000_daily_metrics.sql apps/api/src/adoption.ts apps/api/test/adoption-sqlite.test.ts
git commit -m "feat(api): add daily_metrics table and adoption recording helper"
```

---

### Task 2: Record upload and delete events

**Files:**

- Modify: `apps/api/src/files-core.ts` (the `putObject` `opts` type, the post-`recordUsageSafe` hook in `putObject`, and the `recordUsageSafe` call in the delete path)
- Modify: `apps/api/src/routes/files.ts:220` (pass `surface`)
- Modify: `apps/api/src/github-promote.ts:154` (pass `surface`)
- Modify: `apps/mcp/src/tools.ts:691` and `apps/mcp/src/tools.ts:753` (pass `surface`)
- Test: `apps/api/test/routes-files.test.ts` (extend the existing route-level harness — no new test file)

**Interfaces:**

- Consumes: `recordAdoptionSafe`, `AdoptionEvent`, `UploadSurface` from Task 1.
- Produces: `putObject`'s `opts` gains `surface?: UploadSurface`.

> **These tests must exercise the real wiring, not re-test Task 1's helper.** A test that calls `bumpDailyMetric` directly proves nothing about whether `putObject` invokes it. Assert through the existing route-level harness in `apps/api/test/routes-files.test.ts`, so a hook that is never called fails the test.

- [ ] **Step 1: Give the route-level fake D1 a statement recorder**

`makeFakeDB` in `apps/api/test/routes-files.test.ts` hand-matches SQL and no-ops the usage ledger. Extend it to record prepared statements so adoption writes become assertable. Inside `makeFakeDB`, before its `return`:

```ts
const statements: { sql: string; args: unknown[] }[] = [];
```

Expose it on the returned object alongside `metadata`:

```ts
    statements,
```

And record each bind — in the object returned by `prepare(sql)`, inside `bind`, before `return this`:

```ts
statements.push({ sql: normalized, args: values });
```

Purely additive: no existing assertion in the file changes.

- [ ] **Step 2: Write the failing wiring tests**

Add to `apps/api/test/routes-files.test.ts`. Build the env exactly as the neighbouring put/delete tests in this file already do (same `FakeR2Bucket` and workspace-record setup, same `TOKEN`/`PNG` constants) — if they share a helper, reuse it under its real name rather than inventing one:

```ts
describe("adoption metrics wiring", () => {
  /** Identify adoption writes by table, not by statement position. */
  function adoptionWrites(db: { statements: { sql: string; args: unknown[] }[] }) {
    return db.statements.filter((s) => s.sql.includes("INSERT INTO daily_metrics"));
  }

  it("records an upload event when a put succeeds", async () => {
    const db = makeFakeDB();
    const env = /* same env construction as the neighbouring put tests */;
    const res = await app.request(
      "/v1/files/shot.png",
      { method: "PUT", headers: { authorization: `Bearer ${TOKEN}` }, body: PNG },
      env,
    );
    expect(res.status).toBe(201);

    const writes = adoptionWrites(db);
    // One per-workspace row + one platform row.
    expect(writes).toHaveLength(2);
    expect(writes.map((w) => w.args[0])).toEqual(["upload", "upload"]);
    expect(writes.map((w) => w.args[2]).sort()).toEqual(["", "default"]);
    expect(writes[0]?.args[3]).toBe(PNG.byteLength);
  });

  it("records nothing when the put is rejected", async () => {
    const db = makeFakeDB();
    const env = /* same env construction */;
    const res = await app.request(
      "/v1/files/shot.png",
      { method: "PUT", headers: { authorization: "Bearer wrong-token" }, body: PNG },
      env,
    );
    expect(res.status).toBe(401);
    expect(adoptionWrites(db)).toHaveLength(0);
  });

  it("records a delete event with positive bytes when a delete removes an object", async () => {
    const db = makeFakeDB();
    const env = /* same env construction */;
    await app.request(
      "/v1/files/shot.png",
      { method: "PUT", headers: { authorization: `Bearer ${TOKEN}` }, body: PNG },
      env,
    );
    const before = adoptionWrites(db).length;

    const res = await app.request(
      "/v1/files/shot.png",
      { method: "DELETE", headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(res.status).toBe(200);

    const deletes = adoptionWrites(db).slice(before);
    expect(deletes).toHaveLength(2);
    expect(deletes.map((w) => w.args[0])).toEqual(["delete", "delete"]);
    // Positive magnitude — direction is carried by the metric, never the sign.
    for (const write of deletes) expect(write.args[3] as number).toBeGreaterThan(0);
  });

  it("records no delete event when the key does not exist", async () => {
    const db = makeFakeDB();
    const env = /* same env construction */;
    await app.request(
      "/v1/files/absent.png",
      { method: "DELETE", headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(adoptionWrites(db).filter((w) => w.args[0] === "delete")).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run apps/api/test/routes-files.test.ts -t "adoption metrics wiring"`
Expected: FAIL — `expect(writes).toHaveLength(2)` receives `0`, because no hook exists yet. That red state is the point: it proves these tests actually detect a missing hook.

- [ ] **Step 4: Add `surface` to the `putObject` options type**

In `apps/api/src/files-core.ts`, inside the `opts?:` object literal of `putObject`'s signature, after the `metadata?: Record<string, string>;` member, add:

```ts
    /**
     * Which server-side entry point is writing this object. Recorded as an
     * Analytics Engine dimension only — never stored in D1, never affects the
     * write. Absent means the caller predates this parameter.
     */
    surface?: UploadSurface;
```

Add to the imports at the top of `files-core.ts`:

```ts
import { recordAdoptionSafe, type UploadSurface } from "./adoption";
```

- [ ] **Step 5: Hook the upload event**

In `apps/api/src/files-core.ts`, immediately after the `await recordUsageSafe(env.DB, workspaceName, { bytes: reservedBytes > 0 ? 0 : deltaBytes, objects: replaced ? 0 : 1, uploads: 0 });` call inside `putObject`, add:

```ts
// Adoption metrics, best-effort and never fatal (see src/adoption.ts).
// Recorded here rather than at the route so all four putObject callers are
// covered by construction. `newSize` (not deltaBytes) is the right figure:
// this counts bytes written by this upload, not net storage change.
await recordAdoptionSafe(env, {
  metric: "upload",
  workspace: workspaceName,
  bytes: newSize,
  dimensions: {
    surface: opts?.surface,
    contentType: inspection.contentType,
    client: provenance.client,
    repo: opts?.metadata?.["gh.repo"],
  },
});
```

- [ ] **Step 6: Hook the delete event**

In `apps/api/src/files-core.ts`, in the delete path, immediately after the existing

```ts
if (prev !== null) {
  await recordUsageSafe(env.DB, workspaceName, {
    bytes: -prev,
    objects: -1,
    uploads: 0,
  });
}
```

add inside the same `if` block, after the `recordUsageSafe` call:

```ts
// Positive magnitude under the `delete` metric — never negative bytes
// under `upload`. Net change is computed at read time.
await recordAdoptionSafe(env, { metric: "delete", workspace: workspaceName, bytes: prev });
```

Do **not** add a hook to the poster-cleanup delete below it: derived posters are an implementation detail, and counting them would inflate the delete series with events no operator initiated.

- [ ] **Step 7: Pass `surface` from each caller**

In `apps/api/src/routes/files.ts`, change the `putObject` options argument from

```ts
      { provenance, visibility, metadata, replace: wantReplace },
```

to

```ts
      { provenance, visibility, metadata, replace: wantReplace, surface: "api" },
```

In `apps/api/src/github-promote.ts`, add `surface: "promote"` to the options object passed to `putObject`.

In `apps/mcp/src/tools.ts`, add `surface: "mcp"` to the options object at the first `putObject` call, and add `surface: "mcp"` to the `putOpts` object used by the second.

- [ ] **Step 8: Typecheck and run the suite**

```bash
pnpm types && pnpm test
```

Expected: types clean; full suite PASS. Existing `files-core` tests continue to pass because `recordAdoptionSafe` never throws even when the test env has no real `daily_metrics` table.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/files-core.ts apps/api/src/routes/files.ts apps/api/src/github-promote.ts apps/mcp/src/tools.ts apps/api/test/routes-files.test.ts
git commit -m "feat(api): record upload and delete adoption events"
```

---

### Task 3: Record feature-adoption events

**Files:**

- Modify: `apps/api/src/routes/workspaces.ts` (self-serve create, after the workspace record is durably written)
- Modify: `apps/api/src/routes/galleries.ts` (gallery create handler)
- Modify: `apps/api/src/github-comment-service.ts` (after a managed comment is successfully posted)
- Modify: `apps/api/src/github-repo-links.ts` (after `recordRepoLink` actually creates a link)
- Test: `apps/api/test/adoption-feature-events.test.ts` (vocabulary), plus wiring assertions added to `apps/api/test/github-repo-links-sqlite.test.ts` and `apps/api/test/routes-galleries.test.ts`

**Interfaces:**

- Consumes: `recordAdoptionSafe` from Task 1.
- Produces: no new exported symbols.

> **Assert the real wiring wherever a harness already exists.** Two of these four call sites have cheap existing harnesses — use them. The other two are covered by the vocabulary regression test plus typecheck, which is stated honestly rather than dressed up as end-to-end coverage.

- [ ] **Step 1: Write the failing wiring test for repo links**

`apps/api/test/github-repo-links-sqlite.test.ts` already runs against a real `node:sqlite` D1, so `daily_metrics` can be asserted directly. Change its migration constant to apply both migrations:

```ts
const MIGRATIONS = [
  "migrations/20260720120000_github_repo_links.sql",
  "migrations/20260728120000_daily_metrics.sql",
];
```

Update the existing `new SqliteD1(MIGRATION)` calls in the file to `new SqliteD1(MIGRATIONS)`, then add:

```ts
describe("repo link adoption metrics", () => {
  async function repoLinkedCount(db: D1Database): Promise<number> {
    const row = await db
      .prepare(
        `SELECT COALESCE(SUM(count), 0) AS n FROM daily_metrics
         WHERE metric = 'repo_linked' AND workspace = 'acme'`,
      )
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  it("records repo_linked on a first claim", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      await recordRepoLink(db, "Acme/Web", "acme", "comment", 42);
      expect(await repoLinkedCount(db)).toBe(1);
    } finally {
      sqlite.close();
    }
  });

  it("does not record when a second claim is ignored (first claim wins)", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      await recordRepoLink(db, "Acme/Web", "acme", "comment", 42);
      await recordRepoLink(db, "Acme/Web", "beta", "comment", 43);
      // Still exactly one event: the ignored INSERT must not count.
      const row = await db
        .prepare(
          `SELECT COALESCE(SUM(count), 0) AS n FROM daily_metrics WHERE metric = 'repo_linked' AND workspace <> ''`,
        )
        .first<{ n: number }>();
      expect(row?.n).toBe(1);
    } finally {
      sqlite.close();
    }
  });
});
```

- [ ] **Step 2: Write the failing wiring test for gallery creation**

In `apps/api/test/routes-galleries.test.ts`, apply the same statement-recorder approach Task 2 added to `routes-files.test.ts` (record `{ sql, args }` on the fake D1's `bind`, expose a `statements` array), then add:

```ts
describe("gallery adoption metrics", () => {
  it("records gallery_created when a gallery is created", async () => {
    // Build the request exactly as the neighbouring create tests in this file do.
    const writes = db.statements.filter((s: { sql: string }) =>
      s.sql.includes("INSERT INTO daily_metrics"),
    );
    expect(writes).toHaveLength(2); // per-workspace + platform row
    expect(writes.map((w: { args: unknown[] }) => w.args[0])).toEqual([
      "gallery_created",
      "gallery_created",
    ]);
  });
});
```

If that suite's fake D1 already records statements, reuse what exists rather than adding a second mechanism.

- [ ] **Step 3: Write the metric-vocabulary regression test**

Create `apps/api/test/adoption-feature-events.test.ts`. This guards the metric names and their zero-byte shape; it does **not** claim to test wiring:

```ts
/// <reference types="node" />

import { describe, expect, it } from "vitest";
import { bumpDailyMetric } from "../src/adoption";
import { SqliteD1, database } from "./helpers/sqlite-d1";

const MIGRATION = "migrations/20260728120000_daily_metrics.sql";

describe("feature adoption metric vocabulary", () => {
  it("records each feature metric under its own key with zero bytes", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      const db = database(sqlite);
      const at = new Date("2026-07-28T10:00:00Z");
      for (const metric of [
        "workspace_created",
        "gallery_created",
        "comment_posted",
        "repo_linked",
      ] as const) {
        await bumpDailyMetric(db, { metric, workspace: "acme" }, at);
      }
      const result = await db
        .prepare(
          `SELECT metric, count, bytes FROM daily_metrics
           WHERE workspace = 'acme' ORDER BY metric`,
        )
        .all<{ metric: string; count: number; bytes: number }>();
      expect(result.results).toEqual([
        { metric: "comment_posted", count: 1, bytes: 0 },
        { metric: "gallery_created", count: 1, bytes: 0 },
        { metric: "repo_linked", count: 1, bytes: 0 },
        { metric: "workspace_created", count: 1, bytes: 0 },
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("keeps feature metrics out of the upload series", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      const db = database(sqlite);
      await bumpDailyMetric(
        db,
        { metric: "gallery_created", workspace: "acme" },
        new Date("2026-07-28T10:00:00Z"),
      );
      const row = await db
        .prepare(`SELECT COUNT(*) AS n FROM daily_metrics WHERE metric = 'upload'`)
        .first<{ n: number }>();
      expect(row?.n).toBe(0);
    } finally {
      sqlite.close();
    }
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

```bash
pnpm vitest run apps/api/test/github-repo-links-sqlite.test.ts apps/api/test/routes-galleries.test.ts -t "adoption metrics"
```

Expected: FAIL — the repo-link and gallery wiring assertions find zero `daily_metrics` writes, because no hook exists yet.

- [ ] **Step 5: Add the four call sites**

In each file, import the helper:

```ts
import { recordAdoptionSafe } from "../adoption";
```

(use `"./adoption"` in `apps/api/src/github-comment-service.ts` and `apps/api/src/github-repo-links.ts`, which sit at `src/` level; `github-repo-links.ts` receives a bare `D1Database` rather than `Env`, so import `bumpDailyMetric` there and wrap the call in its own try/catch — see below).

**`apps/api/src/routes/workspaces.ts`** — in the self-serve create handler, after the workspace record write succeeds and before the success response is returned:

```ts
await recordAdoptionSafe(c.env, { metric: "workspace_created", workspace: name });
```

The handler already binds the validated slug to a local `const name` — reuse it rather than introducing a new variable.

**`apps/api/src/routes/galleries.ts`** — in the create handler, after `createGallery(c.env.DB, …)` resolves and immediately before the existing `return c.json(await ownerGallery(c, result.value.id), 201);`:

```ts
await recordAdoptionSafe(c.env, { metric: "gallery_created", workspace: c.get("workspaceName") });
```

**`apps/api/src/github-comment-service.ts`** — after a managed comment is successfully created or patched, on the success path only:

```ts
await recordAdoptionSafe(env, { metric: "comment_posted", workspace: workspaceName });
```

Place it where both the create and the patch outcome converge, so an edit of an existing comment counts as one posted comment, not zero. A failed post must not record.

**`apps/api/src/github-repo-links.ts`** — `recordRepoLink` takes a bare `D1Database`, so record only when the `INSERT OR IGNORE` actually inserted (first claim wins — a no-op second claim must not count):

```ts
// Only a real first claim counts; INSERT OR IGNORE reports changes === 0
// when an existing link already owned the repo.
if ((result.meta?.changes ?? 0) > 0) {
  try {
    await bumpDailyMetric(db, { metric: "repo_linked", workspace: workspaceName });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({
        message: "adoption metric write failed",
        metric: "repo_linked",
        error: message,
      }),
    );
  }
}
```

Bind `result` to the existing `INSERT OR IGNORE` statement's `.run()` return value if it is not already captured.

- [ ] **Step 6: Typecheck and run the suite**

```bash
pnpm types && pnpm test
```

Expected: types clean; full suite PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/workspaces.ts apps/api/src/routes/galleries.ts apps/api/src/github-comment-service.ts apps/api/src/github-repo-links.ts apps/api/test/adoption-feature-events.test.ts apps/api/test/github-repo-links-sqlite.test.ts apps/api/test/routes-galleries.test.ts
git commit -m "feat(api): record workspace, gallery, comment and repo-link adoption events"
```

---

### Task 4: Read-side query functions

**Files:**

- Create: `apps/api/src/adoption-queries.ts`
- Test: `apps/api/test/adoption-queries-sqlite.test.ts`

**Interfaces:**

- Consumes: the `daily_metrics` schema from Task 1.
- Produces:
  - `interface DayPoint { day: string; count: number; bytes: number }`
  - `interface WorkspaceActivity { workspace: string; uploads: number; bytes: number; lastActive: string }`
  - `function windowStart(days: number, now?: Date): string`
  - `function platformSeries(db: D1Database, metric: AdoptionMetric, since: string): Promise<DayPoint[]>`
  - `function workspaceActivity(db: D1Database, since: string, limit?: number): Promise<WorkspaceActivity[]>`
  - `function activeWorkspaceCount(db: D1Database, since: string): Promise<number>`
  - `function featureTotals(db: D1Database, since: string): Promise<Record<string, number>>`
  - `function platformStorage(db: D1Database): Promise<{ workspaces: number; storedBytes: number }>`

These are pure `(db, range) => data` with no Hono or `Request` dependency — that is the seam a future digest-email cron calls directly, with no HTTP hop.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/adoption-queries-sqlite.test.ts`:

```ts
/// <reference types="node" />

import { describe, expect, it } from "vitest";
import { bumpDailyMetric } from "../src/adoption";
import {
  activeWorkspaceCount,
  featureTotals,
  platformSeries,
  windowStart,
  workspaceActivity,
} from "../src/adoption-queries";
import { SqliteD1, database } from "./helpers/sqlite-d1";

const MIGRATION = "migrations/20260728120000_daily_metrics.sql";

async function seed(db: D1Database): Promise<void> {
  const day = (d: string) => new Date(`${d}T10:00:00Z`);
  await bumpDailyMetric(db, { metric: "upload", workspace: "acme", bytes: 100 }, day("2026-07-26"));
  await bumpDailyMetric(db, { metric: "upload", workspace: "acme", bytes: 200 }, day("2026-07-28"));
  await bumpDailyMetric(db, { metric: "upload", workspace: "beta", bytes: 50 }, day("2026-07-28"));
  await bumpDailyMetric(db, { metric: "gallery_created", workspace: "acme" }, day("2026-07-28"));
}

describe("windowStart", () => {
  it("returns the inclusive first day of an N-day window", () => {
    expect(windowStart(7, new Date("2026-07-28T00:00:00Z"))).toBe("2026-07-22");
  });

  it("treats a 1-day window as today only", () => {
    expect(windowStart(1, new Date("2026-07-28T00:00:00Z"))).toBe("2026-07-28");
  });
});

describe("platformSeries", () => {
  it("reads only platform rows, one point per day with activity", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      const db = database(sqlite);
      await seed(db);
      expect(await platformSeries(db, "upload", "2026-07-01")).toEqual([
        { day: "2026-07-26", count: 1, bytes: 100 },
        { day: "2026-07-28", count: 2, bytes: 250 },
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("excludes days before the window", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      const db = database(sqlite);
      await seed(db);
      expect(await platformSeries(db, "upload", "2026-07-27")).toEqual([
        { day: "2026-07-28", count: 2, bytes: 250 },
      ]);
    } finally {
      sqlite.close();
    }
  });
});

describe("workspaceActivity", () => {
  it("aggregates per workspace and sorts by uploads descending", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      const db = database(sqlite);
      await seed(db);
      expect(await workspaceActivity(db, "2026-07-01")).toEqual([
        { workspace: "acme", uploads: 2, bytes: 300, lastActive: "2026-07-28" },
        { workspace: "beta", uploads: 1, bytes: 50, lastActive: "2026-07-28" },
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("never includes the platform sentinel row", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      const db = database(sqlite);
      await seed(db);
      const rows = await workspaceActivity(db, "2026-07-01");
      expect(rows.some((row) => row.workspace === "")).toBe(false);
    } finally {
      sqlite.close();
    }
  });
});

describe("activeWorkspaceCount", () => {
  it("counts distinct workspaces that uploaded in the window", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      const db = database(sqlite);
      await seed(db);
      expect(await activeWorkspaceCount(db, "2026-07-01")).toBe(2);
      expect(await activeWorkspaceCount(db, "2026-07-27")).toBe(2);
      expect(await activeWorkspaceCount(db, "2026-07-29")).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  it("does not count a workspace whose only activity was a gallery", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      const db = database(sqlite);
      await bumpDailyMetric(
        db,
        { metric: "gallery_created", workspace: "gamma" },
        new Date("2026-07-28T10:00:00Z"),
      );
      expect(await activeWorkspaceCount(db, "2026-07-01")).toBe(0);
    } finally {
      sqlite.close();
    }
  });
});

describe("featureTotals", () => {
  it("returns a per-metric total from platform rows", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      const db = database(sqlite);
      await seed(db);
      expect(await featureTotals(db, "2026-07-01")).toEqual({ upload: 3, gallery_created: 1 });
    } finally {
      sqlite.close();
    }
  });
});

describe("platformStorage", () => {
  it("reports current workspace count and stored bytes from workspace_usage", async () => {
    const sqlite = new SqliteD1([USAGE_MIGRATION, MIGRATION]);
    try {
      const db = database(sqlite);
      await db
        .prepare(
          `INSERT INTO workspace_usage (workspace, bytes, objects, uploads_in_period, period_start, updated_at)
           VALUES ('acme', 500, 2, 2, '2026-07', '2026-07-28T00:00:00Z'),
                  ('beta', 250, 1, 1, '2026-07', '2026-07-28T00:00:00Z')`,
        )
        .run();
      expect(await platformStorage(db)).toEqual({ workspaces: 2, storedBytes: 750 });
    } finally {
      sqlite.close();
    }
  });

  it("returns zeros on an empty ledger rather than nulls", async () => {
    const sqlite = new SqliteD1([USAGE_MIGRATION, MIGRATION]);
    try {
      expect(await platformStorage(database(sqlite))).toEqual({ workspaces: 0, storedBytes: 0 });
    } finally {
      sqlite.close();
    }
  });
});
```

Add the second migration constant and the import at the top of the file:

```ts
const USAGE_MIGRATION = "migrations/20260710140000_workspace_usage.sql";
```

and extend the `adoption-queries` import to include `platformStorage`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run apps/api/test/adoption-queries-sqlite.test.ts`
Expected: FAIL — `Failed to resolve import "../src/adoption-queries"`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/adoption-queries.ts`:

```ts
/**
 * Read side of the adoption metrics (`daily_metrics`).
 *
 * Deliberately pure `(db, range) => data` with no Hono/Request dependency, so
 * a future digest-email cron can call these directly instead of making an
 * HTTP hop through /admin-ui.
 *
 * D1 bills rows read, so every query here is windowed by `day >= ?` and is
 * served from one of the two covering indexes:
 *   - platform-level reads hit `daily_metrics_platform_idx` (partial on
 *     `workspace = ''`) and cost one entry per day in the window, regardless
 *     of how many workspaces exist;
 *   - per-workspace reads hit `daily_metrics_window_idx`, which carries
 *     count/bytes so there is no per-row table lookup. The table is sparse —
 *     a row exists only for a (metric, day, workspace) with real activity —
 *     so that scan is proportional to actual usage, not workspaces × days.
 */

import type { AdoptionMetric } from "./adoption";
import { utcDay } from "./adoption";

export interface DayPoint {
  day: string;
  count: number;
  bytes: number;
}

export interface WorkspaceActivity {
  workspace: string;
  uploads: number;
  bytes: number;
  /** Most recent day with an upload, `YYYY-MM-DD`. */
  lastActive: string;
}

/** Default cap on the per-workspace table. */
const DEFAULT_LIMIT = 100;

/**
 * Inclusive first day of an N-day window ending today, `YYYY-MM-DD`.
 * `days = 1` means today only.
 */
export function windowStart(days: number, now = new Date()): string {
  const start = new Date(now.getTime());
  start.setUTCDate(start.getUTCDate() - (Math.max(1, Math.floor(days)) - 1));
  return utcDay(start);
}

/** Daily platform totals for one metric. One index entry per day in window. */
export async function platformSeries(
  db: D1Database,
  metric: AdoptionMetric,
  since: string,
): Promise<DayPoint[]> {
  const result = await db
    .prepare(
      `SELECT day, count, bytes FROM daily_metrics
       WHERE metric = ? AND workspace = '' AND day >= ?
       ORDER BY day`,
    )
    .bind(metric, since)
    .all<DayPoint>();
  return result.results;
}

/** Per-workspace upload activity in the window, busiest first. */
export async function workspaceActivity(
  db: D1Database,
  since: string,
  limit = DEFAULT_LIMIT,
): Promise<WorkspaceActivity[]> {
  const result = await db
    .prepare(
      `SELECT workspace,
              SUM(count) AS uploads,
              SUM(bytes) AS bytes,
              MAX(day)   AS lastActive
       FROM daily_metrics
       WHERE metric = 'upload' AND workspace <> '' AND day >= ?
       GROUP BY workspace
       ORDER BY uploads DESC, workspace ASC
       LIMIT ?`,
    )
    .bind(since, limit)
    .all<WorkspaceActivity>();
  return result.results;
}

/** Workspaces that uploaded at least once in the window. */
export async function activeWorkspaceCount(db: D1Database, since: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(DISTINCT workspace) AS n FROM daily_metrics
       WHERE metric = 'upload' AND workspace <> '' AND day >= ?`,
    )
    .bind(since)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Per-metric event totals in the window, from platform rows only. */
export async function featureTotals(
  db: D1Database,
  since: string,
): Promise<Record<string, number>> {
  const result = await db
    .prepare(
      `SELECT metric, SUM(count) AS total FROM daily_metrics
       WHERE workspace = '' AND day >= ?
       GROUP BY metric`,
    )
    .bind(since)
    .all<{ metric: string; total: number }>();
  const totals: Record<string, number> = {};
  for (const row of result.results) totals[row.metric] = row.total;
  return totals;
}

/**
 * Current platform-wide state, read from `workspace_usage` — the source of
 * truth for absolute stored bytes. Deliberately NOT derived from
 * `daily_metrics`, which only describes change over time and would drift.
 *
 * `workspaces` counts workspaces with at least one recorded upload (a
 * `workspace_usage` row). Registered-but-idle workspaces are not included —
 * the organizations total from the auth worker is the registration figure.
 * One aggregate over a table with one row per workspace.
 */
export async function platformStorage(
  db: D1Database,
): Promise<{ workspaces: number; storedBytes: number }> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS workspaces, COALESCE(SUM(bytes), 0) AS storedBytes FROM workspace_usage`,
    )
    .first<{ workspaces: number; storedBytes: number }>();
  return { workspaces: row?.workspaces ?? 0, storedBytes: row?.storedBytes ?? 0 };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run apps/api/test/adoption-queries-sqlite.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/adoption-queries.ts apps/api/test/adoption-queries-sqlite.test.ts
git commit -m "feat(api): add adoption metrics query functions"
```

---

### Task 5: Signup metrics from the auth worker

**Files:**

- Create: `apps/auth/migrations/20260728120000_created_at_indexes.sql`
- Modify: `apps/auth/src/internal-routes.ts` (add `GET /internal/metrics`)
- Test: `apps/auth/src/internal-metrics.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `GET /internal/metrics?since=YYYY-MM-DD` returning

```ts
{
  users: {
    day: string;
    count: number;
  }
  [];
  orgs: {
    day: string;
    count: number;
  }
  [];
  totals: {
    users: number;
    orgs: number;
    admins: number;
    banned: number;
  }
}
```

- [ ] **Step 1: Write the migration**

Create `apps/auth/migrations/20260728120000_created_at_indexes.sql`:

```sql
-- Signup-by-day aggregation for the operator metrics surface. Without these
-- the windowed GROUP BY scans every user/organization row, and D1 bills rows
-- read. `created_at` is epoch SECONDS (drizzle `mode: "timestamp"`), not
-- milliseconds.

CREATE INDEX IF NOT EXISTS user_created_at_idx ON user (created_at);
CREATE INDEX IF NOT EXISTS organization_created_at_idx ON organization (created_at);
```

- [ ] **Step 2: Write the failing test**

Create `apps/auth/src/internal-metrics.test.ts`:

```ts
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import type { AuthEnv } from "./auth";
import { internal } from "./internal-routes";
import * as schema from "./schema";
import { createFakeD1, type FakeD1Database } from "./test/fake-d1";

describe("GET /internal/metrics", () => {
  let db: FakeD1Database;
  let orm: ReturnType<typeof drizzle<typeof schema>>;

  beforeEach(() => {
    db = createFakeD1();
    orm = drizzle(db, { schema });
  });

  function app() {
    return new Hono<{ Bindings: AuthEnv }>().route("/internal", internal);
  }

  function env(): AuthEnv {
    return {
      DB: db,
      WEB_ORIGIN: "https://uploads.sh",
      ENVIRONMENT: "development",
      BETTER_AUTH_SECRET_DEV: "test-signing-secret-at-least-32-chars-long",
    } as AuthEnv;
  }

  async function seedUser(createdAt: Date, overrides: Partial<schema.AuthUser> = {}) {
    await orm.insert(schema.user).values({
      id: crypto.randomUUID(),
      name: "Ada",
      email: `ada-${crypto.randomUUID()}@example.com`,
      emailVerified: true,
      image: null,
      createdAt,
      updatedAt: createdAt,
      role: overrides.role ?? "user",
      banned: overrides.banned ?? null,
      banReason: null,
      banExpires: null,
      cliOnboardedAt: null,
      stripeCustomerId: null,
    } as schema.AuthUser);
  }

  it("groups signups by UTC day", async () => {
    await seedUser(new Date("2026-07-26T10:00:00Z"));
    await seedUser(new Date("2026-07-28T01:00:00Z"));
    await seedUser(new Date("2026-07-28T23:00:00Z"));

    const res = await app().request("/internal/metrics?since=2026-07-01", {}, env());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: { day: string; count: number }[] };
    expect(body.users).toEqual([
      { day: "2026-07-26", count: 1 },
      { day: "2026-07-28", count: 2 },
    ]);
  });

  it("excludes signups before the window", async () => {
    await seedUser(new Date("2026-07-01T10:00:00Z"));
    await seedUser(new Date("2026-07-28T10:00:00Z"));

    const res = await app().request("/internal/metrics?since=2026-07-20", {}, env());
    const body = (await res.json()) as { users: { day: string; count: number }[] };
    expect(body.users).toEqual([{ day: "2026-07-28", count: 1 }]);
  });

  it("reports all-time totals independent of the window", async () => {
    await seedUser(new Date("2026-01-01T10:00:00Z"), { role: "admin" });
    await seedUser(new Date("2026-07-28T10:00:00Z"), { banned: true });

    const res = await app().request("/internal/metrics?since=2026-07-20", {}, env());
    const body = (await res.json()) as {
      totals: { users: number; admins: number; banned: number };
    };
    expect(body.totals.users).toBe(2);
    expect(body.totals.admins).toBe(1);
    expect(body.totals.banned).toBe(1);
  });

  it("defaults to a 30-day window when `since` is absent", async () => {
    const res = await app().request("/internal/metrics", {}, env());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: unknown[]; orgs: unknown[] };
    expect(Array.isArray(body.users)).toBe(true);
    expect(Array.isArray(body.orgs)).toBe(true);
  });

  it("rejects a malformed `since`", async () => {
    const res = await app().request("/internal/metrics?since=not-a-date", {}, env());
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run apps/auth/src/internal-metrics.test.ts`
Expected: FAIL — 404 responses, because `/internal/metrics` does not exist yet.

- [ ] **Step 4: Add the route**

In `apps/auth/src/internal-routes.ts`, extend the drizzle import to include `gte` and `sql`:

```ts
import { and, count, countDistinct, eq, gt, gte, isNull, max, sql } from "drizzle-orm";
```

Add this helper above the router definition:

```ts
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `created_at` is epoch SECONDS (drizzle `integer(..., { mode: "timestamp" })`
 * divides by 1000 on write) — hence 'unixepoch' with no /1000. Getting this
 * wrong buckets every signup into 1970.
 */
const DAY_EXPR = (column: unknown) => sql<string>`strftime('%Y-%m-%d', ${column}, 'unixepoch')`;
```

Add the route to the `internal` chain, placed alongside the other `GET` handlers:

```ts
  .get("/metrics", async (c) => {
    const sinceParam = c.req.query("since");
    if (sinceParam !== undefined && !DAY_RE.test(sinceParam)) {
      return c.json(errorJson("invalid_since", "`since` must be YYYY-MM-DD"), 400);
    }
    // Default window matches the overview endpoint's default.
    const since = sinceParam
      ? new Date(`${sinceParam}T00:00:00.000Z`)
      : new Date(Date.now() - 29 * 86_400_000);

    const db = drizzle(c.env.DB, { schema });
    const userDay = DAY_EXPR(schema.user.createdAt);
    const orgDay = DAY_EXPR(schema.organization.createdAt);

    const [users, orgs, userTotal, orgTotal, adminTotal, bannedTotal] = await Promise.all([
      db
        .select({ day: userDay, count: count() })
        .from(schema.user)
        .where(gte(schema.user.createdAt, since))
        .groupBy(userDay)
        .orderBy(userDay),
      db
        .select({ day: orgDay, count: count() })
        .from(schema.organization)
        .where(gte(schema.organization.createdAt, since))
        .groupBy(orgDay)
        .orderBy(orgDay),
      db.select({ n: count() }).from(schema.user),
      db.select({ n: count() }).from(schema.organization),
      db.select({ n: count() }).from(schema.user).where(eq(schema.user.role, "admin")),
      db.select({ n: count() }).from(schema.user).where(eq(schema.user.banned, true)),
    ]);

    return c.json({
      users,
      orgs,
      totals: {
        users: userTotal[0]?.n ?? 0,
        orgs: orgTotal[0]?.n ?? 0,
        admins: adminTotal[0]?.n ?? 0,
        banned: bannedTotal[0]?.n ?? 0,
      },
    });
  })
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run apps/auth/src/internal-metrics.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/auth/migrations/20260728120000_created_at_indexes.sql apps/auth/src/internal-routes.ts apps/auth/src/internal-metrics.test.ts
git commit -m "feat(auth): add /internal/metrics signup aggregation"
```

---

### Task 6: The `/admin-ui/metrics/overview` endpoint

**Files:**

- Create: `apps/api/src/metrics-overview.ts`
- Modify: `apps/api/src/routes/admin-ui.ts` (add the route)
- Test: `apps/api/src/routes/admin-ui-metrics.test.ts`

**Interfaces:**

- Consumes: `platformSeries`, `workspaceActivity`, `activeWorkspaceCount`, `featureTotals`, `windowStart` (Task 4); `GET /internal/metrics` (Task 5).
- Produces:
  - `const OVERVIEW_CACHE_TTL = 600`
  - `function overviewCacheKey(days: number): string` → `metrics:overview:v1:<days>`
  - `function buildOverview(env: Env, days: number, now?: Date): Promise<MetricsOverview>`
  - `interface MetricsOverview { window: { days: number; since: string }; totals: { users: number; orgs: number; workspaces: number; storedBytes: number; activeWorkspaces7d: number; activeWorkspaces30d: number; uploads: number; bytes: number }; series: { uploads: DayPoint[]; users: SignupPoint[]; orgs: SignupPoint[] }; features: Record<string, number>; workspaces: WorkspaceActivity[] }`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/admin-ui-metrics.test.ts`:

```ts
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { bumpDailyMetric } from "../adoption";
import { SqliteD1, database } from "../../test/helpers/sqlite-d1";
import { respondError } from "../error-response";
import { adminUi } from "./admin-ui";

// Both: buildOverview reads daily_metrics AND workspace_usage.
const MIGRATIONS = [
  "migrations/20260710140000_workspace_usage.sql",
  "migrations/20260728120000_daily_metrics.sql",
];
const ADMIN_USER = { id: "u-admin", email: "admin@b.com", name: "Admin", role: "admin" };
const NON_ADMIN_USER = { id: "u-plain", email: "plain@b.com", name: "Plain", role: "user" };

function stubAuth(user: typeof ADMIN_USER | null): Pick<Fetcher, "fetch"> {
  return {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const url = new URL(req.url);
      if (url.pathname === "/api/auth/get-session") {
        return new Response(JSON.stringify(user ? { session: {}, user } : null), { status: 200 });
      }
      if (url.pathname === "/internal/metrics") {
        return Response.json({
          users: [{ day: "2026-07-28", count: 3 }],
          orgs: [{ day: "2026-07-28", count: 1 }],
          totals: { users: 12, orgs: 4, admins: 1, banned: 0 },
        });
      }
      return new Response(null, { status: 404 });
    }) as Fetcher["fetch"],
  };
}

/** Minimal KV stub recording puts so cache behavior is assertable. */
function fakeKv() {
  const store = new Map<string, string>();
  let puts = 0;
  return {
    store,
    get puts() {
      return puts;
    },
    binding: {
      get: (async (key: string) => store.get(key) ?? null) as unknown as KVNamespace["get"],
      put: (async (key: string, value: string) => {
        puts += 1;
        store.set(key, value);
      }) as unknown as KVNamespace["put"],
      list: (async () => ({
        keys: [],
        list_complete: true,
        cacheStatus: null,
      })) as unknown as KVNamespace["list"],
    } as KVNamespace,
  };
}

function app() {
  return new Hono<{ Bindings: Env }>()
    .route("/admin-ui", adminUi)
    .onError((err, c) => respondError(c, err));
}

async function seededDb() {
  const sqlite = new SqliteD1(MIGRATIONS);
  const db = database(sqlite);
  const at = new Date();
  await bumpDailyMetric(db, { metric: "upload", workspace: "acme", bytes: 100 }, at);
  await bumpDailyMetric(db, { metric: "upload", workspace: "beta", bytes: 50 }, at);
  await bumpDailyMetric(db, { metric: "gallery_created", workspace: "acme" }, at);
  await db
    .prepare(
      `INSERT INTO workspace_usage (workspace, bytes, objects, uploads_in_period, period_start, updated_at)
       VALUES ('acme', 100, 1, 1, '2026-07', '2026-07-28T00:00:00Z'),
              ('beta', 50, 1, 1, '2026-07', '2026-07-28T00:00:00Z')`,
    )
    .run();
  return { sqlite, db };
}

describe("GET /admin-ui/metrics/overview", () => {
  it("401s with no session", async () => {
    const { sqlite, db } = await seededDb();
    try {
      const env = { AUTH: stubAuth(null), DB: db, REGISTRY: fakeKv().binding } as unknown as Env;
      const res = await app().request("/admin-ui/metrics/overview", {}, env);
      expect(res.status).toBe(401);
    } finally {
      sqlite.close();
    }
  });

  it("403s for a non-admin session", async () => {
    const { sqlite, db } = await seededDb();
    try {
      const env = {
        AUTH: stubAuth(NON_ADMIN_USER),
        DB: db,
        REGISTRY: fakeKv().binding,
      } as unknown as Env;
      const res = await app().request("/admin-ui/metrics/overview", {}, env);
      expect(res.status).toBe(403);
    } finally {
      sqlite.close();
    }
  });

  it("returns totals, series and the workspace table for an admin", async () => {
    const { sqlite, db } = await seededDb();
    try {
      const env = {
        AUTH: stubAuth(ADMIN_USER),
        DB: db,
        REGISTRY: fakeKv().binding,
      } as unknown as Env;
      const res = await app().request("/admin-ui/metrics/overview?days=30", {}, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        window: { days: number; since: string };
        totals: {
          users: number;
          orgs: number;
          workspaces: number;
          storedBytes: number;
          uploads: number;
          bytes: number;
          activeWorkspaces30d: number;
        };
        series: { uploads: unknown[]; users: unknown[] };
        features: Record<string, number>;
        workspaces: { workspace: string; uploads: number }[];
      };
      expect(body.window.days).toBe(30);
      expect(body.totals.users).toBe(12);
      expect(body.totals.orgs).toBe(4);
      expect(body.totals.workspaces).toBe(2);
      expect(body.totals.storedBytes).toBe(150);
      expect(body.totals.uploads).toBe(2);
      expect(body.totals.bytes).toBe(150);
      expect(body.totals.activeWorkspaces30d).toBe(2);
      expect(body.features.gallery_created).toBe(1);
      expect(body.workspaces.map((w) => w.workspace).sort()).toEqual(["acme", "beta"]);
    } finally {
      sqlite.close();
    }
  });

  it("serves the second request from cache without recomputing", async () => {
    const { sqlite, db } = await seededDb();
    try {
      const kv = fakeKv();
      const env = { AUTH: stubAuth(ADMIN_USER), DB: db, REGISTRY: kv.binding } as unknown as Env;
      await app().request("/admin-ui/metrics/overview?days=30", {}, env);
      expect(kv.puts).toBe(1);
      expect(kv.store.has("metrics:overview:v1:30")).toBe(true);
      const res = await app().request("/admin-ui/metrics/overview?days=30", {}, env);
      expect(res.status).toBe(200);
      expect(kv.puts).toBe(1);
    } finally {
      sqlite.close();
    }
  });

  it("bypasses the cache with ?fresh=1", async () => {
    const { sqlite, db } = await seededDb();
    try {
      const kv = fakeKv();
      const env = { AUTH: stubAuth(ADMIN_USER), DB: db, REGISTRY: kv.binding } as unknown as Env;
      await app().request("/admin-ui/metrics/overview?days=30", {}, env);
      await app().request("/admin-ui/metrics/overview?days=30&fresh=1", {}, env);
      expect(kv.puts).toBe(2);
    } finally {
      sqlite.close();
    }
  });

  it("still answers when the cache read throws", async () => {
    const { sqlite, db } = await seededDb();
    try {
      const broken = {
        get: (async () => {
          throw new Error("KV down");
        }) as unknown as KVNamespace["get"],
        put: (async () => {
          throw new Error("KV down");
        }) as unknown as KVNamespace["put"],
      } as KVNamespace;
      const env = { AUTH: stubAuth(ADMIN_USER), DB: db, REGISTRY: broken } as unknown as Env;
      const res = await app().request("/admin-ui/metrics/overview", {}, env);
      expect(res.status).toBe(200);
    } finally {
      sqlite.close();
    }
  });

  it("rejects an unsupported window", async () => {
    const { sqlite, db } = await seededDb();
    try {
      const env = {
        AUTH: stubAuth(ADMIN_USER),
        DB: db,
        REGISTRY: fakeKv().binding,
      } as unknown as Env;
      const res = await app().request("/admin-ui/metrics/overview?days=365", {}, env);
      expect(res.status).toBe(400);
    } finally {
      sqlite.close();
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run apps/api/src/routes/admin-ui-metrics.test.ts`
Expected: FAIL — `Failed to resolve import "../metrics-overview"` once the route file imports it, or 404s on the overview path.

- [ ] **Step 3: Write the overview builder**

Create `apps/api/src/metrics-overview.ts`:

```ts
/**
 * Composes the operator metrics overview from the D1 rollups (this worker)
 * and signup history (the auth worker, over the AUTH service binding — never
 * a direct cross-database read).
 *
 * Cached in KV because D1 bills rows read: the TTL bounds cost by elapsed
 * time rather than by page loads. Cache keys live under the `metrics:` prefix
 * and are NOT workspace records, so the `mutateWorkspaceRecord` discipline
 * that governs `ws:` keys does not apply here.
 */

import {
  activeWorkspaceCount,
  featureTotals,
  platformSeries,
  platformStorage,
  windowStart,
  workspaceActivity,
  type DayPoint,
  type WorkspaceActivity,
} from "./adoption-queries";

export const OVERVIEW_CACHE_TTL = 600;

/** Windows the UI offers. Anything else is rejected, so the cache stays small. */
export const ALLOWED_WINDOWS = [7, 30, 90] as const;

export interface SignupPoint {
  day: string;
  count: number;
}

export interface MetricsOverview {
  window: { days: number; since: string };
  totals: {
    /** All-time, from the auth worker. */
    users: number;
    /** All-time registered organizations, from the auth worker. */
    orgs: number;
    /** Workspaces with at least one recorded upload (not registrations). */
    workspaces: number;
    /** Current absolute stored bytes, from `workspace_usage`. */
    storedBytes: number;
    activeWorkspaces7d: number;
    activeWorkspaces30d: number;
    /** Uploads within the selected window. */
    uploads: number;
    /** Bytes uploaded within the selected window — not stored bytes. */
    bytes: number;
  };
  series: {
    uploads: DayPoint[];
    users: SignupPoint[];
    orgs: SignupPoint[];
  };
  features: Record<string, number>;
  workspaces: WorkspaceActivity[];
}

interface AuthMetrics {
  users: SignupPoint[];
  orgs: SignupPoint[];
  totals: { users: number; orgs: number; admins: number; banned: number };
}

const EMPTY_AUTH: AuthMetrics = {
  users: [],
  orgs: [],
  totals: { users: 0, orgs: 0, admins: 0, banned: 0 },
};

export function overviewCacheKey(days: number): string {
  return `metrics:overview:v1:${days}`;
}

/**
 * Signup history from the auth worker. Degrades to zeros rather than failing
 * the page: the D1-backed half of the overview is still worth showing.
 */
async function authMetrics(env: Env, since: string): Promise<AuthMetrics> {
  try {
    const res = await env.AUTH.fetch(`https://auth.internal/internal/metrics?since=${since}`);
    if (!res.ok) return EMPTY_AUTH;
    return (await res.json()) as AuthMetrics;
  } catch {
    return EMPTY_AUTH;
  }
}

export async function buildOverview(
  env: Env,
  days: number,
  now = new Date(),
): Promise<MetricsOverview> {
  const since = windowStart(days, now);
  const since7 = windowStart(7, now);
  const since30 = windowStart(30, now);

  const [uploads, features, table, active7, active30, storage, auth] = await Promise.all([
    platformSeries(env.DB, "upload", since),
    featureTotals(env.DB, since),
    workspaceActivity(env.DB, since),
    activeWorkspaceCount(env.DB, since7),
    activeWorkspaceCount(env.DB, since30),
    platformStorage(env.DB),
    authMetrics(env, since),
  ]);

  return {
    window: { days, since },
    totals: {
      users: auth.totals.users,
      orgs: auth.totals.orgs,
      workspaces: storage.workspaces,
      storedBytes: storage.storedBytes,
      activeWorkspaces7d: active7,
      activeWorkspaces30d: active30,
      uploads: uploads.reduce((sum, point) => sum + point.count, 0),
      bytes: uploads.reduce((sum, point) => sum + point.bytes, 0),
    },
    series: { uploads, users: auth.users, orgs: auth.orgs },
    features,
    workspaces: table,
  };
}

/** Cached read. Cache failures fall through to a live build, never a 500. */
export async function cachedOverview(
  env: Env,
  days: number,
  fresh: boolean,
  now = new Date(),
): Promise<MetricsOverview> {
  const key = overviewCacheKey(days);
  if (!fresh) {
    try {
      const hit = await env.REGISTRY.get(key);
      if (hit) return JSON.parse(hit) as MetricsOverview;
    } catch {
      // fall through to a live build
    }
  }
  const overview = await buildOverview(env, days, now);
  try {
    await env.REGISTRY.put(key, JSON.stringify(overview), { expirationTtl: OVERVIEW_CACHE_TTL });
  } catch {
    // caching is an optimization, never a requirement
  }
  return overview;
}
```

- [ ] **Step 4: Add the route**

In `apps/api/src/routes/admin-ui.ts`, add the import:

```ts
import { ALLOWED_WINDOWS, cachedOverview } from "../metrics-overview";
```

Add this handler to the `adminUi` chain, next to the other `GET` routes:

```ts
  .get("/metrics/overview", async (c) => {
    const raw = c.req.query("days");
    const days = raw === undefined ? 30 : Number(raw);
    if (!ALLOWED_WINDOWS.includes(days as (typeof ALLOWED_WINDOWS)[number])) {
      throw new ValidationError(`days must be one of ${ALLOWED_WINDOWS.join(", ")}`, {
        code: "invalid_window",
      });
    }
    return c.json(await cachedOverview(c.env, days, c.req.query("fresh") === "1"));
  })
```

`ValidationError` is already imported at the top of the file.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run apps/api/src/routes/admin-ui-metrics.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Run the full suite and commit**

```bash
pnpm types && pnpm test
git add apps/api/src/metrics-overview.ts apps/api/src/routes/admin-ui.ts apps/api/src/routes/admin-ui-metrics.test.ts
git commit -m "feat(api): add cached /admin-ui/metrics/overview endpoint"
```

---

### Task 7: The `/admin/metrics` page

**Files:**

- Create: `apps/web/src/pages/admin/metrics.astro`
- Create: `apps/web/src/styles/admin-metrics.css`
- Modify: `apps/web/src/layouts/AdminLayout.astro` (add the nav entry and section)

**Interfaces:**

- Consumes: `GET /admin-ui/metrics/overview?days=N` (Task 6).
- Produces: nothing other tasks depend on.

> **REQUIRED SUB-SKILL:** invoke the `dataviz` skill before writing any chart markup in Step 3. It governs chart form, color, and accessibility, and applies to inline SVG exactly as it does to a charting library.

- [ ] **Step 1: Add the nav entry**

In `apps/web/src/layouts/AdminLayout.astro`:

Change the section type:

```ts
export type AdminSection = "workspaces" | "metrics" | "users" | "oauth" | "email";
```

Add to `titles`:

```ts
  metrics: "Metrics · Admin",
```

Add to `nav`, immediately after the Workspaces entry:

```ts
  { href: "/admin/metrics", section: "metrics", label: "Metrics" },
```

- [ ] **Step 2: Add the stylesheet**

Create `apps/web/src/styles/admin-metrics.css`:

```css
/* Operator metrics surface. Follows the per-page CSS convention used by
   admin-workspaces.css / admin-oauth.css — design-system tokens only, no
   hard-coded colors, so light and dark both work. */

.metrics-tiles {
  display: grid;
  gap: var(--space-3);
  grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
  margin-block-end: var(--space-5);
}

.metrics-tile {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: var(--space-3);
}

.metrics-tile dt {
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
}

.metrics-tile dd {
  font-size: var(--font-size-xl);
  /* Tabular figures so the numbers don't jitter between refreshes. */
  font-variant-numeric: tabular-nums;
  margin: 0;
}

.metrics-section {
  margin-block-end: var(--space-5);
}

.metrics-chart {
  display: block;
  inline-size: 100%;
  block-size: auto;
}

.metrics-range {
  display: flex;
  gap: var(--space-2);
  margin-block-end: var(--space-3);
}

/* Wide content scrolls inside its own container; the page body never scrolls
   horizontally. */
.metrics-table-wrap {
  overflow-x: auto;
}

.metrics-num {
  font-variant-numeric: tabular-nums;
  text-align: right;
}
```

Verify the token names above against `apps/web/src/styles/admin.css` and the design-system stylesheet before committing; substitute the repo's actual token names where they differ. Do not introduce literal color values.

- [ ] **Step 3: Create the page**

Create `apps/web/src/pages/admin/metrics.astro` following the structure of `apps/web/src/pages/admin/index.astro`:

- Frontmatter: `import AdminLayout from "../../layouts/AdminLayout.astro";`, `import "../../styles/admin-metrics.css";`, `export const prerender = false;`
- `<AdminLayout section="metrics">` wrapping a `<section class="admin-page">` with an `<h2>Adoption</h2>` header and a one-line description.
- A range toggle (7 / 30 / 90) as buttons with `data-days`.
- A `<dl class="metrics-tiles">` with one `<div class="metrics-tile"><dt>…</dt><dd id="…"></dd></div>` per figure. The `dd` ids are fixed by `render` below: `tile-users` (Users), `tile-orgs` (Organizations), `tile-workspaces` (Workspaces with uploads), `tile-stored` (Stored bytes), `tile-active-7` (Active, 7d), `tile-active-30` (Active, 30d), `tile-uploads` (Uploads in window). Give the container `id="metrics-tiles"` — the script's early-return guard keys off it.
- Label the tiles exactly as above. "Workspaces with uploads" is not the registration count (idle workspaces have no `workspace_usage` row); "Organizations" is the registration figure. Mislabelling these two makes the page quietly wrong.
- Two chart slots (uploads per day, signups per day) rendered as inline SVG bar charts built from the JSON — **write these only after invoking the `dataviz` skill**. Each chart needs an accessible text alternative (a visually-hidden table or `role="img"` with a descriptive `aria-label`), because an SVG bar chart is not readable on its own.
- A workspace table `<table class="admin-table" id="workspace-activity">` inside a `.metrics-table-wrap`; `render` fills its head and body.
- A `<div id="metrics-status" class="admin-status">Loading…</div>` following the existing loading-state convention.

Client script, mirroring the `onAstroPageLoad` / `requireElement` / `apiGet` pattern from `apps/web/src/pages/admin/index.astro`:

```ts
import { onAstroPageLoad, requireElement } from "../../lib/account-shell";
import { escapeHtml } from "../../lib/admin-ui";

onAstroPageLoad(() => {
  if (!document.getElementById("metrics-tiles")) return;

  const w = window as unknown as { __UPLOADS_API_ORIGIN__: string };
  const apiOrigin = w.__UPLOADS_API_ORIGIN__.replace(/\/$/, "");
  const status = requireElement<HTMLElement>("#metrics-status", "admin");

  interface DayPoint {
    day: string;
    count: number;
    bytes: number;
  }
  interface SignupPoint {
    day: string;
    count: number;
  }
  interface WorkspaceRow {
    workspace: string;
    uploads: number;
    bytes: number;
    lastActive: string;
  }
  interface Overview {
    window: { days: number; since: string };
    totals: {
      users: number;
      orgs: number;
      activeWorkspaces7d: number;
      activeWorkspaces30d: number;
      uploads: number;
      bytes: number;
    };
    series: { uploads: DayPoint[]; users: SignupPoint[]; orgs: SignupPoint[] };
    features: Record<string, number>;
    workspaces: WorkspaceRow[];
  }

  let days = 30;

  async function load(): Promise<void> {
    status.hidden = false;
    status.textContent = "Loading…";
    try {
      const res = await fetch(`${apiOrigin}/admin-ui/metrics/overview?days=${days}`, {
        credentials: "include",
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`request failed: ${res.status}`);
      render((await res.json()) as Overview);
      status.hidden = true;
    } catch {
      status.hidden = false;
      status.textContent = "Could not load metrics. Try again.";
    }
  }

  void load();
});
```

Then `render`, the tile/table half. Workspace names are user-chosen, so `escapeHtml` is required on every one; numeric fields are coerced rather than trusted:

```ts
const num = (input: unknown): string => {
  const parsed = Number(input);
  return Number.isFinite(parsed) ? parsed.toLocaleString() : "0";
};

const bytes = (input: unknown): string => {
  const n = Number(input);
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
};

function render(overview: Overview): void {
  const tile = (id: string, value: string) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };
  tile("tile-users", num(overview.totals.users));
  tile("tile-orgs", num(overview.totals.orgs));
  tile("tile-workspaces", num(overview.totals.workspaces));
  tile("tile-stored", bytes(overview.totals.storedBytes));
  tile("tile-active-7", num(overview.totals.activeWorkspaces7d));
  tile("tile-active-30", num(overview.totals.activeWorkspaces30d));
  tile("tile-uploads", num(overview.totals.uploads));

  const table = requireElement<HTMLElement>("#workspace-activity", "admin");
  table.innerHTML =
    `<thead><tr><th scope="col">Workspace</th><th scope="col" class="metrics-num">Uploads</th><th scope="col" class="metrics-num">Bytes</th><th scope="col">Last active</th></tr></thead><tbody>` +
    overview.workspaces
      .map(
        (row) =>
          `<tr><td>${escapeHtml(row.workspace)}</td><td class="metrics-num">${num(row.uploads)}</td><td class="metrics-num">${bytes(row.bytes)}</td><td>${escapeHtml(row.lastActive)}</td></tr>`,
      )
      .join("") +
    `</tbody>`;

  drawChart(
    "chart-uploads",
    overview.series.uploads.map((p) => ({ day: p.day, value: p.count })),
    "Uploads per day",
  );
  drawChart(
    "chart-signups",
    overview.series.users.map((p) => ({ day: p.day, value: p.count })),
    "Signups per day",
  );
}
```

`drawChart(elementId, points, label)` is the only piece left — **write it after invoking the `dataviz` skill**, which governs its form, color, and accessible alternative. Its signature is fixed by the two calls above: `(elementId: string, points: { day: string; value: number }[], label: string) => void`.

Finally, wire the range buttons:

```ts
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-days]")) {
  button.addEventListener("click", () => {
    days = Number(button.dataset.days);
    for (const other of document.querySelectorAll<HTMLButtonElement>("[data-days]")) {
      other.setAttribute("aria-pressed", other === button ? "true" : "false");
    }
    void load();
  });
}
```

Give each range button `aria-pressed` in the markup so the active window is exposed to assistive technology, not just conveyed by styling.

- [ ] **Step 4: Verify in the browser**

Start the dev stack and check the page renders, using the signed-in-session recipe from `docs/` (a signed-in browser session requires the `stack-raw` 127.0.0.1 flow — the portless origin cannot produce one in the in-app browser).

Check with the Browser pane tools:

1. `read_console_messages` — no errors.
2. `read_page` — tiles, charts and table present.
3. `read_network_requests` — `/admin-ui/metrics/overview` returns 200.
4. `resize_window` at mobile and desktop, in both light and dark, confirming the table scrolls inside its wrapper and the page body does not scroll horizontally.
5. `computer {action: "screenshot"}` for the PR.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/admin/metrics.astro apps/web/src/styles/admin-metrics.css apps/web/src/layouts/AdminLayout.astro
git commit -m "feat(web): add /admin/metrics adoption surface"
```

---

### Task 8: Analytics Engine write path

**Files:**

- Modify: `apps/api/wrangler.jsonc` (add the `analytics_engine_datasets` binding)
- Modify: `apps/api/src/adoption.ts` (write the data point)
- Test: `apps/api/test/adoption-analytics.test.ts`

**Interfaces:**

- Consumes: `AdoptionEvent`, `AdoptionDimensions` from Task 1.
- Produces: `function writeAdoptionPoint(env: Env, event: AdoptionEvent): void`

- [ ] **Step 1: Add the binding**

In `apps/api/wrangler.jsonc`, add after the `d1_databases` block:

```jsonc
  // Analytics Engine dataset for wide per-upload dimensions (surface, content
  // type, client, plan, repo) that would never justify D1 columns. Purely
  // additive: src/adoption.ts treats an absent ANALYTICS binding as a no-op,
  // so deleting this block disables the breakdown panel and nothing else.
  // Reads need ANALYTICS_API_TOKEN (an account token with Account Analytics:
  // Read) set via `wrangler secret put` — there is no read binding.
  "analytics_engine_datasets": [
    {
      "binding": "ANALYTICS",
      "dataset": "uploads_adoption",
    },
  ],
```

- [ ] **Step 2: Write the failing test**

Create `apps/api/test/adoption-analytics.test.ts`:

```ts
/// <reference types="node" />

import { describe, expect, it } from "vitest";
import { writeAdoptionPoint } from "../src/adoption";

interface Captured {
  blobs?: unknown[];
  doubles?: number[];
  indexes?: string[];
}

function fakeAnalytics() {
  const points: Captured[] = [];
  return {
    points,
    binding: { writeDataPoint: (point: Captured) => points.push(point) },
  };
}

describe("writeAdoptionPoint", () => {
  it("writes one point per upload with the workspace as the index", () => {
    const analytics = fakeAnalytics();
    const env = { ANALYTICS: analytics.binding } as unknown as Env;
    writeAdoptionPoint(env, {
      metric: "upload",
      workspace: "acme",
      bytes: 2048,
      dimensions: { surface: "api", contentType: "image/png", client: "uploads-cli/0.30.0" },
    });
    expect(analytics.points).toHaveLength(1);
    expect(analytics.points[0]?.indexes).toEqual(["acme"]);
    expect(analytics.points[0]?.doubles).toEqual([2048]);
    expect(analytics.points[0]?.blobs).toEqual([
      "acme",
      "api",
      "image/png",
      "uploads-cli/0.30.0",
      "",
      "",
    ]);
  });

  it("writes nothing for non-upload metrics", () => {
    const analytics = fakeAnalytics();
    const env = { ANALYTICS: analytics.binding } as unknown as Env;
    writeAdoptionPoint(env, { metric: "gallery_created", workspace: "acme" });
    expect(analytics.points).toHaveLength(0);
  });

  it("is a no-op when the binding is absent", () => {
    expect(() =>
      writeAdoptionPoint({} as unknown as Env, { metric: "upload", workspace: "acme", bytes: 1 }),
    ).not.toThrow();
  });

  it("never throws when the binding itself fails", () => {
    const env = {
      ANALYTICS: {
        writeDataPoint: () => {
          throw new Error("AE down");
        },
      },
    } as unknown as Env;
    expect(() =>
      writeAdoptionPoint(env, { metric: "upload", workspace: "acme", bytes: 1 }),
    ).not.toThrow();
  });

  it("substitutes empty strings for absent dimensions so blob positions stay stable", () => {
    const analytics = fakeAnalytics();
    const env = { ANALYTICS: analytics.binding } as unknown as Env;
    writeAdoptionPoint(env, { metric: "upload", workspace: "acme", bytes: 1 });
    expect(analytics.points[0]?.blobs).toEqual(["acme", "", "", "", "", ""]);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run apps/api/test/adoption-analytics.test.ts`
Expected: FAIL — `writeAdoptionPoint is not a function`.

- [ ] **Step 4: Implement, and call it from `recordAdoptionSafe`**

Add to `apps/api/src/adoption.ts`:

```ts
/**
 * Blob positions are a contract with the SQL read path (analytics-engine.ts)
 * — Analytics Engine has no column names, only ordinals. Append new
 * dimensions at the END; never reorder or remove, or historical rows change
 * meaning retroactively.
 */
export const BLOB_ORDER = [
  "workspace",
  "surface",
  "contentType",
  "client",
  "plan",
  "repo",
] as const;

/**
 * One wide data point per upload. Upload-only by design: the other metrics are
 * low-volume and fully served by D1, so sending them here would add a second
 * place to look without adding an answer.
 *
 * Never throws and never awaits — an absent binding (self-hosters, tests,
 * local dev) is a silent no-op.
 */
export function writeAdoptionPoint(env: Env, event: AdoptionEvent): void {
  if (event.metric !== "upload") return;
  const analytics = (env as { ANALYTICS?: AnalyticsEngineDataset }).ANALYTICS;
  if (!analytics) return;
  const d = event.dimensions ?? {};
  try {
    analytics.writeDataPoint({
      // Sampling key: keeps one workspace's traffic from crowding out another.
      indexes: [event.workspace],
      blobs: [
        event.workspace,
        d.surface ?? "",
        d.contentType ?? "",
        d.client ?? "",
        d.plan ?? "",
        d.repo ?? "",
      ],
      doubles: [normalizeBytes(event.bytes)],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ message: "adoption analytics write failed", error: message }));
  }
}
```

`BLOB_ORDER` is exported so the read path in Task 9 can be checked against it; nothing imports it at runtime, because Analytics Engine addresses columns by ordinal (`blob1`…`blob6`) rather than by name.

In `recordAdoptionSafe`, call it before the D1 write so an AE write still happens if D1 is down:

```ts
export async function recordAdoptionSafe(
  env: Env,
  event: AdoptionEvent,
  now = new Date(),
): Promise<void> {
  writeAdoptionPoint(env, event);
  try {
    await bumpDailyMetric(env.DB, event, now);
  } catch (err) {
    // ...unchanged...
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm vitest run apps/api/test/adoption-analytics.test.ts apps/api/test/adoption-sqlite.test.ts
```

Expected: PASS, both files.

- [ ] **Step 6: Regenerate types, run the suite, and commit**

```bash
pnpm types && pnpm test
git add apps/api/wrangler.jsonc apps/api/src/adoption.ts apps/api/test/adoption-analytics.test.ts apps/api/worker-configuration.d.ts
git commit -m "feat(api): write upload adoption points to Analytics Engine"
```

---

### Task 9: Analytics Engine read path and breakdown panel

**Files:**

- Create: `apps/api/src/analytics-engine.ts`
- Modify: `apps/api/src/routes/admin-ui.ts` (add `GET /metrics/breakdown`)
- Modify: `apps/web/src/pages/admin/metrics.astro` (add the lazily-loaded panel)
- Test: `apps/api/src/analytics-engine.test.ts`

**Interfaces:**

- Consumes: nothing at runtime. `BLOB_COLUMN` below must stay positionally consistent with `BLOB_ORDER` in `adoption.ts` (Task 8) — AE addresses columns by ordinal, so this is a hand-maintained contract, not an import.
- Produces:
  - `type BreakdownDimension = "surface" | "contentType" | "client" | "plan" | "repo"`
  - `interface BreakdownRow { value: string; events: number; bytes: number }`
  - `type BreakdownResult = { available: true; rows: BreakdownRow[] } | { available: false; reason: string }`
  - `function breakdownQuery(dimension: BreakdownDimension, days: number): string`
  - `function fetchBreakdown(env: Env, dimension: BreakdownDimension, days: number, fetchImpl?: typeof fetch): Promise<BreakdownResult>`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/analytics-engine.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { breakdownQuery, fetchBreakdown } from "./analytics-engine";

function env(overrides: Record<string, unknown> = {}): Env {
  return {
    CLOUDFLARE_ACCOUNT_ID: "acct-123",
    ANALYTICS_API_TOKEN: "tok-abc",
    ...overrides,
  } as unknown as Env;
}

function jsonFetch(payload: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(payload), { status })) as unknown as typeof fetch;
}

describe("breakdownQuery", () => {
  it("selects the blob matching the requested dimension", () => {
    expect(breakdownQuery("surface", 30)).toContain("blob2");
    expect(breakdownQuery("repo", 30)).toContain("blob6");
  });

  it("multiplies by _sample_interval so sampled counts are scaled back up", () => {
    expect(breakdownQuery("surface", 30)).toContain("_sample_interval");
  });

  it("windows by the requested number of days", () => {
    expect(breakdownQuery("surface", 7)).toContain("INTERVAL '7' DAY");
  });
});

describe("fetchBreakdown", () => {
  it("returns rows on success", async () => {
    const impl = jsonFetch({
      data: [
        { value: "api", events: 120, bytes: 5000 },
        { value: "mcp", events: 40, bytes: 900 },
      ],
    });
    const result = await fetchBreakdown(env(), "surface", 30, impl);
    expect(result).toEqual({
      available: true,
      rows: [
        { value: "api", events: 120, bytes: 5000 },
        { value: "mcp", events: 40, bytes: 900 },
      ],
    });
  });

  it("reports unavailable when the token is missing", async () => {
    const result = await fetchBreakdown(
      env({ ANALYTICS_API_TOKEN: undefined }),
      "surface",
      30,
      jsonFetch({}),
    );
    expect(result).toEqual({ available: false, reason: "not_configured" });
  });

  it("reports unavailable when the account id is missing", async () => {
    const result = await fetchBreakdown(
      env({ CLOUDFLARE_ACCOUNT_ID: undefined }),
      "surface",
      30,
      jsonFetch({}),
    );
    expect(result).toEqual({ available: false, reason: "not_configured" });
  });

  it("reports unavailable on a non-OK response rather than throwing", async () => {
    const result = await fetchBreakdown(env(), "surface", 30, jsonFetch({ errors: ["nope"] }, 403));
    expect(result).toEqual({ available: false, reason: "query_failed" });
  });

  it("reports unavailable when the request throws", async () => {
    const impl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const result = await fetchBreakdown(env(), "surface", 30, impl);
    expect(result).toEqual({ available: false, reason: "query_failed" });
  });

  it("rejects an unknown dimension without issuing a request", async () => {
    let called = false;
    const impl = (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch;
    const result = await fetchBreakdown(env(), "bogus" as never, 30, impl);
    expect(result).toEqual({ available: false, reason: "invalid_dimension" });
    expect(called).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run apps/api/src/analytics-engine.test.ts`
Expected: FAIL — `Failed to resolve import "./analytics-engine"`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/analytics-engine.ts`:

```ts
/**
 * Analytics Engine read path for the operator metrics breakdown panel.
 *
 * AE has no read binding, so this goes over the Cloudflare SQL API with an
 * account token (ANALYTICS_API_TOKEN, an account token carrying "Account
 * Analytics: Read", set via `wrangler secret put`). That token is distinct
 * from the local wrangler token in .env.
 *
 * EVERY failure mode returns `{ available: false, reason }` rather than
 * throwing: this panel is additive, and the D1-backed half of the metrics
 * page must keep working when AE is unconfigured or unreachable.
 *
 * Retention is 90 days — AE is for recent dimensional curiosity, never the
 * durable record. That lives in `daily_metrics`.
 */

const SQL_ENDPOINT = "https://api.cloudflare.com/client/v4/accounts";
const DATASET = "uploads_adoption";

export type BreakdownDimension = "surface" | "contentType" | "client" | "plan" | "repo";

export interface BreakdownRow {
  value: string;
  events: number;
  bytes: number;
}

export type BreakdownResult =
  | { available: true; rows: BreakdownRow[] }
  | { available: false; reason: string };

/**
 * Blob ordinals, matching BLOB_ORDER in adoption.ts. AE columns are
 * positional, so this mapping is a contract with the write path — appending
 * is safe, reordering rewrites the meaning of historical rows.
 */
const BLOB_COLUMN: Record<BreakdownDimension, string> = {
  surface: "blob2",
  contentType: "blob3",
  client: "blob4",
  plan: "blob5",
  repo: "blob6",
};

export function breakdownQuery(dimension: BreakdownDimension, days: number): string {
  const column = BLOB_COLUMN[dimension];
  const window = Math.max(1, Math.min(90, Math.floor(days)));
  // _sample_interval scales sampled rows back to a real-world estimate; a raw
  // COUNT() under-reports whenever AE has sampled.
  return `SELECT ${column} AS value,
                 SUM(_sample_interval) AS events,
                 SUM(double1 * _sample_interval) AS bytes
          FROM ${DATASET}
          WHERE timestamp > NOW() - INTERVAL '${window}' DAY
          GROUP BY value
          ORDER BY events DESC
          LIMIT 20`;
}

export async function fetchBreakdown(
  env: Env,
  dimension: BreakdownDimension,
  days: number,
  fetchImpl: typeof fetch = fetch,
): Promise<BreakdownResult> {
  if (!(dimension in BLOB_COLUMN)) return { available: false, reason: "invalid_dimension" };

  const account = (env as { CLOUDFLARE_ACCOUNT_ID?: string }).CLOUDFLARE_ACCOUNT_ID;
  const token = (env as { ANALYTICS_API_TOKEN?: string }).ANALYTICS_API_TOKEN;
  if (!account || !token) return { available: false, reason: "not_configured" };

  try {
    const res = await fetchImpl(`${SQL_ENDPOINT}/${account}/analytics_engine/sql`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: breakdownQuery(dimension, days),
    });
    if (!res.ok) return { available: false, reason: "query_failed" };
    const payload = (await res.json()) as { data?: BreakdownRow[] };
    return { available: true, rows: payload.data ?? [] };
  } catch {
    return { available: false, reason: "query_failed" };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run apps/api/src/analytics-engine.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Add the route**

In `apps/api/src/routes/admin-ui.ts`, add the import:

```ts
import { fetchBreakdown, type BreakdownDimension } from "../analytics-engine";
```

Add the handler to the `adminUi` chain:

```ts
  .get("/metrics/breakdown", async (c) => {
    const dimension = (c.req.query("dimension") ?? "surface") as BreakdownDimension;
    const days = Number(c.req.query("days") ?? 30);
    // Always 200: an unavailable AE is a normal, expected state that the page
    // renders as a panel message, not an error the caller must handle.
    return c.json(await fetchBreakdown(c.env, dimension, Number.isFinite(days) ? days : 30));
  })
```

- [ ] **Step 6: Add the panel to the page**

In `apps/web/src/pages/admin/metrics.astro`, add below the workspace table:

```html
<section class="metrics-section" id="breakdown-panel">
  <h3>Upload breakdown</h3>
  <p class="admin-hint">Last 90 days, from Analytics Engine. Sampled and approximate.</p>
  <label for="breakdown-dimension">Group by</label>
  <select id="breakdown-dimension" class="ul-select">
    <option value="surface">Surface</option>
    <option value="contentType">Content type</option>
    <option value="client">Client</option>
    <option value="repo">Repository</option>
  </select>
  <div id="breakdown-status" class="admin-status" hidden></div>
  <div class="metrics-table-wrap">
    <table class="admin-table" id="breakdown-table" aria-label="Upload breakdown"></table>
  </div>
</section>
```

In the client script, load it **after** the overview resolves so it never blocks first paint:

```ts
async function loadBreakdown(): Promise<void> {
  const select = requireElement<HTMLSelectElement>("#breakdown-dimension", "admin");
  const panelStatus = requireElement<HTMLElement>("#breakdown-status", "admin");
  const table = requireElement<HTMLElement>("#breakdown-table", "admin");
  try {
    const res = await fetch(
      `${apiOrigin}/admin-ui/metrics/breakdown?dimension=${select.value}&days=90`,
      { credentials: "include", cache: "no-store" },
    );
    const body = (await res.json()) as
      | { available: true; rows: { value: string; events: number; bytes: number }[] }
      | { available: false; reason: string };
    if (!body.available) {
      table.innerHTML = "";
      panelStatus.hidden = false;
      panelStatus.textContent =
        body.reason === "not_configured"
          ? "Analytics Engine is not configured. Set ANALYTICS_API_TOKEN to enable this panel."
          : "Breakdown is temporarily unavailable.";
      return;
    }
    panelStatus.hidden = true;
    // Every interpolated field is either escaped or coerced to a number.
    // `value` carries client-supplied data (content type, client string, repo
    // name) that reached AE straight from upload requests, so escapeHtml is
    // load-bearing here, not decorative. The numeric columns are typed
    // `number` but arrive as untyped JSON from an external API, so they are
    // coerced rather than trusted.
    const num = (input: unknown): string => {
      const parsed = Number(input);
      return Number.isFinite(parsed) ? String(parsed) : "0";
    };
    table.innerHTML =
      `<thead><tr><th scope="col">Value</th><th scope="col" class="metrics-num">Uploads</th><th scope="col" class="metrics-num">Bytes</th></tr></thead><tbody>` +
      body.rows
        .map(
          (row) =>
            `<tr><td>${escapeHtml(row.value || "(none)")}</td><td class="metrics-num">${num(row.events)}</td><td class="metrics-num">${num(row.bytes)}</td></tr>`,
        )
        .join("") +
      `</tbody>`;
  } catch {
    panelStatus.hidden = false;
    panelStatus.textContent = "Breakdown is temporarily unavailable.";
  }
}
```

Call `void loadBreakdown();` at the end of `load()`'s success path, and bind it to the select's `change` event.

- [ ] **Step 7: Verify the unconfigured path in the browser**

With no `ANALYTICS_API_TOKEN` set locally, confirm with the Browser pane tools that the page renders fully, the overview tiles and charts populate, and the breakdown panel shows the "not configured" message with no console errors. This is the state production will be in until the secret is set, so it must look deliberate rather than broken.

- [ ] **Step 8: Run the full suite and commit**

```bash
pnpm types && pnpm lint && pnpm test
git add apps/api/src/analytics-engine.ts apps/api/src/analytics-engine.test.ts apps/api/src/routes/admin-ui.ts apps/web/src/pages/admin/metrics.astro
git commit -m "feat: add Analytics Engine upload breakdown panel"
```

---

## Post-merge operator checklist

Not code — the manual steps that make the feature fully live.

- [ ] The D1 migrations auto-apply on merge to main via CI. No manual `wrangler d1 migrations apply` is owed for either database.
- [ ] Confirm the account API token carries **Account Analytics: Read**. If it does not, mint one that does.
- [ ] Set the worker secret:

```bash
pnpm --filter @uploads/api exec wrangler secret put ANALYTICS_API_TOKEN
```

- [ ] Add `CLOUDFLARE_ACCOUNT_ID` to `apps/api/wrangler.jsonc`'s `vars` (the account id is not a secret) if it is not already present.
- [ ] Load `/admin/metrics` in production and confirm the breakdown panel reports available.
- [ ] Screenshot the page and attach it to the PR with the `github-screenshots` skill.
