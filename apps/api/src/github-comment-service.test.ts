/// <reference types="node" />

import { describe, expect, it } from "vitest";
import { postManagedComment } from "./github-comment-service";
import { attachmentsMarker } from "./github-comment-render";
import { recordRepoLink } from "./github-repo-links";
import type { WorkspaceRecord } from "./workspace";
import { FakeR2Bucket } from "../test/fake-r2";
import { FakeKv } from "../test/fake-kv";
import { SqliteD1, database } from "../test/helpers/sqlite-d1";

const MIGRATION = [
  "migrations/20260711180000_galleries.sql",
  "migrations/20260713210559_file_metadata.sql",
  "migrations/20260720120000_github_repo_links.sql",
  "migrations/20260728120000_daily_metrics.sql",
  "migrations/20260811210000_github_private_prefixes.sql",
];
const PRAGMAS = ["PRAGMA foreign_keys = ON"];

/**
 * A workspace already bound to the repo (via `recordRepoLink`), an installed
 * App (cached in KV), and a cached installation token — mirrors the route
 * test's fixture (github-comment-route.test.ts) but exercises
 * `postManagedComment` directly, without going through HTTP/workspaceAuth.
 * Pre-binding the repo takes the "already bound to this workspace" branch of
 * `checkRepoAuthorization`, so these tests aren't about the claim-entitlement
 * gate — just the empty-state gather/upsert wiring.
 */
async function makeTestEnv() {
  const sqlite = new SqliteD1(MIGRATION, PRAGMAS);
  const bucket = new FakeR2Bucket();
  const kv = new FakeKv();
  kv.store.set("ghinst:acme/web", { value: "42" });
  kv.store.set("ghtok:42", { value: "cached-token" });
  const ws: WorkspaceRecord = {
    provider: "r2",
    bucket: "shared",
    binding: "UPLOADS_DEFAULT",
    prefix: "acme/",
    publicBaseUrl: "https://storage.uploads.sh",
  };
  const env = {
    DB: database(sqlite),
    WEB_ORIGIN: "https://uploads.test",
    UPLOADS_DEFAULT: bucket,
    GITHUB_CACHE: kv,
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY: "unused",
    GITHUB_APP_HOME_INSTALLATION_ID: "9",
  } as unknown as Env;
  await recordRepoLink(env.DB, "acme/web", "acme", "comment", 42);
  return { env, ws, workspaceName: "acme", bucket };
}

function withFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => {
    globalThis.fetch = real;
  });
}

/**
 * Every recorded adoption event writes TWO rows (per-workspace + platform
 * total, workspace = ''), by design — see 20260728120000_daily_metrics.sql.
 * Mirrors the query style in github-repo-links-sqlite.test.ts.
 */
async function commentPostedRows(db: D1Database): Promise<{ workspace: string }[]> {
  const { results } = await db
    .prepare(`SELECT workspace FROM daily_metrics WHERE metric = 'comment_posted'`)
    .all<{ workspace: string }>();
  return results;
}

describe("postManagedComment actor-on-PR gate (issue #297 control 2)", () => {
  /**
   * Seeds the two KV caches the gate reads (`ghacct:` identity, `pr-actors:`
   * thread actors) so no AUTH/GitHub round-trips happen — these tests are
   * about the gate's decision table, not the resolution chains (covered in
   * uploader-identity / github-app tests).
   */
  function seedActorCaches(env: Env, opts: { accountId?: string; actors?: number[] }) {
    const kv = (env as unknown as { GITHUB_CACHE: FakeKv }).GITHUB_CACHE;
    if (opts.accountId) kv.store.set("ghacct:user_1", { value: opts.accountId });
    if (opts.actors)
      kv.store.set("pr-actors:pull:acme/web:12", { value: JSON.stringify(opts.actors) });
  }

  /** Comment flow stub: marker comment 99 exists and can be patched. */
  const commentFlowFetch = (async (url: string, init: RequestInit = {}) => {
    if (String(url).includes("/issues/12/comments") && init.method !== "POST") {
      return new Response(JSON.stringify([{ id: 99, body: `${attachmentsMarker("acme")}\nold` }]), {
        status: 200,
      });
    }
    if (String(url).includes("/issues/comments/99")) {
      return new Response(
        JSON.stringify({ id: 99, html_url: "https://github.com/acme/web/pull/12#c99" }),
        { status: 200 },
      );
    }
    return new Response("nf", { status: 404 });
  }) as unknown as typeof fetch;

  const TARGET = { repo: "acme/web", num: 12, kind: "pull" as const };

  it("declines (actor_not_authorized) when opted in and the caller is not on the thread", async () => {
    const { env, ws, workspaceName } = await makeTestEnv();
    ws.githubCommentRequireActorOnPr = true;
    seedActorCaches(env, { accountId: "500", actors: [1, 2] });
    const r = await withFetch(commentFlowFetch, () =>
      postManagedComment(env, ws, workspaceName, "user_1", TARGET),
    );
    expect(r).toMatchObject({ posted: false, reason: "actor_not_authorized" });
    // Declined before gather/upsert — nothing recorded.
    expect(await commentPostedRows(env.DB)).toHaveLength(0);
  });

  it("posts when opted in and the caller is an actor on the thread", async () => {
    const { env, ws, workspaceName } = await makeTestEnv();
    ws.githubCommentRequireActorOnPr = true;
    seedActorCaches(env, { accountId: "500", actors: [500, 2] });
    const r = await withFetch(commentFlowFetch, () =>
      postManagedComment(env, ws, workspaceName, "user_1", TARGET),
    );
    expect(r).toMatchObject({ posted: true, action: "updated" });
  });

  it("skips the check when the token carries no identity (opted in)", async () => {
    const { env, ws, workspaceName } = await makeTestEnv();
    ws.githubCommentRequireActorOnPr = true;
    seedActorCaches(env, { actors: [1, 2] });
    const r = await withFetch(commentFlowFetch, () =>
      postManagedComment(env, ws, workspaceName, null, TARGET),
    );
    expect(r).toMatchObject({ posted: true, action: "updated" });
  });

  it("skips the check when the actor lookup fails (opted in, degrade-safe)", async () => {
    const { env, ws, workspaceName } = await makeTestEnv();
    ws.githubCommentRequireActorOnPr = true;
    // Identity resolves, but no pr-actors cache and the pulls fetch 502s →
    // fetchPrActors returns null → allow.
    seedActorCaches(env, { accountId: "500" });
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      if (String(url).includes("/pulls/12")) return new Response("", { status: 502 });
      return (commentFlowFetch as (u: string, i?: RequestInit) => Promise<Response>)(
        String(url),
        init,
      );
    }) as unknown as typeof fetch;
    const r = await withFetch(fetchImpl, () =>
      postManagedComment(env, ws, workspaceName, "user_1", TARGET),
    );
    expect(r).toMatchObject({ posted: true, action: "updated" });
  });

  it("allows (log-only dry-run) when NOT opted in and the caller is not on the thread", async () => {
    const { env, ws, workspaceName } = await makeTestEnv();
    seedActorCaches(env, { accountId: "500", actors: [1, 2] });
    const r = await withFetch(commentFlowFetch, () =>
      postManagedComment(env, ws, workspaceName, "user_1", TARGET),
    );
    expect(r).toMatchObject({ posted: true, action: "updated" });

    // issue #579: the dry-run decline records an adoption event — one
    // per-workspace row and one platform-total row, same two-row shape as
    // comment_posted (never zero, never duplicated) — so /admin/metrics can
    // show would-decline volume as a revisit trigger.
    const { results: dryrunRows } = await env.DB.prepare(
      `SELECT workspace FROM daily_metrics WHERE metric = 'comment_actor_dryrun_decline'`,
    ).all<{ workspace: string }>();
    expect(dryrunRows).toHaveLength(2);
    expect(dryrunRows.map((row) => row.workspace).sort()).toEqual(["", "acme"]);
  });
});

describe("postManagedComment empty-state (issue #392 stretch)", () => {
  it("empties an existing comment (updated, count 0) when all media is removed", async () => {
    const { env, ws, workspaceName } = await makeTestEnv();
    // No objects in the bucket and no galleries — gathered.count will be 0 —
    // but a marker comment already exists on the thread.
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      if (String(url).includes("/issues/12/comments")) {
        if (init.method === "POST") throw new Error("must not create");
        return new Response(
          JSON.stringify([{ id: 99, body: `${attachmentsMarker("acme")}\nold` }]),
          { status: 200 },
        );
      }
      if (String(url).includes("/issues/comments/99")) {
        return new Response(
          JSON.stringify({ id: 99, html_url: "https://github.com/acme/web/pull/12#c99" }),
          { status: 200 },
        );
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;

    const r = await withFetch(fetchImpl, () =>
      postManagedComment(env, ws, workspaceName, "user_1", {
        repo: "acme/web",
        num: 12,
        kind: "pull",
      }),
    );
    expect(r).toMatchObject({ posted: true, action: "updated", count: 0 });

    // comment_posted wiring (issue: locking in the convergence-point call):
    // one posted event writes two rows — the per-workspace row and the
    // platform total (workspace = '') — never zero, never duplicated.
    const rows = await commentPostedRows(env.DB);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.workspace).sort()).toEqual(["", "acme"]);
  });

  it("no-ops (skipped) when empty and no comment exists", async () => {
    const { env, ws, workspaceName } = await makeTestEnv();
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      if (String(url).includes("/issues/13/comments")) {
        if (init.method === "POST") throw new Error("must not create");
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;

    const r = await withFetch(fetchImpl, () =>
      postManagedComment(env, ws, workspaceName, "user_1", {
        repo: "acme/web",
        num: 13,
        kind: "pull",
      }),
    );
    expect(r).toMatchObject({ posted: true, action: "skipped", count: 0 });

    // The "skipped" early return must precede the comment_posted call —
    // nothing was actually posted, so nothing should be recorded.
    expect(await commentPostedRows(env.DB)).toHaveLength(0);
  });
});
