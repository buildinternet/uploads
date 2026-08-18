/**
 * Webhook "link adoption" (issue #701): scans a PR/issue body or comment for
 * plain uploads.sh file URLs pasted by a human (or an agent uploading via raw
 * curl, outside the paved `--pr`/`attach --branch` path) and adopts every one
 * that resolves to an object in the repo's OWN bound workspace into that
 * PR/issue's attachment context — so it gets pairing, dedupe, the activity
 * feed, and screenshots-page grouping "for free", the same as anything
 * uploaded through `attach`.
 *
 * Reuses #702's machinery verbatim rather than reimplementing it:
 * `resolveAttachSourceKey` (github-attach.ts) for the URL→key resolution
 * (storage host, embed host, and the `/f/` page all handled there, and a URL
 * that doesn't resolve to an object in THIS workspace throws — the same
 * structural cross-workspace rejection every other `files:write` path gets,
 * satisfying "URLs from other workspaces are silently ignored" here since
 * every throw from a candidate URL is caught and the URL is just dropped),
 * and `attachExistingObject` for the copy + additive `gh.*` metadata merge
 * (PR #157 preserve contract).
 *
 * COPY, never move (`attachExistingObject`'s default `move: false`): the
 * originally-pasted URL keeps resolving untouched after adoption, which is
 * also why adopted files are never migrated into a private repo's
 * `gh/private/` prefix — only the fresh COPY lands there, the source `f/` key
 * some human already pasted a link to is left exactly where it was. Copying
 * (rather than a metadata-only in-place tag) is the deliberate choice here:
 * the managed comment's `gatherCommentBody` lists objects by R2 key prefix,
 * not by `gh.*` metadata query, so only a copy under the PR's attachment
 * prefix is visible to the existing renderer without also changing it.
 *
 * Idempotent: re-adopting the same source into the same target overwrites
 * the same destination key in place (`attachExistingObject`'s own contract),
 * so repeated webhook redeliveries and comment-edit rescans are safe no-ops
 * on the object/metadata side. The `postManagedComment` call this module
 * gates is separately safe to repeat (its own upsert is idempotent).
 *
 * Noise guard: a lone adopted image that's already visible inline in the
 * PR/comment doesn't warrant a managed comment repeating it — see
 * `shouldSyncAfterAdopt`.
 */
import { attachExistingObject, resolveAttachSourceKey } from "./github-attach";
import { commentCacheKey, gatherCommentBody } from "./github-comment";
import type { GhTarget } from "./github-comment-render";
import { postManagedComment } from "./github-comment-service";
import { findRepoLinkStrict } from "./github-repo-links";
import { resolveRepoCommentOptions } from "./repo-comment-config";
import { storageConfig } from "./storage";
import {
  githubAppConfig,
  githubFetch,
  githubHeaders,
  installationForRepo,
  installationToken,
} from "./github-app";
import { loadWorkspaceRecord } from "./workspace";

export interface AdoptSourceRef {
  repo: string;
  kind: GhTarget["kind"];
  num: number;
  /** "body" or "comment:<id>" — same vocabulary as `IngestSourceRef`, unused
   * beyond logging (adoption re-scans the CURRENT text, it has no ledger). */
  source: string;
}

export interface AdoptSummary {
  /** Destination keys copied/refreshed this pass (may already have existed —
   * adoption always re-copies, an idempotent overwrite). */
  adopted: string[];
  /** Candidate URLs that looked like uploads.sh links but didn't resolve to
   * an object in this workspace (wrong workspace, unknown key, deleted). */
  skipped: string[];
  /** Whether `postManagedComment` was actually invoked this pass. */
  synced: boolean;
}

/** Cheap, I/O-free reject: no http(s) URL at all means nothing to scan for —
 * safe to call from a pure payload-extraction context (`extractWebhookEvent`)
 * before any workspace/storage lookup exists. */
export function hasLinkCandidate(text: string): boolean {
  return /https?:\/\//i.test(text);
}

const URL_RE = /https?:\/\/[^\s)"'<>\]]+/gi;

/** Distinct http(s) URLs found in `text`, trailing prose punctuation
 * stripped, order preserved, first occurrence wins on duplicates. */
export function extractCandidateUrls(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(/[.,;:]+$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

/**
 * Resolves every uploads.sh-shaped URL in `text` to a key in `workspaceName`'s
 * own bucket, silently dropping anything that isn't one of the three URL
 * shapes, doesn't belong to this workspace, or isn't a URL at all. Order
 * preserved, deduplicated by resolved key (two different URL spellings for
 * the same object collapse to one adoption).
 */
export async function resolveAdoptableKeys(
  env: Env,
  workspaceName: string,
  text: string,
): Promise<{ keys: string[]; skipped: string[] }> {
  const ws = await loadWorkspaceRecord(env, workspaceName);
  if (!ws) return { keys: [], skipped: [] };
  const cfg = await storageConfig(env, ws);

  const seen = new Set<string>();
  const keys: string[] = [];
  const skipped: string[] = [];
  for (const url of extractCandidateUrls(text)) {
    let key: string;
    try {
      key = await resolveAttachSourceKey(env, cfg, workspaceName, url);
    } catch {
      skipped.push(url);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return { keys, skipped };
}

/**
 * Adoption is worth a comment sync only when there's something to
 * consolidate (issue #701's noise guard): a lone newly-scanned link with no
 * other attachments already staged/attached for this target, and no managed
 * comment yet, is already fully visible inline — posting a comment that just
 * repeats it is noise. Sync fires when:
 *   - two or more links resolved this pass, or
 *   - at least one resolved AND the target already has other attachments
 *     (staged/attached/previously-adopted) under its comment prefix, or
 *   - a managed comment already exists for this target (heal/refresh it
 *     rather than leave it stale).
 */
async function shouldSyncAfterAdopt(
  env: Env,
  workspaceName: string,
  target: GhTarget,
  adoptedCount: number,
  preexistingCount: number,
): Promise<boolean> {
  if (adoptedCount === 0) return false;
  if (adoptedCount >= 2) return true;
  if (preexistingCount > 0) return true;

  const cachedCommentId = await env.GITHUB_CACHE.get(commentCacheKey(workspaceName, target));
  return cachedCommentId !== null;
}

/**
 * Copy every resolved-key adoption into `target`'s attachment prefix (via
 * #702's `attachExistingObject`), then sync the managed comment only when
 * `shouldSyncAfterAdopt` says there's something worth consolidating. The
 * "does this target already have other attachments" check that feeds the
 * noise guard is a `gatherCommentBody` call BEFORE any copy this pass makes,
 * so a single lone adoption is judged against the PRE-adoption state, not
 * inflated by its own copy.
 */
export async function adoptLinkedFiles(
  env: Env,
  workspaceName: string,
  mintingUserId: string | null,
  target: GhTarget,
  text: string,
): Promise<AdoptSummary> {
  const { keys, skipped } = await resolveAdoptableKeys(env, workspaceName, text);
  const summary: AdoptSummary = { adopted: [], skipped, synced: false };
  if (keys.length === 0) return summary;

  const ws = await loadWorkspaceRecord(env, workspaceName);
  if (!ws) return summary;

  // Baseline BEFORE this pass's copies land, so a lone adoption isn't judged
  // against a prefix count its own copy just inflated.
  const before = await gatherCommentBody(env, ws, workspaceName, target);

  for (const key of keys) {
    try {
      const result = await attachExistingObject(env, ws, workspaceName, {
        source: key,
        target: { repo: target.repo, kind: target.kind, num: target.num },
      });
      summary.adopted.push(result.key);
    } catch (err) {
      // Source vanished between resolve and copy (deleted concurrently), or a
      // transient storage failure — either way this one URL is skipped, the
      // rest of the pass continues. Never fails the whole webhook delivery.
      console.error(
        JSON.stringify({
          message: "link adoption: attach failed for resolved key",
          repo: target.repo,
          num: target.num,
          key,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      summary.skipped.push(key);
    }
  }
  if (summary.adopted.length === 0) return summary;

  const sync = await shouldSyncAfterAdopt(
    env,
    workspaceName,
    target,
    summary.adopted.length,
    before.count,
  );
  if (sync) {
    await postManagedComment(env, ws, workspaceName, mintingUserId, target, {});
    summary.synced = true;
  }
  return summary;
}

/** GET the current body/comment text from GitHub, or `null` on 404 — same
 * shape as github-ingest.ts's `fetchSourceText`, duplicated locally rather
 * than shared since it's a four-line GET with no other coupling. */
async function fetchSourceText(
  fetchImpl: typeof fetch,
  token: string,
  ref: AdoptSourceRef,
): Promise<string | null> {
  const url =
    ref.source === "body"
      ? `https://api.github.com/repos/${ref.repo}/issues/${ref.num}`
      : `https://api.github.com/repos/${ref.repo}/issues/comments/${ref.source.slice("comment:".length)}`;
  const res = await githubFetch(fetchImpl, url, { headers: githubHeaders(token) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`github source fetch failed: ${res.status}`);
  const body = (await res.json()) as { body?: string | null };
  return body.body ?? null;
}

/**
 * Webhook entry point: resolves the repo→workspace link, the per-repo/per-
 * workspace `adoptLinkedFiles` knob, fetches the current text for `ref`, and
 * adopts any resolvable uploads.sh links in it. No-ops (resolves, no GitHub
 * calls) when the repo isn't linked, the workspace can't be loaded, or the
 * knob is off — mirrors `ingestForWebhook`'s contract exactly. Throws on
 * transient failure (D1 outage, token mint failure, non-404 GitHub error) so
 * the caller's queue retries the delivery.
 */
export async function adoptLinkedFilesForWebhook(
  env: Env,
  ref: AdoptSourceRef,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const link = await findRepoLinkStrict(env.DB, ref.repo);
  if (!link) return;
  const ws = await loadWorkspaceRecord(env, link.workspaceName);
  if (!ws) return;

  const { options } = await resolveRepoCommentOptions(env, ws, ref.repo);
  if (!options.adoptLinkedFiles) return;

  const fetchImpl = deps.fetchImpl ?? fetch;
  const cfg = githubAppConfig(env);
  if (!cfg) return;
  const installationId = await installationForRepo(env, cfg, ref.repo, fetchImpl);
  if (installationId === null) return;
  const token = await installationToken(env, cfg, installationId, fetchImpl);
  if (!token) throw new Error("github installation token mint failed");

  const text = await fetchSourceText(fetchImpl, token, ref);
  if (text === null || !hasLinkCandidate(text)) return;

  await adoptLinkedFiles(
    env,
    link.workspaceName,
    null,
    { repo: ref.repo, kind: ref.kind, num: ref.num },
    text,
  );
}
