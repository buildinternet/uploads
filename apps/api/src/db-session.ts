/**
 * D1 Sessions API wiring (issue #808, Case #02293891).
 *
 * `uploads-production` has had Cloudflare-side D1 stall incidents. Read
 * replication is one mitigation we may enable — but replicas only ever serve
 * queries issued through a `D1DatabaseSession` (`db.withSession(...)`).
 * Every plain `env.DB.prepare(...)` / `env.DB.batch(...)` call bypasses
 * sessions entirely and always goes to the primary, replicas or not.
 *
 * This module creates one Session per HTTP request (wired up in
 * `index.ts`) and `dbFor` is what every call site uses to reach it instead
 * of the raw `DB` binding. While replication stays disabled (as it is
 * today), a session-routed query still lands on the primary — behavior is
 * unchanged. Flipping replication on later needs no code change here, only
 * enabling it for the database and, if desired, revisiting the constraint
 * below.
 */

/**
 * Anything queryable via `.prepare()` / `.batch()` — either the raw `DB`
 * binding (as used in tests, and as `dbFor`'s fallback) or a per-request
 * `D1DatabaseSession`. Every function in this worker that used to take
 * `db: D1Database` now takes this instead, so it works unchanged with
 * either.
 */
export type D1Queryable = Pick<D1Database, "prepare" | "batch">;

/**
 * Creates the per-request Session, anchored with `"first-unconstrained"`:
 * the first query on the session may be served by the primary or any
 * replica (best latency), and subsequent queries on that same session stay
 * consistent with whichever instance answered the first one. We don't need
 * read-your-writes guarantees *across separate requests* today — each
 * request gets its own fresh session — so this optimizes for latency over
 * consistency.
 *
 * This is the knob to revisit once replication is actually enabled: switch
 * to `"first-primary"` if a flow needs its first query to observe its own
 * immediately-preceding write, or thread through an explicit
 * `D1SessionBookmark` if a flow needs read-your-writes across requests.
 */
export function createDbSession(db: D1Database): D1DatabaseSession {
  return db.withSession("first-unconstrained");
}

/**
 * The queryable to use for the current request: the Session set up by the
 * request-scoped middleware in `index.ts`, or the raw `DB` binding as a
 * fallback. The fallback matters for two cases — both behaviorally
 * identical to today, since replication is disabled either way: unit tests
 * that mount a route sub-app directly instead of the full `app` (so the
 * session middleware never runs), and the daily cron jobs
 * (`retention-sweep.ts`, `observability-retention.ts`'s `scheduled()`
 * caller), which aren't HTTP requests and so never get a session either.
 */
export function dbFor(env: Env): D1Queryable {
  return env.DB_SESSION ?? env.DB;
}
