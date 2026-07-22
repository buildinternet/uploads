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
  });
});
