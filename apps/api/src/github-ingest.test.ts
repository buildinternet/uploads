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
import { InsufficientStorageError, RateLimitedError } from "@uploads/errors";
import { describe, expect, it, vi } from "vitest";
import { attachmentKeyBasename } from "./github-attachment-extract";
import { ghPrivateKeyPrefix } from "./github-comment-render";
import {
  ingestForWebhook,
  reconcileIngestSource,
  reconcileIngestTarget,
  type IngestSourceRef,
} from "./github-ingest";
import { ledgerRow, ledgerRowsForSource, recordIngestedAsset } from "./github-ingest-ledger";
import { setLedgerDetached } from "./github-ingest-ledger";
import { getFileMetadata, replaceFileMetadata } from "./file-metadata";
import { getOrMintPrefixId } from "./github-private-prefixes";
import { recordRepoLink } from "./github-repo-links";
import type { WorkspaceRecord } from "./workspace";
import { FakeKv } from "../test/fake-kv";
import { GITHUB_APP_CFG_ENV } from "../test/github-app-env";
import { fakeFetch, pngRoute, withGlobalFetch } from "../test/helpers/github-fetch-fakes";
import { gifOf } from "../test/helpers/image-fixtures";
import { AVIF, MOV, PDF } from "../test/helpers/media-fixtures";
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
  // Public by default (cache hit — no network call): ingestForWebhook and
  // reconcileIngestTarget now resolve a repo-level key mode via
  // resolveGhKeyContext (issue #631) on every call, which — unlike this
  // module's own GitHub calls — isn't fetchImpl-seamed, so a cache miss here
  // would fall through to a REAL `fetch` in every test that doesn't care
  // about privacy. Seeding the negative answer keeps them deterministic.
  kv.store.set("ghpriv:acme/app", { value: "0" });
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

describe("reconcileIngestSource", () => {
  it("new asset in body: put + ledger row + metadata stamped", async () => {
    const { env } = baseEnv();
    const fetchImpl = fakeFetch({ [ASSET_ID]: pngRoute(PNG) });
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
    const fetchImpl = vi.fn(fakeFetch({ [ASSET_ID]: pngRoute(PNG) }));
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

  it("media gate is image/video only: a PDF is a permanent skip even though the upload allowlist accepts it", async () => {
    const { env } = baseEnv();
    const ref: IngestSourceRef = { repo: REPO, kind: "pull", num: 7, source: "body" };
    const fetchImpl = fakeFetch({
      [ASSET_ID]: () =>
        new Response(PDF, { status: 200, headers: { "content-type": "application/pdf" } }),
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

  it("an ingested MOV is named with the .mov extension override", async () => {
    const { env } = baseEnv();
    const ref: IngestSourceRef = { repo: REPO, kind: "pull", num: 7, source: "body" };
    const fetchImpl = fakeFetch({
      [ASSET_ID]: () =>
        new Response(MOV, { status: 200, headers: { "content-type": "video/quicktime" } }),
    });
    const { putImpl, calls } = spyPut();

    const summary = await reconcileIngestSource(env, ws, WS, ref, `see ${ASSET_URL}`, null, {
      fetchImpl,
      putImpl,
    });

    expect(calls[0]!.key).toBe(`gh/acme-app/pull-7/${attachmentKeyBasename(ASSET_ID)}.mov`);
    expect(summary.skipped).toEqual([]);
  });

  it("media gate derives from the shared upload allowlist: AVIF (in guards.ts's allowlist) is accepted", async () => {
    const { env } = baseEnv();
    const ref: IngestSourceRef = { repo: REPO, kind: "pull", num: 7, source: "body" };
    const fetchImpl = fakeFetch({
      [ASSET_ID]: () =>
        new Response(AVIF, { status: 200, headers: { "content-type": "image/avif" } }),
    });
    const { putImpl, calls } = spyPut();

    const summary = await reconcileIngestSource(env, ws, WS, ref, `see ${ASSET_URL}`, null, {
      fetchImpl,
      putImpl,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.key).toBe(`gh/acme-app/pull-7/${attachmentKeyBasename(ASSET_ID)}.avif`);
    expect(summary.skipped).toEqual([]);
  });

  it("media gate follows a workspace's own restricted allowlist: webm passes when it's in policy.allowed", async () => {
    const { env } = baseEnv();
    const webmWs = { allowedContentTypes: ["video/webm"] } as WorkspaceRecord;
    const ref: IngestSourceRef = { repo: REPO, kind: "pull", num: 7, source: "body" };
    // EBML header — the bytes detectContentType sniffs as video/webm.
    const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]);
    const fetchImpl = fakeFetch({
      [ASSET_ID]: () =>
        new Response(WEBM, { status: 200, headers: { "content-type": "video/webm" } }),
    });
    const { putImpl, calls } = spyPut();

    const summary = await reconcileIngestSource(env, webmWs, WS, ref, `see ${ASSET_URL}`, null, {
      fetchImpl,
      putImpl,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.key).toBe(`gh/acme-app/pull-7/${attachmentKeyBasename(ASSET_ID)}.webm`);
    expect(summary.skipped).toEqual([]);
  });

  it("media gate follows a workspace's own restricted allowlist: a type outside it (PNG) is skipped even though the default allowlist accepts it", async () => {
    const { env } = baseEnv();
    // Restricted to webm only — proves the gate reads `policy.allowed`
    // rather than a fixed table that would accept PNG regardless.
    const webmOnlyWs = { allowedContentTypes: ["video/webm"] } as WorkspaceRecord;
    const ref: IngestSourceRef = { repo: REPO, kind: "pull", num: 7, source: "body" };
    const fetchImpl = fakeFetch({ [ASSET_ID]: pngRoute(PNG) });
    const { putImpl, calls } = spyPut();

    const summary = await reconcileIngestSource(
      env,
      webmOnlyWs,
      WS,
      ref,
      `see ${ASSET_URL}`,
      null,
      {
        fetchImpl,
        putImpl,
      },
    );

    expect(calls).toHaveLength(0);
    expect(summary.skipped).toEqual([{ url: ASSET_URL, reason: "unsupported_media_type" }]);
  });

  it("bot filter: an asset authored by a [bot] login is skipped without fetching", async () => {
    const { env } = baseEnv();
    const ref: IngestSourceRef = { repo: REPO, kind: "issues", num: 3, source: "comment:9" };
    const fetchImpl = vi.fn(fakeFetch({ [ASSET_ID]: pngRoute(PNG) }));
    const { putImpl, calls } = spyPut();

    const summary = await reconcileIngestSource(
      env,
      ws,
      WS,
      ref,
      `see ${ASSET_URL}`,
      "claude[bot]",
      { fetchImpl, putImpl },
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(summary.skipped).toEqual([{ url: ASSET_URL, reason: "bot_author" }]);
    expect(await ledgerRow(env.DB, REPO, ASSET_ID)).toBeNull();
  });

  it("bot filter: ingestBotAuthors deliberately re-admits bot-authored assets", async () => {
    const { env } = baseEnv();
    const ref: IngestSourceRef = { repo: REPO, kind: "issues", num: 3, source: "comment:9" };
    const fetchImpl = fakeFetch({ [ASSET_ID]: pngRoute(PNG) });
    const { putImpl, calls } = spyPut();

    const summary = await reconcileIngestSource(
      env,
      ws,
      WS,
      ref,
      `see ${ASSET_URL}`,
      "claude[bot]",
      { fetchImpl, putImpl, ingestBotAuthors: true },
    );

    expect(calls).toHaveLength(1);
    expect(summary.skipped).toEqual([]);
    expect(summary.ingested).toHaveLength(1);
  });

  it("small-image filter: an image under the minimum dimension is a permanent too_small skip", async () => {
    const { env } = baseEnv();
    const ref: IngestSourceRef = { repo: REPO, kind: "pull", num: 7, source: "body" };
    // Real GIF89a header with a 128×128 logical screen — the emoji/badge
    // junk this gate exists for.
    const tinyGif = gifOf(128, 128);
    const fetchImpl = fakeFetch({
      [ASSET_ID]: () =>
        new Response(tinyGif, { status: 200, headers: { "content-type": "image/gif" } }),
    });
    const { putImpl, calls } = spyPut();

    const summary = await reconcileIngestSource(env, ws, WS, ref, `see ${ASSET_URL}`, "octocat", {
      fetchImpl,
      putImpl,
    });

    expect(calls).toHaveLength(0);
    expect(summary.skipped).toEqual([{ url: ASSET_URL, reason: "too_small" }]);
    expect(await ledgerRow(env.DB, REPO, ASSET_ID)).toBeNull();
  });

  it("small-image filter: an image at or above the minimum dimension ingests", async () => {
    const { env } = baseEnv();
    const ref: IngestSourceRef = { repo: REPO, kind: "pull", num: 7, source: "body" };
    const bigGif = gifOf(800, 600);
    const fetchImpl = fakeFetch({
      [ASSET_ID]: () =>
        new Response(bigGif, { status: 200, headers: { "content-type": "image/gif" } }),
    });
    const { putImpl, calls } = spyPut();

    const summary = await reconcileIngestSource(env, ws, WS, ref, `see ${ASSET_URL}`, "octocat", {
      fetchImpl,
      putImpl,
    });

    expect(calls).toHaveLength(1);
    expect(summary.skipped).toEqual([]);
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
    const fetchImpl = fakeFetch({ [ASSET_ID]: pngRoute(PNG) });
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
    const fetchImpl = fakeFetch({ [ASSET_ID]: pngRoute(PNG) });

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

    // upload_budget_exceeded is typed rate_limited (normally retryable) but
    // budget windows outlast queue retries — the carve-out keeps it a skip.
    const uploadBudgetPut = vi.fn(async () => {
      throw new RateLimitedError("upload budget exceeded", {
        code: "upload_budget_exceeded",
      });
    }) as unknown as typeof import("./files-core").putObject;
    const budgetSummary = await reconcileIngestSource(env, ws, WS, ref, `see ${ASSET_URL}`, null, {
      fetchImpl,
      putImpl: uploadBudgetPut,
    });
    expect(budgetSummary.skipped).toEqual([{ url: ASSET_URL, reason: "upload_budget_exceeded" }]);
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

  it("link + workspace but knob explicitly false: resolves without fetching the issue body or asset", async () => {
    const { env: base } = baseEnv();
    const env = withRegistry(base, {
      provider: "r2",
      bucket: "b",
      githubIngestAttachments: false,
    } as WorkspaceRecord);
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

  it("knob unset: ingestion is on by default — fetches the issue body, puts, ledgers", async () => {
    const { env: base } = baseEnv();
    const env = withRegistry(base, { provider: "r2", bucket: "b" } as WorkspaceRecord);
    await recordRepoLink(env.DB, REPO, WS, "test");
    const impl = fakeFetch({
      "/contents/": () => new Response("nf", { status: 404 }),
      "/repos/acme/app/issues/7": () =>
        new Response(JSON.stringify({ body: `see ${ASSET_URL}`, user: { login: "octocat" } }), {
          status: 200,
        }),
      [ASSET_ID]: pngRoute(PNG),
    });
    const { putImpl, calls } = spyPut();
    const ref: IngestSourceRef = { repo: REPO, kind: "pull", num: 7, source: "body" };

    await withGlobalFetch(impl, () => ingestForWebhook(env, ref, { fetchImpl: impl, putImpl }));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.key).toBe(KEY);
    const row = await ledgerRow(env.DB, REPO, ASSET_ID);
    expect(row).not.toBeNull();
  });

  it("passes the resolved ingestBotAttachments knob through: a repo config enabling it re-admits bot authors", async () => {
    const { env: base } = baseEnv();
    const env = withRegistry(base, { provider: "r2", bucket: "b" } as WorkspaceRecord);
    await recordRepoLink(env.DB, REPO, WS, "test");
    const impl = fakeFetch({
      "/contents/": () => new Response("comment:\n  ingestBotAttachments: true\n", { status: 200 }),
      "/repos/acme/app/issues/7": () =>
        new Response(JSON.stringify({ body: `see ${ASSET_URL}`, user: { login: "claude[bot]" } }), {
          status: 200,
        }),
      [ASSET_ID]: pngRoute(PNG),
    });
    const { putImpl, calls } = spyPut();
    const ref: IngestSourceRef = { repo: REPO, kind: "pull", num: 7, source: "body" };

    await withGlobalFetch(impl, () => ingestForWebhook(env, ref, { fetchImpl: impl, putImpl }));

    expect(calls).toHaveLength(1);
  });

  it("filters a bot-authored body by default (no repo config)", async () => {
    const { env: base } = baseEnv();
    const env = withRegistry(base, { provider: "r2", bucket: "b" } as WorkspaceRecord);
    await recordRepoLink(env.DB, REPO, WS, "test");
    const impl = fakeFetch({
      "/contents/": () => new Response("nf", { status: 404 }),
      "/repos/acme/app/issues/7": () =>
        new Response(JSON.stringify({ body: `see ${ASSET_URL}`, user: { login: "claude[bot]" } }), {
          status: 200,
        }),
      [ASSET_ID]: pngRoute(PNG),
    });
    const { putImpl, calls } = spyPut();
    const ref: IngestSourceRef = { repo: REPO, kind: "pull", num: 7, source: "body" };

    await withGlobalFetch(impl, () => ingestForWebhook(env, ref, { fetchImpl: impl, putImpl }));

    expect(calls).toHaveLength(0);
    expect(await ledgerRow(env.DB, REPO, ASSET_ID)).toBeNull();
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
      if (u.includes(otherAssetId)) return pngRoute(PNG)();
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
      if (u.includes(otherAssetId)) return pngRoute(PNG)();
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

  it("detaches a ledger row whose comment source was deleted on GitHub (absent from the fetched list)", async () => {
    const { env } = baseEnv();
    const orphanAssetId = "assets/44444444-4444-4444-4444-444444444444";
    const orphanKey = `gh/acme-app/pull-7/${attachmentKeyBasename(orphanAssetId)}.png`;
    // Row attributed to comment:999, which GitHub no longer returns — the
    // comment was deleted.
    await recordIngestedAsset(env.DB, {
      repo: REPO,
      assetId: orphanAssetId,
      workspace: WS,
      objectKey: orphanKey,
      kind: "pull",
      num: 7,
      source: "comment:999",
      createdAt: new Date().toISOString(),
    });
    await replaceFileMetadata(env.DB, WS, orphanKey, { "gh.detached": "false" });

    const otherComment = { id: 500, body: "no attachment here", user: { login: "eve" } };
    const impl = (async (url: string) => {
      const u = String(url);
      if (u.includes("/access_tokens")) {
        return new Response(JSON.stringify({ token: "t" }), { status: 201 });
      }
      if (u.includes("/installation")) {
        return new Response(JSON.stringify({ id: 42 }), { status: 200 });
      }
      if (u.includes("/issues/7/comments")) {
        if (u.includes("&page=1")) {
          return new Response(JSON.stringify([otherComment]), { status: 200 });
        }
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (u.includes("/repos/acme/app/issues/7")) {
        return new Response(JSON.stringify({ body: "", user: { login: "bob" } }), { status: 200 });
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;

    const summary = await reconcileIngestTarget(
      env,
      ws,
      WS,
      { repo: REPO, kind: "pull", num: 7 },
      { fetchImpl: impl },
    );

    expect(summary.detached).toContain(orphanKey);
    const row = await ledgerRow(env.DB, REPO, orphanAssetId);
    expect(row?.detachedAt).not.toBeNull();
    const meta = await getFileMetadata(env.DB, WS, orphanKey);
    expect(meta["gh.detached"]).toBe("true");
  });

  it("does NOT run orphan detection when the comment scan was truncated (3 full pages)", async () => {
    const { env } = baseEnv();
    const orphanAssetId = "assets/55555555-5555-5555-5555-555555555555";
    const orphanKey = `gh/acme-app/pull-7/${attachmentKeyBasename(orphanAssetId)}.png`;
    await recordIngestedAsset(env.DB, {
      repo: REPO,
      assetId: orphanAssetId,
      workspace: WS,
      objectKey: orphanKey,
      kind: "pull",
      num: 7,
      source: "comment:999",
      createdAt: new Date().toISOString(),
    });
    await replaceFileMetadata(env.DB, WS, orphanKey, { "gh.detached": "false" });

    const pageOf = (start: number) =>
      Array.from({ length: 100 }, (_, i) => ({
        id: start + i,
        body: "no attachment here",
        user: { login: "bob" },
      }));
    const page1 = pageOf(1000);
    const page2 = pageOf(2000);
    const page3 = pageOf(3000);
    const impl = (async (url: string) => {
      const u = String(url);
      if (u.includes("/access_tokens")) {
        return new Response(JSON.stringify({ token: "t" }), { status: 201 });
      }
      if (u.includes("/installation")) {
        return new Response(JSON.stringify({ id: 42 }), { status: 200 });
      }
      if (u.includes("/issues/7/comments")) {
        if (u.includes("&page=1")) return new Response(JSON.stringify(page1), { status: 200 });
        if (u.includes("&page=2")) return new Response(JSON.stringify(page2), { status: 200 });
        if (u.includes("&page=3")) return new Response(JSON.stringify(page3), { status: 200 });
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (u.includes("/repos/acme/app/issues/7")) {
        return new Response(JSON.stringify({ body: "", user: { login: "bob" } }), { status: 200 });
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const summary = await reconcileIngestTarget(
        env,
        ws,
        WS,
        { repo: REPO, kind: "pull", num: 7 },
        { fetchImpl: impl },
      );

      expect(summary.detached).not.toContain(orphanKey);
      const row = await ledgerRow(env.DB, REPO, orphanAssetId);
      expect(row?.detachedAt).toBeNull();
      const meta = await getFileMetadata(env.DB, WS, orphanKey);
      expect(meta["gh.detached"]).toBe("false");
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

describe("private-repo ingest keys (issue #631)", () => {
  it("ingestForWebhook: a private repo writes under gh/private/<id>/ingest/<kind>-<num>/, distinct from the comment-gather prefix", async () => {
    const { env: base, kv } = baseEnv();
    kv.store.set("ghpriv:acme/app", { value: "1" });
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
      [ASSET_ID]: pngRoute(PNG),
    });
    const { putImpl, calls } = spyPut();
    const ref: IngestSourceRef = { repo: REPO, kind: "pull", num: 7, source: "body" };

    await withGlobalFetch(impl, () => ingestForWebhook(env, ref, { fetchImpl: impl, putImpl }));

    expect(calls).toHaveLength(1);
    const writtenKey = calls[0]!.key;
    const prefixId = await getOrMintPrefixId(env.DB, REPO, "");
    expect(writtenKey).toBe(
      `gh/private/${prefixId}/ingest/pull-7/${attachmentKeyBasename(ASSET_ID)}.png`,
    );

    // Never lands under the prefix the managed-comment gatherer lists for
    // this PR — an ingested asset is an index only, not comment-visible.
    const gatherPrefix = ghPrivateKeyPrefix(prefixId, { repo: REPO, kind: "pull", num: 7 });
    expect(writtenKey.startsWith(gatherPrefix)).toBe(false);

    const row = await ledgerRow(env.DB, REPO, ASSET_ID);
    expect(row?.objectKey).toBe(writtenKey);
  });

  it("ingestForWebhook: a public repo is unaffected (still the plain ingest key)", async () => {
    const { env: base } = baseEnv(); // ghpriv:acme/app seeded "0" by baseEnv()
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
      [ASSET_ID]: pngRoute(PNG),
    });
    const { putImpl, calls } = spyPut();
    const ref: IngestSourceRef = { repo: REPO, kind: "pull", num: 7, source: "body" };

    await withGlobalFetch(impl, () => ingestForWebhook(env, ref, { fetchImpl: impl, putImpl }));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.key).toBe(KEY);
  });

  it("reconcileIngestTarget: a private repo writes the same gh/private/<id>/ingest/ layout, resolving the mode once for the whole call", async () => {
    const { env } = baseEnv();
    (env.GITHUB_CACHE as unknown as FakeKv).store.set("ghpriv:acme/app", { value: "1" });
    await recordRepoLink(env.DB, REPO, WS, "test");
    const impl = fakeFetch({
      "/access_tokens": () => new Response(JSON.stringify({ token: "t" }), { status: 201 }),
      "/installation": () => new Response(JSON.stringify({ id: 42 }), { status: 200 }),
      "/repos/acme/app/issues/7/comments": () => new Response(JSON.stringify([]), { status: 200 }),
      "/repos/acme/app/issues/7": () =>
        new Response(JSON.stringify({ body: `see ${ASSET_URL}`, user: { login: "bob" } }), {
          status: 200,
        }),
      [ASSET_ID]: pngRoute(PNG),
    });
    const { putImpl, calls } = spyPut();

    const summary = await reconcileIngestTarget(
      env,
      ws,
      WS,
      { repo: REPO, kind: "pull", num: 7 },
      { fetchImpl: impl, putImpl },
    );

    expect(calls).toHaveLength(1);
    const prefixId = await getOrMintPrefixId(env.DB, REPO, "");
    expect(calls[0]!.key).toBe(
      `gh/private/${prefixId}/ingest/pull-7/${attachmentKeyBasename(ASSET_ID)}.png`,
    );
    expect(summary.ingested).toEqual([calls[0]!.key]);
  });

  it("ingestForWebhook: resolveGhKeyContext throwing (e.g. a D1 outage in its authorization check) degrades to the plain ingest key instead of aborting", async () => {
    const { env: base, kv, db } = baseEnv();
    kv.store.set("ghpriv:acme/app", { value: "1" });
    const env = withRegistry(base, {
      provider: "r2",
      bucket: "b",
      githubIngestAttachments: true,
    } as WorkspaceRecord);
    await recordRepoLink(env.DB, REPO, WS, "test");
    // `ingestForWebhook`'s own `findRepoLinkStrict` call (the FIRST hit on
    // this table) must still succeed — it's not the call under test, and its
    // own D1-outage-throws contract is unrelated to this guard. Only the
    // SECOND hit — `resolveGhKeyContext`'s internal `checkRepoAuthorization`
    // — is made to throw, simulating a transient D1 outage there specifically.
    let repoLinkCalls = 0;
    const throwingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (sql.includes("FROM github_repo_links")) {
              repoLinkCalls++;
              if (repoLinkCalls > 1) throw new Error("simulated D1 outage");
            }
            return target.prepare(sql);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const throwingEnv = { ...env, DB: throwingDb } as unknown as Env;

    const impl = fakeFetch({
      "/contents/": () => new Response("nf", { status: 404 }),
      "/repos/acme/app/issues/7": () =>
        new Response(JSON.stringify({ body: `see ${ASSET_URL}`, user: { login: "octocat" } }), {
          status: 200,
        }),
      [ASSET_ID]: pngRoute(PNG),
    });
    const { putImpl, calls } = spyPut();
    const ref: IngestSourceRef = { repo: REPO, kind: "pull", num: 7, source: "body" };

    await expect(
      withGlobalFetch(impl, () => ingestForWebhook(throwingEnv, ref, { fetchImpl: impl, putImpl })),
    ).resolves.toBeUndefined();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.key).toBe(KEY); // the plain (non-private) ingest key.
  });

  it("reconcileIngestTarget: resolveGhKeyContext throwing degrades to the plain ingest key instead of aborting", async () => {
    const { env, kv, db } = baseEnv();
    kv.store.set("ghpriv:acme/app", { value: "1" });
    // reconcileIngestTarget itself never reads github_repo_links outside
    // resolveGhKeyContext's own authorization check, so the very first hit
    // can throw.
    const throwingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (sql.includes("FROM github_repo_links")) throw new Error("simulated D1 outage");
            return target.prepare(sql);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const throwingEnv = { ...env, DB: throwingDb } as unknown as Env;

    const impl = fakeFetch({
      "/access_tokens": () => new Response(JSON.stringify({ token: "t" }), { status: 201 }),
      "/installation": () => new Response(JSON.stringify({ id: 42 }), { status: 200 }),
      "/repos/acme/app/issues/7/comments": () => new Response(JSON.stringify([]), { status: 200 }),
      "/repos/acme/app/issues/7": () =>
        new Response(JSON.stringify({ body: `see ${ASSET_URL}`, user: { login: "bob" } }), {
          status: 200,
        }),
      [ASSET_ID]: pngRoute(PNG),
    });
    const { putImpl, calls } = spyPut();

    const summary = await reconcileIngestTarget(
      throwingEnv,
      ws,
      WS,
      { repo: REPO, kind: "pull", num: 7 },
      { fetchImpl: impl, putImpl },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.key).toBe(KEY); // the plain (non-private) ingest key.
    expect(summary.ingested).toEqual([KEY]);
  });
});
