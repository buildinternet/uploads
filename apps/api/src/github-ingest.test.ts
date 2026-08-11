/**
 * Task 4 of the GitHub attachment ingestion feature (spec
 * docs/superpowers/specs/2026-08-11-github-attachment-ingestion-design.md):
 * the reconcile core + fetch/store pipeline. `reconcileIngestSource` is
 * exercised directly via the `IngestDeps` seams (no module mocking needed);
 * `ingestForWebhook` additionally exercises `resolveRepoCommentOptions`
 * (repo-comment-config.ts), which is not fetch-seamed, so those tests swap
 * `globalThis.fetch` for the duration of the call (repo-comment-config.test.ts
 * style) in addition to passing the same fake as `deps.fetchImpl`.
 */
import { InsufficientStorageError } from "@uploads/errors";
import { describe, expect, it, vi } from "vitest";
import { attachmentKeyBasename } from "./github-attachment-extract";
import {
  ingestForWebhook,
  reconcileIngestSource,
  reconcileIngestTarget,
  type IngestSourceRef,
} from "./github-ingest";
import { ledgerRow, ledgerRowsForSource, recordIngestedAsset } from "./github-ingest-ledger";
import { setLedgerDetached } from "./github-ingest-ledger";
import { getFileMetadata, replaceFileMetadata } from "./file-metadata";
import { recordRepoLink } from "./github-repo-links";
import type { WorkspaceRecord } from "./workspace";
import { FakeKv } from "../test/fake-kv";
import { GITHUB_APP_CFG_ENV } from "../test/github-app-env";
import { UsageFakeD1 } from "../test/usage-fake-d1";

const REPO = "acme/app";
const WS = "acme";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const ASSET_ID = "assets/11111111-1111-1111-1111-111111111111";
const ASSET_URL = `https://github.com/user-attachments/${ASSET_ID}`;
const KEY = `gh/acme-app/pull-7/${attachmentKeyBasename(ASSET_ID)}.png`;

const ws = {} as WorkspaceRecord;

function baseEnv(): { env: Env; db: UsageFakeD1; kv: FakeKv } {
  const db = new UsageFakeD1();
  const kv = new FakeKv();
  kv.store.set("ghinst:acme/app", { value: "42" });
  kv.store.set("ghtok:42", { value: "ghs_test" });
  const env = {
    DB: db,
    GITHUB_CACHE: kv,
    ...GITHUB_APP_CFG_ENV,
  } as unknown as Env;
  return { env, db, kv };
}

function withRegistry(env: Env, record: WorkspaceRecord): Env {
  const registry = {
    get: (async (key: string) =>
      key === `ws:${WS}` ? record : null) as unknown as KVNamespace["get"],
  };
  return { ...env, REGISTRY: registry } as unknown as Env;
}

/** Matches routes by substring against the requested URL, like repo-comment-config.test.ts's fakeFetch. */
function fakeFetch(routes: Record<string, (init: RequestInit) => Response | Promise<Response>>) {
  return (async (url: string, init: RequestInit = {}) => {
    for (const [pattern, handler] of Object.entries(routes)) {
      if (String(url).includes(pattern)) return handler(init);
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

function pngRoute(): Response {
  return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
}

function spyPut() {
  const calls: Array<{
    key: string;
    bytes: Uint8Array;
    workspaceName: string;
    opts?: Record<string, unknown>;
  }> = [];
  const putImpl = vi.fn(
    async (
      _env: Env,
      _ws: WorkspaceRecord,
      key: string,
      bytes: Uint8Array,
      workspaceName: string,
      opts?: Record<string, unknown>,
    ) => {
      calls.push({ key, bytes, workspaceName, opts });
      return {
        key,
        size: bytes.length,
        contentType: "image/png",
        replaced: false,
        url: null,
        embedUrl: null,
      };
    },
  );
  return { putImpl: putImpl as unknown as typeof import("./files-core").putObject, calls };
}

async function withGlobalFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

describe("reconcileIngestSource", () => {
  it("new asset in body: put + ledger row + metadata stamped", async () => {
    const { env } = baseEnv();
    const fetchImpl = fakeFetch({ [ASSET_ID]: pngRoute });
    const { putImpl, calls } = spyPut();
    const ref: IngestSourceRef = { repo: REPO, kind: "pull", num: 7, source: "body" };

    const summary = await reconcileIngestSource(env, ws, WS, ref, `see ${ASSET_URL}`, "octocat", {
      fetchImpl,
      putImpl,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.key).toBe(KEY);
    expect(calls[0]!.workspaceName).toBe(WS);
    expect(calls[0]!.opts?.metadata).toEqual({
      "gh.repo": "acme/app",
      "gh.kind": "pull",
      "gh.number": "7",
      "gh.origin": "github",
      "gh.author": "octocat",
      "gh.detached": "false",
      "gh.source": "body",
    });
    expect(calls[0]!.opts?.surface).toBe("github");
    expect(calls[0]!.opts?.replace).toBe(true);

    expect(summary).toEqual({ ingested: [KEY], reattached: [], detached: [], skipped: [] });

    const row = await ledgerRow(env.DB, REPO, ASSET_ID);
    expect(row).not.toBeNull();
    expect(row?.detachedAt).toBeNull();
    expect(row?.objectKey).toBe(KEY);
  });

  it("already-ledgered asset: no re-fetch, no put", async () => {
    const { env } = baseEnv();
    const ref: IngestSourceRef = { repo: REPO, kind: "pull", num: 7, source: "body" };
    await recordIngestedAsset(env.DB, {
      repo: REPO,
      assetId: ASSET_ID,
      workspace: WS,
      objectKey: KEY,
      kind: "pull",
      num: 7,
      source: "body",
      createdAt: new Date().toISOString(),
    });
    const fetchImpl = vi.fn(fakeFetch({ [ASSET_ID]: pngRoute }));
    const { putImpl, calls } = spyPut();

    const summary = await reconcileIngestSource(env, ws, WS, ref, `see ${ASSET_URL}`, "octocat", {
      fetchImpl,
      putImpl,
    });

    expect(calls).toHaveLength(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(summary).toEqual({ ingested: [], reattached: [], detached: [], skipped: [] });
  });

  it("removed from text: detaches the ledger row and flips gh.detached", async () => {
    const { env } = baseEnv();
    const ref: IngestSourceRef = { repo: REPO, kind: "pull", num: 7, source: "body" };
    await recordIngestedAsset(env.DB, {
      repo: REPO,
      assetId: ASSET_ID,
      workspace: WS,
      objectKey: KEY,
      kind: "pull",
      num: 7,
      source: "body",
      createdAt: new Date().toISOString(),
    });
    await replaceFileMetadata(env.DB, WS, KEY, { "gh.detached": "false" });

    const summary = await reconcileIngestSource(env, ws, WS, ref, "no attachment here", null, {});

    expect(summary).toEqual({ ingested: [], reattached: [], detached: [KEY], skipped: [] });
    const row = await ledgerRow(env.DB, REPO, ASSET_ID);
    expect(row?.detachedAt).not.toBeNull();
    const meta = await getFileMetadata(env.DB, WS, KEY);
    expect(meta["gh.detached"]).toBe("true");
  });

  it("re-added after detach: reattaches without re-fetching or re-putting", async () => {
    const { env } = baseEnv();
    const ref: IngestSourceRef = { repo: REPO, kind: "pull", num: 7, source: "body" };
    await recordIngestedAsset(env.DB, {
      repo: REPO,
      assetId: ASSET_ID,
      workspace: WS,
      objectKey: KEY,
      kind: "pull",
      num: 7,
      source: "body",
      createdAt: new Date().toISOString(),
    });
    await setLedgerDetached(env.DB, REPO, ASSET_ID, new Date().toISOString());
    await replaceFileMetadata(env.DB, WS, KEY, { "gh.detached": "true" });
    const { putImpl, calls } = spyPut();

    const summary = await reconcileIngestSource(env, ws, WS, ref, `see ${ASSET_URL}`, "octocat", {
      putImpl,
    });

    expect(calls).toHaveLength(0);
    expect(summary).toEqual({ ingested: [], reattached: [KEY], detached: [], skipped: [] });
    const row = await ledgerRow(env.DB, REPO, ASSET_ID);
    expect(row?.detachedAt).toBeNull();
    const meta = await getFileMetadata(env.DB, WS, KEY);
    expect(meta["gh.detached"]).toBe("false");
  });

  it("text: null (comment deleted) detaches only that source's rows", async () => {
    const { env } = baseEnv();
    const ref: IngestSourceRef = { repo: REPO, kind: "issues", num: 3, source: "comment:9" };
    const key1 = "gh/acme-app/issues-3/asset-one.png";
    const key2 = "gh/acme-app/issues-3/asset-two.png";
    await recordIngestedAsset(env.DB, {
      repo: REPO,
      assetId: "assets/one",
      workspace: WS,
      objectKey: key1,
      kind: "issues",
      num: 3,
      source: "comment:9",
      createdAt: new Date().toISOString(),
    });
    await recordIngestedAsset(env.DB, {
      repo: REPO,
      assetId: "assets/two",
      workspace: WS,
      objectKey: key2,
      kind: "issues",
      num: 3,
      source: "body",
      createdAt: new Date().toISOString(),
    });
    await replaceFileMetadata(env.DB, WS, key1, { "gh.detached": "false" });
    await replaceFileMetadata(env.DB, WS, key2, { "gh.detached": "false" });

    const summary = await reconcileIngestSource(env, ws, WS, ref, null, null, {});

    expect(summary.detached).toEqual([key1]);
    expect((await ledgerRow(env.DB, REPO, "assets/one"))?.detachedAt).not.toBeNull();
    expect((await ledgerRow(env.DB, REPO, "assets/two"))?.detachedAt).toBeNull();
  });

  it("guard skip: unsupported media type is a permanent skip (no put, no ledger row, no throw)", async () => {
    const { env } = baseEnv();
    const ref: IngestSourceRef = { repo: REPO, kind: "pull", num: 7, source: "body" };
    const fetchImpl = fakeFetch({
      [ASSET_ID]: () =>
        new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }),
    });
    const { putImpl, calls } = spyPut();

    const summary = await reconcileIngestSource(env, ws, WS, ref, `see ${ASSET_URL}`, null, {
      fetchImpl,
      putImpl,
    });

    expect(calls).toHaveLength(0);
    expect(summary.skipped).toEqual([{ url: ASSET_URL, reason: "unsupported_media_type" }]);
    expect(await ledgerRow(env.DB, REPO, ASSET_ID)).toBeNull();
  });

  it("guard skip: asset 404 is a permanent skip", async () => {
    const { env } = baseEnv();
    const ref: IngestSourceRef = { repo: REPO, kind: "pull", num: 7, source: "body" };
    const fetchImpl = fakeFetch({ [ASSET_ID]: () => new Response("nf", { status: 404 }) });

    const summary = await reconcileIngestSource(env, ws, WS, ref, `see ${ASSET_URL}`, null, {
      fetchImpl,
    });

    expect(summary.skipped).toEqual([{ url: ASSET_URL, reason: "asset_not_found" }]);
    expect(await ledgerRow(env.DB, REPO, ASSET_ID)).toBeNull();
  });

  it("oversize asset: too_large skip, no put", async () => {
    const { env } = baseEnv();
    const smallWs = { maxUploadBytes: 4 } as WorkspaceRecord;
    const ref: IngestSourceRef = { repo: REPO, kind: "pull", num: 7, source: "body" };
    const fetchImpl = fakeFetch({ [ASSET_ID]: pngRoute });
    const { putImpl, calls } = spyPut();

    const summary = await reconcileIngestSource(env, smallWs, WS, ref, `see ${ASSET_URL}`, null, {
      fetchImpl,
      putImpl,
    });

    expect(calls).toHaveLength(0);
    expect(summary.skipped).toEqual([{ url: ASSET_URL, reason: "too_large" }]);
    expect(await ledgerRow(env.DB, REPO, ASSET_ID)).toBeNull();
  });

  it("budget-code putImpl error is a skip; a plain error rethrows", async () => {
    const { env } = baseEnv();
    const ref: IngestSourceRef = { repo: REPO, kind: "pull", num: 7, source: "body" };
    const fetchImpl = fakeFetch({ [ASSET_ID]: pngRoute });

    const budgetPut = vi.fn(async () => {
      throw new InsufficientStorageError("storage quota exceeded", {
        code: "storage_quota_exceeded",
      });
    }) as unknown as typeof import("./files-core").putObject;

    const summary = await reconcileIngestSource(env, ws, WS, ref, `see ${ASSET_URL}`, null, {
      fetchImpl,
      putImpl: budgetPut,
    });
    expect(summary.skipped).toEqual([{ url: ASSET_URL, reason: "storage_quota_exceeded" }]);
    expect(await ledgerRow(env.DB, REPO, ASSET_ID)).toBeNull();

    const boomPut = vi.fn(async () => {
      throw new Error("boom");
    }) as unknown as typeof import("./files-core").putObject;
    await expect(
      reconcileIngestSource(env, ws, WS, ref, `see ${ASSET_URL}`, null, {
        fetchImpl,
        putImpl: boomPut,
      }),
    ).rejects.toThrow("boom");
  });

  it("transient asset fetch (503) throws instead of skipping", async () => {
    const { env } = baseEnv();
    const ref: IngestSourceRef = { repo: REPO, kind: "pull", num: 7, source: "body" };
    const fetchImpl = fakeFetch({ [ASSET_ID]: () => new Response("err", { status: 503 }) });

    await expect(
      reconcileIngestSource(env, ws, WS, ref, `see ${ASSET_URL}`, null, { fetchImpl }),
    ).rejects.toThrow();
  });

  /**
   * Wraps `env.DB` so the FIRST `.run()` on a statement whose normalized SQL
   * contains `sqlSubstring` throws, then behaves normally forever after —
   * simulating a transient D1 failure on exactly one write (e.g. the ledger
   * UPDATE) without disturbing any other statement. Used by the retry-safety
   * regression tests below: metadata-first ordering means a ledger-write
   * failure must leave the ledger guard seeing pre-write state, so a second
   * reconcile call redoes (idempotently) both writes and reaches a fully
   * consistent end state.
   */
  function failOnceOn(db: Env["DB"], sqlSubstring: string): Env["DB"] {
    let armed = true;
    const originalPrepare = db.prepare.bind(db);
    return {
      ...db,
      prepare: (sql: string) => {
        const stmt = originalPrepare(sql);
        if (!sql.replace(/\s+/g, " ").includes(sqlSubstring)) return stmt;
        return {
          ...stmt,
          bind: (...args: unknown[]) => {
            const bound = stmt.bind(...args);
            return {
              ...bound,
              run: async () => {
                if (armed) {
                  armed = false;
                  throw new Error("transient D1 failure");
                }
                return bound.run();
              },
            };
          },
        };
      },
    } as unknown as Env["DB"];
  }

  it("retry-safe reattach: ledger write fails first, retry reaches consistent state", async () => {
    const { env } = baseEnv();
    const ref: IngestSourceRef = { repo: REPO, kind: "pull", num: 7, source: "body" };
    await recordIngestedAsset(env.DB, {
      repo: REPO,
      assetId: ASSET_ID,
      workspace: WS,
      objectKey: KEY,
      kind: "pull",
      num: 7,
      source: "body",
      createdAt: new Date().toISOString(),
    });
    await setLedgerDetached(env.DB, REPO, ASSET_ID, new Date().toISOString());
    await replaceFileMetadata(env.DB, WS, KEY, { "gh.detached": "true" });

    const flakyDb = failOnceOn(env.DB, "UPDATE github_ingested_assets SET detached_at");
    const flakyEnv = { ...env, DB: flakyDb } as unknown as Env;

    await expect(
      reconcileIngestSource(flakyEnv, ws, WS, ref, `see ${ASSET_URL}`, "octocat", {}),
    ).rejects.toThrow("transient D1 failure");

    // Metadata-first: the metadata write landed even though the call
    // rejected, but the ledger row is still marked detached — the guard
    // will see stale state and redo both writes on retry.
    expect((await getFileMetadata(env.DB, WS, KEY))["gh.detached"]).toBe("false");
    expect((await ledgerRow(env.DB, REPO, ASSET_ID))?.detachedAt).not.toBeNull();

    const summary = await reconcileIngestSource(
      flakyEnv,
      ws,
      WS,
      ref,
      `see ${ASSET_URL}`,
      "octocat",
      {},
    );

    expect(summary).toEqual({ ingested: [], reattached: [KEY], detached: [], skipped: [] });
    const row = await ledgerRow(env.DB, REPO, ASSET_ID);
    expect(row?.detachedAt).toBeNull();
    const meta = await getFileMetadata(env.DB, WS, KEY);
    expect(meta["gh.detached"]).toBe("false");
  });

  it("retry-safe detach: ledger write fails first, retry reaches consistent state", async () => {
    const { env } = baseEnv();
    const ref: IngestSourceRef = { repo: REPO, kind: "pull", num: 7, source: "body" };
    await recordIngestedAsset(env.DB, {
      repo: REPO,
      assetId: ASSET_ID,
      workspace: WS,
      objectKey: KEY,
      kind: "pull",
      num: 7,
      source: "body",
      createdAt: new Date().toISOString(),
    });
    await replaceFileMetadata(env.DB, WS, KEY, { "gh.detached": "false" });

    const flakyDb = failOnceOn(env.DB, "UPDATE github_ingested_assets SET detached_at");
    const flakyEnv = { ...env, DB: flakyDb } as unknown as Env;

    await expect(
      reconcileIngestSource(flakyEnv, ws, WS, ref, "no attachment here", null, {}),
    ).rejects.toThrow("transient D1 failure");

    // Metadata-first: the metadata write landed even though the call
    // rejected, but the ledger row is still attached — the guard will see
    // stale state and redo both writes on retry.
    expect((await getFileMetadata(env.DB, WS, KEY))["gh.detached"]).toBe("true");
    expect((await ledgerRow(env.DB, REPO, ASSET_ID))?.detachedAt).toBeNull();

    const summary = await reconcileIngestSource(
      flakyEnv,
      ws,
      WS,
      ref,
      "no attachment here",
      null,
      {},
    );

    expect(summary).toEqual({ ingested: [], reattached: [], detached: [KEY], skipped: [] });
    const row = await ledgerRow(env.DB, REPO, ASSET_ID);
    expect(row?.detachedAt).not.toBeNull();
    const meta = await getFileMetadata(env.DB, WS, KEY);
    expect(meta["gh.detached"]).toBe("true");
  });
});

describe("ingestForWebhook", () => {
  it("no repo link: resolves, no fetches", async () => {
    const { env: base } = baseEnv();
    const env = withRegistry(base, { provider: "r2", bucket: "b" } as WorkspaceRecord);
    const fetchImpl = vi.fn(fakeFetch({}));
    const ref: IngestSourceRef = { repo: REPO, kind: "pull", num: 7, source: "body" };

    await expect(ingestForWebhook(env, ref, { fetchImpl })).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("link + workspace but knob false: resolves without fetching the issue body or asset", async () => {
    const { env: base } = baseEnv();
    const env = withRegistry(base, { provider: "r2", bucket: "b" } as WorkspaceRecord);
    await recordRepoLink(env.DB, REPO, WS, "test");
    const calls: string[] = [];
    const impl = ((url: string, init: RequestInit = {}) => {
      calls.push(String(url));
      return fakeFetch({ "/contents/": () => new Response("nf", { status: 404 }) })(url, init);
    }) as unknown as typeof fetch;
    const ref: IngestSourceRef = { repo: REPO, kind: "pull", num: 7, source: "body" };

    await withGlobalFetch(impl, () => ingestForWebhook(env, ref, { fetchImpl: impl }));

    expect(calls.some((u) => u.includes("/issues/7") || u.includes(ASSET_ID))).toBe(false);
  });

  it("knob true: fetches the issue body, puts, ledgers", async () => {
    const { env: base } = baseEnv();
    const env = withRegistry(base, {
      provider: "r2",
      bucket: "b",
      githubIngestAttachments: true,
    } as WorkspaceRecord);
    await recordRepoLink(env.DB, REPO, WS, "test");
    const impl = fakeFetch({
      "/contents/": () => new Response("nf", { status: 404 }),
      "/repos/acme/app/issues/7": () =>
        new Response(JSON.stringify({ body: `see ${ASSET_URL}`, user: { login: "octocat" } }), {
          status: 200,
        }),
      [ASSET_ID]: pngRoute,
    });
    const { putImpl, calls } = spyPut();
    const ref: IngestSourceRef = { repo: REPO, kind: "pull", num: 7, source: "body" };

    await withGlobalFetch(impl, () => ingestForWebhook(env, ref, { fetchImpl: impl, putImpl }));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.key).toBe(KEY);
    const row = await ledgerRow(env.DB, REPO, ASSET_ID);
    expect(row).not.toBeNull();
  });

  it("comment source 404: reconciles with text null (detach-all), not a throw", async () => {
    const { env: base } = baseEnv();
    const env = withRegistry(base, {
      provider: "r2",
      bucket: "b",
      githubIngestAttachments: true,
    } as WorkspaceRecord);
    await recordRepoLink(env.DB, REPO, WS, "test");
    const key = "gh/acme-app/issues-3/asset-one.png";
    await recordIngestedAsset(env.DB, {
      repo: REPO,
      assetId: "assets/one",
      workspace: WS,
      objectKey: key,
      kind: "issues",
      num: 3,
      source: "comment:44",
      createdAt: new Date().toISOString(),
    });
    await replaceFileMetadata(env.DB, WS, key, { "gh.detached": "false" });

    const impl = fakeFetch({
      "/contents/": () => new Response("nf", { status: 404 }),
      "/issues/comments/44": () => new Response("nf", { status: 404 }),
    });
    const ref: IngestSourceRef = { repo: REPO, kind: "issues", num: 3, source: "comment:44" };

    await withGlobalFetch(impl, () =>
      expect(ingestForWebhook(env, ref, { fetchImpl: impl })).resolves.toBeUndefined(),
    );

    const row = await ledgerRow(env.DB, REPO, "assets/one");
    expect(row?.detachedAt).not.toBeNull();
  });
});

describe("reconcileIngestTarget", () => {
  it("walks the body and every paginated comment page, merging summaries", async () => {
    const { env } = baseEnv();
    const otherAssetId = "assets/22222222-2222-2222-2222-222222222222";
    const otherAssetUrl = `https://github.com/user-attachments/${otherAssetId}`;
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: 300 + i,
      body: "no attachment here",
      user: { login: "bob" },
    }));
    const page2 = [{ id: 200, body: `see ${otherAssetUrl}`, user: { login: "eve" } }];
    const commentCalls: string[] = [];
    const impl = (async (url: string, init: RequestInit = {}) => {
      const u = String(url);
      if (u.includes("/access_tokens")) {
        return new Response(JSON.stringify({ token: "t" }), { status: 201 });
      }
      if (u.includes("/installation")) {
        return new Response(JSON.stringify({ id: 42 }), { status: 200 });
      }
      if (u.includes("/issues/7/comments")) {
        commentCalls.push(u);
        if (u.includes("&page=1")) return new Response(JSON.stringify(page1), { status: 200 });
        if (u.includes("&page=2")) return new Response(JSON.stringify(page2), { status: 200 });
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (u.includes("/repos/acme/app/issues/7")) {
        return new Response(JSON.stringify({ body: "", user: { login: "bob" } }), { status: 200 });
      }
      if (u.includes(otherAssetId)) return pngRoute();
      void init;
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;
    const { putImpl, calls } = spyPut();

    const summary = await reconcileIngestTarget(
      env,
      ws,
      WS,
      { repo: REPO, kind: "pull", num: 7 },
      { fetchImpl: impl, putImpl },
    );

    expect(commentCalls.filter((u) => u.includes("&page=1"))).toHaveLength(1);
    expect(commentCalls.filter((u) => u.includes("&page=2"))).toHaveLength(1);
    expect(commentCalls.filter((u) => u.includes("&page=3"))).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(summary.ingested).toHaveLength(1);
    const rows = await ledgerRowsForSource(env.DB, REPO, "comment:200");
    expect(rows).toHaveLength(1);
  });

  it("logs a structured truncation notice when all 3 comment pages come back full, and still reconciles them", async () => {
    const { env } = baseEnv();
    const otherAssetId = "assets/33333333-3333-3333-3333-333333333333";
    const otherAssetUrl = `https://github.com/user-attachments/${otherAssetId}`;
    const pageOf = (start: number, withAttachmentOnLast: boolean) =>
      Array.from({ length: 100 }, (_, i) => {
        const isLast = withAttachmentOnLast && i === 99;
        return {
          id: start + i,
          body: isLast ? `see ${otherAssetUrl}` : "no attachment here",
          user: { login: "bob" },
        };
      });
    const page1 = pageOf(1000, false);
    const page2 = pageOf(2000, false);
    const page3 = pageOf(3000, true); // last comment on page 3 carries the attachment
    const commentCalls: string[] = [];
    const impl = (async (url: string) => {
      const u = String(url);
      if (u.includes("/access_tokens")) {
        return new Response(JSON.stringify({ token: "t" }), { status: 201 });
      }
      if (u.includes("/installation")) {
        return new Response(JSON.stringify({ id: 42 }), { status: 200 });
      }
      if (u.includes("/issues/7/comments")) {
        commentCalls.push(u);
        if (u.includes("&page=1")) return new Response(JSON.stringify(page1), { status: 200 });
        if (u.includes("&page=2")) return new Response(JSON.stringify(page2), { status: 200 });
        if (u.includes("&page=3")) return new Response(JSON.stringify(page3), { status: 200 });
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (u.includes("/repos/acme/app/issues/7")) {
        return new Response(JSON.stringify({ body: "", user: { login: "bob" } }), { status: 200 });
      }
      if (u.includes(otherAssetId)) return pngRoute();
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;
    const { putImpl, calls } = spyPut();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const summary = await reconcileIngestTarget(
        env,
        ws,
        WS,
        { repo: REPO, kind: "pull", num: 7 },
        { fetchImpl: impl, putImpl },
      );

      expect(commentCalls.filter((u) => u.includes("&page=1"))).toHaveLength(1);
      expect(commentCalls.filter((u) => u.includes("&page=2"))).toHaveLength(1);
      expect(commentCalls.filter((u) => u.includes("&page=3"))).toHaveLength(1);
      expect(commentCalls.filter((u) => u.includes("&page=4"))).toHaveLength(0);
      // The reconciler still processed every comment it fetched, including
      // page 3's — the truncation is "we stopped requesting more pages",
      // not "we dropped what we already have".
      expect(calls).toHaveLength(1);
      expect(summary.ingested).toHaveLength(1);
      const rows = await ledgerRowsForSource(env.DB, REPO, `comment:${3000 + 99}`);
      expect(rows).toHaveLength(1);

      expect(logSpy).toHaveBeenCalledWith(
        JSON.stringify({
          message: "github ingest comment scan truncated",
          repo: REPO,
          num: 7,
        }),
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  it("throws github_app_not_installed instead of an empty summary when the app isn't configured", async () => {
    const db = new UsageFakeD1();
    const kv = new FakeKv(); // no ghinst:/ghtok: cache entries seeded
    const env = {
      DB: db,
      GITHUB_CACHE: kv,
      // Deliberately omit GITHUB_APP_CFG_ENV so githubAppConfig(env) returns null.
    } as unknown as Env;

    await expect(
      reconcileIngestTarget(env, ws, WS, { repo: REPO, kind: "pull", num: 7 }, {}),
    ).rejects.toMatchObject({ code: "github_app_not_installed" });
  });

  it("throws github_app_not_installed when the app is configured but not installed on the repo", async () => {
    const { env } = baseEnv();
    const impl = fakeFetch({
      "/installation": () => new Response("nf", { status: 404 }),
    });
    // Bypass the KV-cached installation id from baseEnv() so installationForRepo actually misses.
    const freshEnv = { ...env, GITHUB_CACHE: new FakeKv() } as unknown as Env;

    await expect(
      reconcileIngestTarget(
        freshEnv,
        ws,
        WS,
        { repo: REPO, kind: "pull", num: 7 },
        { fetchImpl: impl },
      ),
    ).rejects.toMatchObject({ code: "github_app_not_installed" });
  });
});
