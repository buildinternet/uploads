/**
 * Phase 3 webhook-driven auto-promotion (`handleWebhook`'s `pull_request`
 * handling in github-webhook.ts). Route-level HMAC/verification is covered
 * by routes/github-webhook-route.test.ts; this suite calls `handleWebhook`
 * directly (no `ctx` — see github-webhook.ts's inline-when-no-ctx fallback)
 * so every assertion below is deterministic without needing to drain a
 * `waitUntil` queue.
 */
import { describe, expect, it } from "vitest";
import { handleWebhook } from "./github-webhook";
import { attachmentsMarker } from "./github-comment-render";
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
const BRANCH = "feat-x";
const NUM = 12;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function stagedKey(filename: string): string {
  return `gh/acme/web/branch/${BRANCH}/${filename}`;
}
function destKey(filename: string): string {
  return `gh/acme/web/pull/${NUM}/${filename}`;
}

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

async function seedStaged(env: Env, filename: string) {
  const bucket = (env as unknown as { UPLOADS_DEFAULT: FakeR2Bucket }).UPLOADS_DEFAULT;
  await bucket.put(`${PREFIX}${stagedKey(filename)}`, PNG, {
    httpMetadata: { contentType: "image/png" },
  });
  await replaceFileMetadata(env.DB, WS, stagedKey(filename), {
    "gh.repo": REPO,
    "gh.kind": "branch",
    "gh.branch": BRANCH,
    "gh.staged-at": new Date().toISOString(),
  });
}

function prPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: "opened",
    repository: { full_name: REPO },
    pull_request: {
      number: NUM,
      head: { ref: BRANCH, repo: { full_name: REPO } },
    },
    ...overrides,
  };
}

function withMockPost(handler: () => Promise<void>) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    if (String(url).includes(`/issues/${NUM}/comments`)) {
      return init.method === "POST"
        ? new Response(
            JSON.stringify({ id: 9, html_url: `https://github.com/${REPO}/pull/${NUM}#c9` }),
            { status: 201 },
          )
        : new Response(JSON.stringify([]), { status: 200 });
    }
    return new Response("nf", { status: 404 });
  }) as unknown as typeof fetch;
  return handler().finally(() => {
    globalThis.fetch = realFetch;
  });
}

describe("handleWebhook pull_request auto-promotion", () => {
  it("no-ops when the repo has no binding", async () => {
    const { env } = await baseEnv();
    await handleWebhook(env, "pull_request", prPayload());
    // No throw, no comment attempt (fetch never stubbed/called) — nothing to assert beyond survival.
  });

  it("promotes staged attachments and upserts the bot comment when a binding exists", async () => {
    const { env, bucket } = await baseEnv();
    await recordRepoLink(env.DB, REPO, WS, "promote");
    await seedStaged(env, "hero.png");

    await withMockPost(() => handleWebhook(env, "pull_request", prPayload()));

    expect(bucket.store.has(`${PREFIX}${destKey("hero.png")}`)).toBe(true);
  });

  it("does not post a comment for a fork PR (head repo differs from base repo)", async () => {
    const { env, bucket } = await baseEnv();
    await recordRepoLink(env.DB, REPO, WS, "promote");
    await seedStaged(env, "hero.png");

    let fetchCalled = false;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;
    try {
      await handleWebhook(
        env,
        "pull_request",
        prPayload({
          pull_request: {
            number: NUM,
            head: { ref: BRANCH, repo: { full_name: "someone-else/fork" } },
          },
        }),
      );
    } finally {
      globalThis.fetch = realFetch;
    }
    // Promotion itself is workspace-data-only and repo-agnostic in check, but
    // the fork guard must stop everything (promote + comment) before either runs.
    expect(bucket.store.has(`${PREFIX}${destKey("hero.png")}`)).toBe(false);
    expect(fetchCalled).toBe(false);
  });

  it("cleans up the link and no-ops when the bound workspace is gone", async () => {
    const { env, db } = await baseEnv();
    await recordRepoLink(env.DB, REPO, "ghost-workspace", "promote");

    await handleWebhook(env, "pull_request", prPayload());

    expect(db.repoLinks.has(REPO)).toBe(false);
  });

  it("cleans up the link and no-ops when the bound workspace is soft-deleted", async () => {
    const { env, db } = await baseEnv();
    const registry = (env as unknown as { REGISTRY: { get: (k: string) => unknown } }).REGISTRY;
    const original = registry.get.bind(registry);
    (env as unknown as { REGISTRY: unknown }).REGISTRY = {
      get: async (key: string) => {
        const record = (await original(key)) as WorkspaceRecord | null;
        return record ? { ...record, deletedAt: new Date().toISOString() } : null;
      },
    };
    await recordRepoLink(env.DB, REPO, WS, "promote");

    await handleWebhook(env, "pull_request", prPayload());

    expect(db.repoLinks.has(REPO)).toBe(false);
  });

  it("re-promotes on synchronize", async () => {
    const { env, bucket } = await baseEnv();
    await recordRepoLink(env.DB, REPO, WS, "promote");
    await seedStaged(env, "hero.png");

    await withMockPost(() => handleWebhook(env, "pull_request", prPayload({ action: "opened" })));
    await bucket.delete(`${PREFIX}${destKey("hero.png")}`);
    await withMockPost(() =>
      handleWebhook(env, "pull_request", prPayload({ action: "synchronize" })),
    );

    expect(bucket.store.has(`${PREFIX}${destKey("hero.png")}`)).toBe(true);
  });

  it("does not create a comment on a bound PR that never had one", async () => {
    const { env } = await baseEnv();
    await recordRepoLink(env.DB, REPO, WS, "promote");

    // Empty gather (nothing staged, no galleries) + no existing marker
    // comment (the list call returns []) — patch-only-when-empty must never
    // create a comment just to say "empty".
    const calls: { method: string; url: string }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      calls.push({ method, url: String(url) });
      if (String(url).includes(`/issues/${NUM}/comments`) && method === "GET") {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;
    try {
      await handleWebhook(env, "pull_request", prPayload());
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("patches the comment to empty when the last attachment is removed on a bound PR", async () => {
    const { env } = await baseEnv();
    await recordRepoLink(env.DB, REPO, WS, "promote");

    // Empty gather (nothing staged, no galleries) but a marker comment
    // already exists on the thread — it must be rewritten to the empty
    // state, not left stale and not deleted.
    const calls: { method: string; url: string; body?: string }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      const body = typeof init.body === "string" ? init.body : undefined;
      calls.push({ method, url: String(url), body });
      if (String(url).includes(`/issues/${NUM}/comments`) && method === "GET") {
        return new Response(JSON.stringify([{ id: 9, body: `${attachmentsMarker(WS)}\nold` }]), {
          status: 200,
        });
      }
      if (String(url).includes("/issues/comments/9") && method === "PATCH") {
        return new Response(
          JSON.stringify({ id: 9, html_url: `https://github.com/${REPO}/pull/${NUM}#c9` }),
          { status: 200 },
        );
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;
    try {
      await handleWebhook(env, "pull_request", prPayload());
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(
      calls.some((c) => c.method === "PATCH" && c.body?.includes("_No attachments") === true),
    ).toBe(true);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("ignores actions outside the promote set (e.g. closed)", async () => {
    const { env, bucket } = await baseEnv();
    await recordRepoLink(env.DB, REPO, WS, "promote");
    await seedStaged(env, "hero.png");

    await handleWebhook(env, "pull_request", prPayload({ action: "closed" }));

    expect(bucket.store.has(`${PREFIX}${destKey("hero.png")}`)).toBe(false);
  });

  // Issue #326: bindings must never be mintable off an unauthenticated (HMAC-only)
  // path. The webhook consumes an existing binding (findRepoLink) and only ever
  // deletes a stale one (deleteRepoLink) — it must never create one, even for a
  // same-repo, promote-eligible PR event on a previously unbound repo.
  it("never creates a binding for an unbound repo, even on a promotable same-repo PR event", async () => {
    const { env, db } = await baseEnv();
    await seedStaged(env, "hero.png");

    await withMockPost(() => handleWebhook(env, "pull_request", prPayload({ action: "opened" })));

    expect(db.repoLinks.has(REPO)).toBe(false);
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

  it("never throws / never lets a downstream error escape", async () => {
    const { env } = await baseEnv();
    await recordRepoLink(env.DB, REPO, WS, "promote");
    await seedStaged(env, "hero.png");

    // Break promotion at the R2 layer to force an internal throw.
    const bucket = (env as unknown as { UPLOADS_DEFAULT: FakeR2Bucket }).UPLOADS_DEFAULT;
    const realGet = bucket.get.bind(bucket);
    bucket.get = (async () => {
      throw new Error("boom");
    }) as typeof bucket.get;
    try {
      await expect(handleWebhook(env, "pull_request", prPayload())).resolves.toBeUndefined();
    } finally {
      bucket.get = realGet;
    }
  });
});
