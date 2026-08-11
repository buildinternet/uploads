/**
 * GitHub attachment ingest reconcile core (Task 4, spec
 * docs/superpowers/specs/2026-08-11-github-attachment-ingestion-design.md):
 * mirrors `github.com/user-attachments/...` URLs referenced from a PR/issue
 * body or comment into workspace-owned storage, so they survive independent
 * of GitHub's own attachment lifecycle and carry the same queryable
 * `gh.*` metadata as every other managed GitHub upload.
 *
 * The ledger (`github-ingest-ledger.ts`) is the idempotency backbone: a
 * `(repo, assetId)` row records that an asset has already been fetched and
 * stored (`objectKey`), independent of which PR/issue/comment it currently
 * lives under. Reconciling a source diffs "assets currently referenced in
 * this text" against "ledger rows currently attributed to this source":
 * newly-referenced assets not yet ledgered are fetched and stored; ledgered
 * assets no longer referenced are marked `detached` (their `gh.detached`
 * metadata flips to "true", never deleted — the object stays addressable);
 * a detached asset that reappears is reattached without a re-fetch.
 *
 * Guard failures (non-media, oversize, over budget, asset 404/403/410) are
 * PERMANENT skips: recorded in the summary, never ledgered, never thrown —
 * a queue consumer must not retry a payload that will never succeed. Network
 * failures, GitHub 5xx, and installation-token mint failures throw, so the
 * queue's own retry/backoff handles them.
 */

import { NotFoundError } from "@uploads/errors";
import { attachmentKeyBasename, extractUserAttachments } from "./github-attachment-extract";
import {
  githubAppConfig,
  githubFetch,
  githubHeaders,
  installationForRepo,
  installationToken,
} from "./github-app";
import {
  ledgerRow,
  ledgerRowsForSource,
  recordIngestedAsset,
  setLedgerDetached,
  setLedgerSource,
} from "./github-ingest-ledger";
import { updateFileMetadataValue } from "./file-metadata";
import { detectContentType, maxBytesForContentType, resolveUploadPolicy } from "./guards";
import { putObject } from "./files-core";
import { findRepoLinkStrict } from "./github-repo-links";
import { resolveRepoCommentOptions } from "./repo-comment-config";
import { loadWorkspaceRecord, type WorkspaceRecord } from "./workspace";

export interface IngestSourceRef {
  repo: string;
  kind: "pull" | "issues";
  num: number;
  /** "body" or "comment:<id>" — the ledger's `source` column. */
  source: string;
}

export interface IngestSummary {
  /** Object keys newly written this pass. */
  ingested: string[];
  /** Object keys whose ledger row (and gh.detached metadata) un-detached. */
  reattached: string[];
  /** Object keys whose ledger row (and gh.detached metadata) detached. */
  detached: string[];
  /** Permanent guard failures — never ledgered, never retried. */
  skipped: { url: string; reason: string }[];
}

export interface IngestDeps {
  fetchImpl?: typeof fetch;
  putImpl?: typeof putObject;
  now?: () => Date;
}

function emptySummary(): IngestSummary {
  return { ingested: [], reattached: [], detached: [], skipped: [] };
}

function mergeSummary(into: IngestSummary, from: IngestSummary): void {
  into.ingested.push(...from.ingested);
  into.reattached.push(...from.reattached);
  into.detached.push(...from.detached);
  into.skipped.push(...from.skipped);
}

/**
 * putObject-thrown errors carrying one of these codes are guard failures the
 * upload path already classified as permanent — the ingest pipeline treats
 * them the same way (skip, don't ledger, don't retry) rather than duplicating
 * their thresholds.
 */
const SKIP_CODES = new Set([
  "storage_quota_exceeded",
  "upload_budget_exceeded",
  "unsupported_media_type",
  "file_metadata_limit_exceeded",
  "empty_body",
]);

const EXT_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

function ingestKey(ref: IngestSourceRef, assetId: string, ext: string): string {
  const repoSeg = ref.repo.toLowerCase().replace("/", "-");
  return `gh/${repoSeg}/${ref.kind}-${ref.num}/${attachmentKeyBasename(assetId)}.${ext}`;
}

function ingestMetadata(ref: IngestSourceRef, author: string | null): Record<string, string> {
  return {
    "gh.repo": ref.repo.toLowerCase(),
    "gh.kind": ref.kind,
    "gh.number": String(ref.num),
    "gh.origin": "github",
    ...(author ? { "gh.author": author } : {}),
    "gh.detached": "false",
    "gh.source": ref.source,
  };
}

type FetchAndStoreResult = { kind: "ok"; key: string } | { kind: "skip"; reason: string };

/**
 * Mints an installation token, fetches one asset's bytes, sniffs/guards
 * them, and puts the object. Guard failures return a `skip` result; a failed
 * token mint or a non-guard fetch/put failure throws (transient — see the
 * module doc-comment).
 */
async function fetchAndStore(
  env: Env,
  ws: WorkspaceRecord,
  workspaceName: string,
  ref: IngestSourceRef,
  attachment: { id: string; url: string },
  author: string | null,
  deps: IngestDeps,
): Promise<FetchAndStoreResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const putImpl = deps.putImpl ?? putObject;
  const now = deps.now ?? (() => new Date());

  const cfg = githubAppConfig(env);
  if (!cfg) return { kind: "skip", reason: "app_not_configured" };
  const installationId = await installationForRepo(env, cfg, ref.repo, fetchImpl);
  if (installationId === null) return { kind: "skip", reason: "app_not_installed" };
  const token = await installationToken(env, cfg, installationId, fetchImpl);
  if (!token) throw new Error("github installation token mint failed");

  const res = await githubFetch(fetchImpl, attachment.url, {
    headers: { authorization: `Bearer ${token}`, "user-agent": "uploads.sh" },
  });
  if (res.status === 404 || res.status === 403 || res.status === 410) {
    return { kind: "skip", reason: "asset_not_found" };
  }
  if (!res.ok) {
    throw new Error(`github asset fetch failed: ${res.status}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());

  const sniffed = detectContentType(bytes);
  if (!sniffed || !(sniffed in EXT_BY_TYPE)) {
    return { kind: "skip", reason: "unsupported_media_type" };
  }

  const policy = resolveUploadPolicy(ws);
  if (bytes.length > maxBytesForContentType(policy, sniffed)) {
    return { kind: "skip", reason: "too_large" };
  }

  const key = ingestKey(ref, attachment.id, EXT_BY_TYPE[sniffed]!);
  try {
    await putImpl(env, ws, key, bytes, workspaceName, {
      metadata: ingestMetadata(ref, author),
      replace: true,
      surface: "github",
    });
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    if (typeof code === "string" && SKIP_CODES.has(code)) {
      return { kind: "skip", reason: code };
    }
    throw err;
  }

  await recordIngestedAsset(env.DB, {
    repo: ref.repo,
    assetId: attachment.id,
    workspace: workspaceName,
    objectKey: key,
    kind: ref.kind,
    num: ref.num,
    source: ref.source,
    createdAt: now().toISOString(),
  });

  return { kind: "ok", key };
}

/**
 * Reconciles ONE source (a body or one comment) against `text`. `text: null`
 * means the source is gone (comment deleted) — every non-detached ledger row
 * currently attributed to `ref.source` is detached, nothing is fetched.
 */
export async function reconcileIngestSource(
  env: Env,
  ws: WorkspaceRecord,
  workspaceName: string,
  ref: IngestSourceRef,
  text: string | null,
  author: string | null,
  deps: IngestDeps = {},
): Promise<IngestSummary> {
  const db = env.DB;
  const summary = emptySummary();
  const found = text === null ? [] : extractUserAttachments(text);
  const foundIds = new Set(found.map((a) => a.id));

  for (const attachment of found) {
    const row = await ledgerRow(db, ref.repo, attachment.id);
    if (row) {
      if (row.detachedAt === null) {
        // Already attached under this exact source — nothing to do. If the
        // image moved between sources (e.g. an edit relocated it from the
        // body into a comment), the ledger's source pointer follows.
        if (row.source !== ref.source) {
          await setLedgerSource(db, ref.repo, attachment.id, ref.source);
        }
        continue;
      }
      // Previously detached, now referenced again — reattach without a
      // re-fetch; the object is still in storage.
      await setLedgerDetached(db, ref.repo, attachment.id, null);
      await updateFileMetadataValue(db, row.workspace, row.objectKey, "gh.detached", "false");
      summary.reattached.push(row.objectKey);
      continue;
    }

    const result = await fetchAndStore(env, ws, workspaceName, ref, attachment, author, deps);
    if (result.kind === "skip") {
      summary.skipped.push({ url: attachment.url, reason: result.reason });
      continue;
    }
    summary.ingested.push(result.key);
  }

  const now = deps.now ?? (() => new Date());
  const existing = await ledgerRowsForSource(db, ref.repo, ref.source);
  for (const row of existing) {
    if (row.detachedAt !== null) continue;
    if (foundIds.has(row.assetId)) continue;
    await setLedgerDetached(db, ref.repo, row.assetId, now().toISOString());
    await updateFileMetadataValue(db, row.workspace, row.objectKey, "gh.detached", "true");
    summary.detached.push(row.objectKey);
  }

  return summary;
}

/** GET the current body/comment text + author from GitHub, or `text: null` on 404. */
async function fetchSourceText(
  fetchImpl: typeof fetch,
  token: string,
  ref: IngestSourceRef,
): Promise<{ text: string | null; author: string | null }> {
  const url =
    ref.source === "body"
      ? `https://api.github.com/repos/${ref.repo}/issues/${ref.num}`
      : `https://api.github.com/repos/${ref.repo}/issues/comments/${ref.source.slice("comment:".length)}`;
  const res = await githubFetch(fetchImpl, url, { headers: githubHeaders(token) });
  if (res.status === 404) return { text: null, author: null };
  if (!res.ok) throw new Error(`github source fetch failed: ${res.status}`);
  const body = (await res.json()) as { body?: string | null; user?: { login?: string } };
  return { text: body.body ?? null, author: body.user?.login ?? null };
}

/**
 * Webhook entry point: resolves the repo→workspace link, the per-repo/per-
 * workspace knob (`resolveRepoCommentOptions`'s `ingestGithubAttachments`),
 * fetches the current text for `ref`, and reconciles it. No-ops (resolves,
 * no GitHub calls) when the repo isn't linked, the workspace can't be
 * loaded, or the knob is off. Throws on transient failure (D1 outage via
 * `findRepoLinkStrict`, installation-token mint failure, non-404 GitHub
 * error) so the caller's queue retries the delivery.
 */
export async function ingestForWebhook(
  env: Env,
  ref: IngestSourceRef,
  deps: IngestDeps = {},
): Promise<void> {
  const link = await findRepoLinkStrict(env.DB, ref.repo);
  if (!link) return;
  const ws = await loadWorkspaceRecord(env, link.workspaceName);
  if (!ws) return;

  const { options } = await resolveRepoCommentOptions(env, ws, ref.repo);
  if (!options.ingestGithubAttachments) return;

  const fetchImpl = deps.fetchImpl ?? fetch;
  const cfg = githubAppConfig(env);
  if (!cfg) return;
  const installationId = await installationForRepo(env, cfg, ref.repo, fetchImpl);
  if (installationId === null) return;
  const token = await installationToken(env, cfg, installationId, fetchImpl);
  if (!token) throw new Error("github installation token mint failed");

  const { text, author } = await fetchSourceText(fetchImpl, token, ref);
  await reconcileIngestSource(env, ws, link.workspaceName, ref, text, author, deps);
}

/**
 * Manual/backfill entry point: reconciles the target's body plus every issue
 * comment (paginated, 100/page, up to 3 pages — a repo with a genuinely
 * longer thread logs a structured truncation notice rather than silently
 * capping). Returns the merged summary across body + all comments.
 *
 * Unlike `ingestForWebhook` (which degrades to a silent no-op when the repo
 * isn't linked or the knob is off — routine, expected states for most repos)
 * a missing/uninstalled GitHub App here is surfaced as a thrown
 * `NotFoundError` (`code: "github_app_not_installed"`): this entry point is
 * driven by an explicit user/admin action whose result is shown back to
 * them, so an empty summary would be indistinguishable from "nothing to
 * ingest" when the real story is "ingestion can't run at all". Token-mint
 * failure still throws a plain (transient) `Error`, unchanged.
 */
export async function reconcileIngestTarget(
  env: Env,
  ws: WorkspaceRecord,
  workspaceName: string,
  target: { repo: string; kind: "pull" | "issues"; num: number },
  deps: IngestDeps = {},
): Promise<IngestSummary> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const merged = emptySummary();

  const cfg = githubAppConfig(env);
  if (!cfg) {
    throw new NotFoundError("github app not configured", { code: "github_app_not_installed" });
  }
  const installationId = await installationForRepo(env, cfg, target.repo, fetchImpl);
  if (installationId === null) {
    throw new NotFoundError("github app not installed on repo", {
      code: "github_app_not_installed",
      details: { repo: target.repo },
    });
  }
  const token = await installationToken(env, cfg, installationId, fetchImpl);
  if (!token) throw new Error("github installation token mint failed");

  const bodyRes = await githubFetch(
    fetchImpl,
    `https://api.github.com/repos/${target.repo}/issues/${target.num}`,
    { headers: githubHeaders(token) },
  );
  if (!bodyRes.ok) throw new Error(`github source fetch failed: ${bodyRes.status}`);
  const bodyJson = (await bodyRes.json()) as { body?: string | null; user?: { login?: string } };
  const bodyRef: IngestSourceRef = {
    repo: target.repo,
    kind: target.kind,
    num: target.num,
    source: "body",
  };
  mergeSummary(
    merged,
    await reconcileIngestSource(
      env,
      ws,
      workspaceName,
      bodyRef,
      bodyJson.body ?? null,
      bodyJson.user?.login ?? null,
      deps,
    ),
  );

  const PER_PAGE = 100;
  const MAX_PAGES = 3;
  let sawFullFinalPage = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await githubFetch(
      fetchImpl,
      `https://api.github.com/repos/${target.repo}/issues/${target.num}/comments?per_page=${PER_PAGE}&page=${page}`,
      { headers: githubHeaders(token) },
    );
    if (!res.ok) throw new Error(`github comments fetch failed: ${res.status}`);
    const comments = (await res.json()) as Array<{
      id: number;
      body?: string | null;
      user?: { login?: string };
    }>;

    for (const comment of comments) {
      const commentRef: IngestSourceRef = {
        repo: target.repo,
        kind: target.kind,
        num: target.num,
        source: `comment:${comment.id}`,
      };
      mergeSummary(
        merged,
        await reconcileIngestSource(
          env,
          ws,
          workspaceName,
          commentRef,
          comment.body ?? null,
          comment.user?.login ?? null,
          deps,
        ),
      );
    }

    if (comments.length < PER_PAGE) break;
    if (page === MAX_PAGES) sawFullFinalPage = true;
  }

  if (sawFullFinalPage) {
    console.log(
      JSON.stringify({
        message: "github ingest comment scan truncated",
        repo: target.repo,
        num: target.num,
      }),
    );
  }

  return merged;
}
