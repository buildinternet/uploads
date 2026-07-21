/**
 * Issue #291: `issue_comment` webhook reconcile (`handleWebhook`'s
 * `issue_comment` handling in github-webhook.ts). Mirrors
 * github-webhook-auto-promote.test.ts's structure/fakes — calls
 * `handleWebhook` directly (no `ctx`) so assertions are deterministic
 * without draining a `waitUntil` queue.
 */
import { describe, expect, it } from "vitest";
import { handleWebhook } from "./github-webhook";
import { recordRepoLink } from "./github-repo-links";
import { replaceFileMetadata } from "./file-metadata";
import { sha256Hex, type WorkspaceRecord } from "./workspace";
import { FakeKv } from "../test/fake-kv";
import { FakeR2Bucket } from "../test/fake-r2";
import { UsageFakeD1 } from "../test/usage-fake-d1";
import { GITHUB_APP_CFG_ENV } from "../test/github-app-env";

const WS = "acme";
const PREFIX = "acme/";
const REPO = "acme/web";
const NUM = 12;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const MARKER_BODY = "before\n<!-- uploads.sh:attachments ws=acme -->\nstuff";

async function baseEnv(): Promise<{ env: Env; db: UsageFakeD1; bucket: FakeR2Bucket }> {
  const record: WorkspaceRecord = {
    provider: "r2",
    bucket: "b",
    binding: "UPLOADS_DEFAULT",
    prefix: PREFIX,
    publicBaseUrl: "https://storage.uploads.sh",
    tokens: [{ hash: await sha256Hex("unused"), createdAt: new Date().toISOString() }],
  };
  const registry = {
    get: (async (key: string) =>
      key === `ws:${WS}` ? record : null) as unknown as KVNamespace["get"],
  };
  const bucket = new FakeR2Bucket();
  const db = new UsageFakeD1();
  const githubCache = new FakeKv();
  githubCache.store.set("ghinst:acme/web", { value: "42" });
  githubCache.store.set("ghtok:42", { value: "cached-token" });
  const env = {
    REGISTRY: registry,
    DB: db,
    UPLOADS_DEFAULT: bucket,
    GITHUB_CACHE: githubCache,
    ...GITHUB_APP_CFG_ENV,
  } as unknown as Env;
  return { env, db, bucket };
}

async function seedAttachment(env: Env, filename: string) {
  const bucket = (env as unknown as { UPLOADS_DEFAULT: FakeR2Bucket }).UPLOADS_DEFAULT;
  await bucket.put(`${PREFIX}gh/acme/web/issues/${NUM}/${filename}`, PNG, {
    httpMetadata: { contentType: "image/png" },
  });
  await replaceFileMetadata(env.DB, WS, `gh/acme/web/issues/${NUM}/${filename}`, {
    "gh.repo": REPO,
    "gh.kind": "issues",
    "gh.num": String(NUM),
  });
}

function issueCommentPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: "deleted",
    repository: { full_name: REPO },
    issue: { number: NUM },
    comment: { body: MARKER_BODY, user: { login: "uploads-sh[bot]", type: "Bot" } },
    sender: { login: "someone", type: "User" },
    ...overrides,
  };
}

function withMockGithub(handler: () => Promise<void>) {
  const realFetch = globalThis.fetch;
  let postCalled = false;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    if (String(url).includes(`/issues/${NUM}/comments`)) {
      if (init.method === "POST") {
        postCalled = true;
        return new Response(
          JSON.stringify({ id: 9, html_url: `https://github.com/${REPO}/issues/${NUM}#c9` }),
          { status: 201 },
        );
      }
      return new Response(JSON.stringify([]), { status: 200 });
    }
    return new Response("nf", { status: 404 });
  }) as unknown as typeof fetch;
  return handler()
    .then(() => postCalled)
    .finally(() => {
      globalThis.fetch = realFetch;
    });
}

describe("handleWebhook issue_comment reconcile", () => {
  it("reconciles (recreates the comment) on a bot-authored deletion of the marker comment", async () => {
    const { env } = await baseEnv();
    await recordRepoLink(env.DB, REPO, WS, "promote");
    await seedAttachment(env, "hero.png");

    const postCalled = await withMockGithub(() =>
      handleWebhook(env, "issue_comment", issueCommentPayload()),
    );
    expect(postCalled).toBe(true);
  });

  it("reconciles on an edit that still carries the marker (non-bot sender)", async () => {
    const { env } = await baseEnv();
    await recordRepoLink(env.DB, REPO, WS, "promote");
    await seedAttachment(env, "hero.png");

    const postCalled = await withMockGithub(() =>
      handleWebhook(env, "issue_comment", issueCommentPayload({ action: "edited" })),
    );
    expect(postCalled).toBe(true);
  });

  it("ignores an ordinary human comment (created, no marker)", async () => {
    const { env } = await baseEnv();
    await recordRepoLink(env.DB, REPO, WS, "promote");

    let fetchCalled = false;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;
    try {
      await handleWebhook(
        env,
        "issue_comment",
        issueCommentPayload({
          action: "created",
          comment: { body: "just chatting", user: { login: "someone", type: "User" } },
        }),
      );
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(fetchCalled).toBe(false);
  });

  it("ignores a deleted comment authored by a human, even if it happens to include the marker text", async () => {
    const { env } = await baseEnv();
    await recordRepoLink(env.DB, REPO, WS, "promote");

    let fetchCalled = false;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;
    try {
      await handleWebhook(
        env,
        "issue_comment",
        issueCommentPayload({
          comment: { body: MARKER_BODY, user: { login: "human", type: "User" } },
        }),
      );
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(fetchCalled).toBe(false);
  });

  it("does not re-trigger off its own edit (sender is a bot) — loop guard", async () => {
    const { env } = await baseEnv();
    await recordRepoLink(env.DB, REPO, WS, "promote");
    await seedAttachment(env, "hero.png");

    let fetchCalled = false;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;
    try {
      await handleWebhook(
        env,
        "issue_comment",
        issueCommentPayload({
          action: "edited",
          sender: { login: "uploads-sh[bot]", type: "Bot" },
        }),
      );
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(fetchCalled).toBe(false);
  });

  it("no-ops when the repo has no binding", async () => {
    const { env } = await baseEnv();

    let fetchCalled = false;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;
    try {
      await handleWebhook(env, "issue_comment", issueCommentPayload());
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(fetchCalled).toBe(false);
  });

  it("invalidates the stale cached comment id before re-hunting, so a deleted comment id isn't reused", async () => {
    const { env } = await baseEnv();
    await recordRepoLink(env.DB, REPO, WS, "promote");
    await seedAttachment(env, "hero.png");
    const githubCache = (env as unknown as { GITHUB_CACHE: FakeKv }).GITHUB_CACHE;
    githubCache.store.set(`ghcomment:${WS}:${REPO.toLowerCase()}#${NUM}`, { value: "stale-id" });

    let patchCalled = false;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
      if (String(url).includes(`/issues/comments/stale-id`)) {
        patchCalled = true;
        return new Response("nf", { status: 404 });
      }
      if (String(url).includes(`/issues/${NUM}/comments`)) {
        if (init.method === "POST") {
          return new Response(
            JSON.stringify({ id: 9, html_url: `https://github.com/${REPO}/issues/${NUM}#c9` }),
            { status: 201 },
          );
        }
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;
    try {
      await handleWebhook(env, "issue_comment", issueCommentPayload());
    } finally {
      globalThis.fetch = realFetch;
    }
    // The cache was pre-invalidated by reconcile, so upsertBotComment never
    // even attempts the stale-id PATCH — it goes straight to the marker hunt.
    expect(patchCalled).toBe(false);
  });

  it("never throws / never lets a downstream error escape", async () => {
    const { env } = await baseEnv();
    await recordRepoLink(env.DB, REPO, WS, "promote");
    await seedAttachment(env, "hero.png");

    const bucket = (env as unknown as { UPLOADS_DEFAULT: FakeR2Bucket }).UPLOADS_DEFAULT;
    const realGet = bucket.get.bind(bucket);
    bucket.get = (async () => {
      throw new Error("boom");
    }) as typeof bucket.get;
    try {
      await expect(
        handleWebhook(env, "issue_comment", issueCommentPayload()),
      ).resolves.toBeUndefined();
    } finally {
      bucket.get = realGet;
    }
  });

  it("does not import any binding-write helper (recordRepoLink/setRepoLink) — read/delete only", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath, URL: NodeURL } = await import("node:url");
    const src = readFileSync(
      fileURLToPath(new NodeURL("./github-webhook.ts", import.meta.url)),
      "utf8",
    );
    expect(src).not.toMatch(/recordRepoLink/);
    expect(src).not.toMatch(/setRepoLink/);
  });
});
