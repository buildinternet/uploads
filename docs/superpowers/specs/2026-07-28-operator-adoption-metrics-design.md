# Operator adoption metrics — design

Date: 2026-07-28
Status: approved, ready for planning

## Goal

Give operators one page that answers "is anyone actually using this, and is it
growing?" — registrations, uploads per day, active workspaces, and which
features get touched. Internal-only, so the bar is "accurate and cheap", not
"polished". The aggregate queries are built so a future digest email can call
them directly.

## What exists today

- **Admin shell** — `/admin` (workspaces), `/admin/users`, `/admin/oauth`,
  `/admin/email`, sharing `apps/web/src/layouts/AdminLayout.astro`. Data comes
  from `/admin-ui/*` on apps/api, gated by `requireAdminUser`.
- **Two D1 databases** — `uploads-production` (workspace usage, CLI telemetry,
  file metadata, PR activity) and `uploads-auth` (users, orgs, subscriptions).
  apps/api has no binding into the auth database by design; it reaches auth
  only over the `AUTH` service binding (see the ownership note at the top of
  `apps/api/src/org-workspaces.ts`).
- **No Analytics Engine binding anywhere.**
- **Almost nothing is a time series.** `workspace_usage` is a running counter
  with no date dimension. Workspaces live in KV with an optional `createdAt`
  set only by the self-serve path. `uploads_telemetry_events` has real
  timestamps but is anonymous, CLI-side, and opt-out, so it cannot be the
  authoritative upload count.

One exception, and it is a useful one: `user.created_at` and
`organization.created_at` in the auth D1 are populated epoch-ms columns.
**Registration history is therefore fully retroactive with no instrumentation
at all.** Only uploads and feature counters start from deploy day.

## Decisions

| Decision   | Choice                                      | Why                                                                                                                                                                                 |
| ---------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Storage    | Hybrid: D1 daily rollups + Analytics Engine | D1 owns the exact, durable, low-cardinality numbers that digest emails will quote; AE owns wide dimensional detail we would never add D1 columns for. Neither duplicates the other. |
| Backfill   | None for uploads                            | No per-upload record exists to reconstruct from. Registrations come back complete anyway via `created_at`.                                                                          |
| Page shape | Overview + per-workspace table              | Aggregates answer "growing?", the table answers "who?". AE breakdowns load lazily so their latency never blocks first paint.                                                        |
| Charts     | Inline SVG, no library                      | Matches the zero-dependency style of the existing admin pages.                                                                                                                      |

## Architecture

### 1. Recording — `apps/api/src/adoption.ts`

One exported entry point:

```ts
recordAdoption(env, event, ctx?): void   // never throws, never awaited on the hot path
```

It fans out to both sinks — a D1 upsert into `daily_metrics` and
`env.ANALYTICS?.writeDataPoint(...)`. Both are wrapped and logged as structured
JSON, following `recordUsageSafe` in `apps/api/src/usage.ts`: **a metrics
failure must never fail an upload.** The AE binding is optional everywhere, so
an absent binding (self-hosters, tests, local dev) is a silent no-op.

Event kinds: `upload`, `delete`, `workspace_created`, `gallery_created`,
`comment_posted`, `repo_linked`.

`count` and `bytes` are always non-negative — a `delete` event records a
positive byte figure under the `delete` metric rather than a negative one under
`upload`. Net stored change for a day is `upload.bytes - delete.bytes`,
computed at read time. Absolute stored totals continue to come from
`workspace_usage`, which stays the source of truth for current state; this
table only ever describes _change over time_.

**Only `upload` events are written to Analytics Engine.** The other kinds are
low-volume and fully served by D1, so sending them to AE would add a second
place to look without adding an answer.

The upload hook sits in `putObject` (`apps/api/src/files-core.ts`, immediately
after the existing `recordUsageSafe` call) — the object is durably stored by
then, and all four callers (the REST files route, `github-promote`, and two
hosted-MCP tools) funnel through it. `putObject`'s `opts` gains an optional
`surface: "api" | "mcp" | "promote"` that each caller passes as a literal;
there is no server-side way to tell a CLI request from any other API request,
so the finer-grained client identity comes from the existing provenance bag.

### 2. D1 schema

```sql
CREATE TABLE daily_metrics (
  metric    TEXT NOT NULL,
  day       TEXT NOT NULL,               -- 'YYYY-MM-DD', UTC
  workspace TEXT NOT NULL DEFAULT '',    -- '' = the platform-total row
  count     INTEGER NOT NULL DEFAULT 0,
  bytes     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (metric, day, workspace)
);

-- Grouped per-workspace scans, served entirely from the index.
CREATE INDEX daily_metrics_window_idx
  ON daily_metrics (metric, day, workspace, count, bytes);

-- Headline trend series: exactly one entry per day in the window.
CREATE INDEX daily_metrics_platform_idx
  ON daily_metrics (metric, day, count, bytes)
  WHERE workspace = '';
```

Writes are blind upserts — `INSERT ... ON CONFLICT(metric, day, workspace) DO
UPDATE SET count = count + excluded.count, bytes = bytes + excluded.bytes` —
with no preceding `SELECT`.

Each recorded event writes two rows: the per-workspace row and the platform
row (`workspace = ''`). D1 has a single writer per database, so the "hot global
row" concern that would apply to a multi-master store does not apply here.

Key order is `(metric, day, workspace)` so a single metric's day range is
contiguous. Retention is unbounded: every query is windowed by `day >= ?`, so
old rows are never scanned and there is nothing to gain from rolling them up.

### 3. Query efficiency

D1 bills rows read, so the read path is the design constraint. Four measures,
following the precedent set by `20260722180000_file_metadata_value_covering_idx.sql`
(widened to covering because a sort-before-`LIMIT` billed rows proportional to
the entire match set) and the partial `auth_tokens_minting_user_idx`:

1. **Covering indexes.** Both indexes above carry `count` and `bytes`, so
   aggregate queries are served from the index with no table lookup per row.
2. **Pre-aggregated platform rows.** The headline trend charts read from
   `daily_metrics_platform_idx` and cost exactly _days_ entries — independent
   of how many workspaces exist. Without this they would cost
   _days × active workspaces_ on every page load.
3. **Sparsity.** A row exists only for a (metric, day, workspace) that actually
   had activity. The leaderboard scan is therefore proportional to real
   activity, not to workspaces × window length.
4. **Cached overview.** The composed overview payload is cached in KV under a
   `metrics:` prefix (10-minute TTL, `?fresh=1` bypasses). This bounds cost by
   elapsed time rather than by page loads or refresh-mashing, and the future
   digest cron reuses the same payload. These keys are not workspace records,
   so the `mutateWorkspaceRecord` discipline that governs `ws:` keys does not
   apply — but they must stay under the `metrics:` prefix so the two never mix.

Write-path cost is constant per event (two upserts, ~2 rows read to locate the
conflict targets) and does not grow with history.

**Active workspaces needs no instrumentation of its own.** It is
`COUNT(DISTINCT workspace) WHERE metric = 'upload' AND day >= ? AND workspace != ''`,
served from `daily_metrics_window_idx`. "Active" means _uploaded at least once
in the window_ — a deliberate choice over "signed in", because uploading is the
product's actual job and sign-ins are not recorded here.

Auth-side queries need the same care: the all-time `COUNT(*)` over `user` reads
every row, and the signup grouping needs an index on `user.created_at` to stay
windowed. Both sit behind the same overview cache.

### 4. Analytics Engine

Binding `ANALYTICS` over a new `uploads_adoption` dataset. One wide data point
per upload — blobs: workspace, surface, content type, client (from the existing
provenance bag, e.g. `uploads-cli/0.30.0`), plan, repo; doubles: bytes.

Reads go through a new `apps/api/src/analytics-engine.ts`, which POSTs to
`/accounts/{id}/analytics_engine/sql` with an injectable fetch for tests and
applies `_sample_interval` multiplication to counts. It requires
`ANALYTICS_API_TOKEN` as a **worker secret** (`wrangler secret put`), distinct
from the local wrangler token in `.env`, and an account token carrying
**Account Analytics: Read**.

**The entire AE read path fails soft.** An unset token, a missing account id, or
an API error returns `{ available: false, reason }` and the panel renders an
unavailable state. The page is fully functional on D1 alone — AE is additive,
never load-bearing.

### 5. Read endpoints

- `GET /admin-ui/metrics/overview?days=30` — D1 queries and the AUTH call
  issued in parallel, whole response cached per window size.
- `GET /admin-ui/metrics/breakdown?dimension=surface&days=30` — AE-backed,
  fetched lazily by the page.
- `GET /internal/metrics` on apps/auth — signup-by-day plus totals from its own
  D1, reached over the `AUTH` service binding. Never a direct cross-database
  read.

Query functions live in `apps/api/src/adoption-queries.ts` as pure
`(db, range) => data` with no Hono or Request dependency. That is the seam a
future digest-email cron calls directly, with no HTTP hop.

### 6. Page — `/admin/metrics`

New nav entry in `AdminLayout.astro`; `AdminSection` gains `"metrics"`.
Top to bottom: stat tiles (users, workspaces, active 7d/30d, uploads, stored
bytes) → 7/30/90-day trend charts → sortable workspace table (uploads in
window, stored bytes, last active, plan, members) → lazily-loaded AE breakdown
panel with its unavailable state. New `apps/web/src/styles/admin-metrics.css`,
per the existing per-page CSS convention.

### 7. Error handling

- Recording never throws and never blocks a request; failures log structured
  JSON and continue.
- Missing `ANALYTICS` binding → writes no-op. Missing or unscoped read token →
  panel unavailable, rest of page unaffected.
- Cache read/write failures fall through to a live query.
- `/admin-ui/*` enforces `requireAdminUser` server-side; the client-side gate in
  `AdminLayout` remains a UX affordance only.

### 8. Testing

- `adoption.test.ts` — accumulation, UTC day rollover, delete deltas, D1
  failure swallowed, absent AE binding is a no-op, platform row written
  alongside the workspace row.
- `admin-ui.test.ts` additions — overview shape, admin gating, cache hit/bypass,
  AE-unavailable path.
- auth `internal-routes.test.ts` addition — signup aggregation and windowing.
- AE SQL builder unit test with a stub fetch, covering `_sample_interval`
  multiplication.

All on the existing in-process fake-D1. No new test infrastructure.

## Out of scope

- **Page views / read traffic.** Public file bytes are served straight from
  R2's public host and never reach the worker, so views cannot be counted
  without redesigning how files are served. Shipping a "views" number that
  silently counts a fraction of traffic would be worse than omitting it.
- **The digest email itself.** This design leaves the query seam; it does not
  build the email.
- **Per-user tracking** beyond signup counts.
- **Backfill.** See the decision table.

## Suggested build order

Each step leaves the tree shippable:

1. Migration + `adoption.ts` + the `putObject` hook — recording starts
   accumulating immediately, nothing reads it yet. Landing this first means the
   charts have real data by the time the page exists.
2. `adoption-queries.ts` + `/internal/metrics` on apps/auth + the overview
   endpoint and its cache.
3. The `/admin/metrics` page and nav entry — D1-backed only.
4. The AE binding, write path, read module, and breakdown panel.

## Deployment notes

- The D1 migration auto-applies on merge to main via CI; no manual wrangler
  step is owed.
- The AE dataset is created implicitly by the first `writeDataPoint`.
- `ANALYTICS_API_TOKEN` must be set with `wrangler secret put` before the
  breakdown panel reports as available. Until then the page works, minus that
  panel.
