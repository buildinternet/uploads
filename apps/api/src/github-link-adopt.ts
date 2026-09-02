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
 * `shouldSyncAfterAdopt`. The guard's adopted-count comes from the ledger
 * (`github-link-adopt-ledger.ts`, issue #709) — the TOTAL non-detached rows
 * for this target, not the current pass's copy count — so two links pasted
 * in two separate comments correctly trip the threshold on the second one
 * regardless of which comment either link landed in.
 *
 * The ledger is also the idempotency/un-adoption backbone, mirroring
 * `github-ingest.ts`'s reconcile shape exactly: a source key already
 * ledgered under this exact (target, source) is a cheap skip (no re-copy);
 * a source key no longer found when this SOURCE (body or one comment) is
 * rescanned is marked detached — the copy is never deleted, only hidden
 * from the managed comment render (`gh.detached` metadata, same convention
 * ingest uses) — and reappearing un-detaches it without a re-copy.
 *
 * "Still referenced" is the source key **or** the destination key (issue
 * #865). A body edit that only rewrites a staged branch URL to the promoted
 * `pull/<n>/` URL is the same file, not a removal — detaching would hide
 * the real `--pr` / promoted attachment, which shares that destination.
 */
import { attachExistingObject, resolveAttachSourceKey } from "./github-attach";
import { detachAttachmentSafe, reattachAttachmentSafe } from "./github-attachment-index";
import { commentCacheKey, gatherCommentBody } from "./github-comment";
import { GH_PRIVATE_ROOT, ghKeyPrefix, type GhTarget } from "./github-comment-render";
import { postManagedComment } from "./github-comment-service";
import { setFileMetadata } from "./file-metadata";
import {
  adoptLedgerRow,
  adoptLedgerRowsForSource,
  adoptLedgerRowsForTarget,
  recordAdoptedLink,
  setAdoptLedgerDetached,
  setAdoptLedgerSource,
} from "./github-link-adopt-ledger";
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
import { dbFor } from "./db-session";

export interface AdoptSourceRef {
  repo: string;
  kind: GhTarget["kind"];
  num: number;
  /** "body" or "comment:<id>" — same vocabulary as `IngestSourceRef`, unused
   * beyond logging (adoption re-scans the CURRENT text, it has no ledger). */
  source: string;
}

export interface AdoptSummary {
  /** Destination keys newly copied this pass (a ledgered key is a cheap
   * skip, never re-copied — see the module doc-comment). */
  adopted: string[];
  /** Destination keys whose ledger row un-detached this pass (reappeared
   * after having been edited out) — no re-copy, just a metadata/ledger flip. */
  reattached: string[];
  /** Destination keys whose ledger row detached this pass (no longer
   * referenced from this exact source) — the copy stays in storage, only
   * hidden from the managed comment render. */
  detached: string[];
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

/**
 * True when `key` already lives under this target's attachment prefix — a
 * promoted / `--pr` object, or a dest URL pasted after adoption. Not a
 * source to copy onto itself (issue #865).
 */
function isTargetAttachmentKey(key: string, target: GhTarget): boolean {
  if (key.startsWith(ghKeyPrefix(target))) return true;
  if (!key.startsWith(GH_PRIVATE_ROOT)) return false;
  return key.includes(`/${target.kind}/${target.num}/`);
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
 *   - the target now has two or more currently-adopted links total (ledger
 *     count, issue #709 — deterministic across passes/sources, not just
 *     this pass's copy count), or
 *   - at least one link is adopted AND the target already has other
 *     attachments (staged/attached/non-ledger-adopted) under its comment
 *     prefix, or
 *   - a link detached this pass (the comment needs to drop it, even if that
 *     leaves fewer than two attachments — an emptying comment is exactly
 *     the "heal/refresh, don't leave it stale" case below), or
 *   - a managed comment already exists for this target (heal/refresh it
 *     rather than leave it stale).
 */
async function shouldSyncAfterAdopt(
  env: Env,
  workspaceName: string,
  target: GhTarget,
  totalAdoptedCount: number,
  preexistingCount: number,
  hadDetach: boolean,
): Promise<boolean> {
  if (hadDetach) return true;
  if (totalAdoptedCount === 0) return false;
  if (totalAdoptedCount >= 2) return true;
  if (preexistingCount > 0) return true;

  const cachedCommentId = await env.GITHUB_CACHE.get(commentCacheKey(workspaceName, target));
  return cachedCommentId !== null;
}

/**
 * Reconciles ONE source (a PR/issue body or one comment) against `text`:
 * resolved keys not yet ledgered for this exact (target, source) are copied
 * into `target`'s attachment prefix (via #702's `attachExistingObject`) and
 * recorded; an already-ledgered, non-detached key is a cheap skip (no
 * re-copy); a previously-detached key that's referenced again is
 * un-detached without a re-copy; a ledgered, non-detached key for this
 * source that's no longer found in `text` is detached. The managed comment
 * is synced only when `shouldSyncAfterAdopt` says there's something worth
 * consolidating.
 *
 * `source` is the ledger's source pointer ("body" or "comment:<id>") —
 * defaults to "body" for direct callers (tests, and any future non-webhook
 * entry point) that don't care about per-comment scoping.
 */
export async function adoptLinkedFiles(
  env: Env,
  workspaceName: string,
  mintingUserId: string | null,
  target: GhTarget,
  text: string,
  source = "body",
): Promise<AdoptSummary> {
  const { keys, skipped } = await resolveAdoptableKeys(env, workspaceName, text);
  const summary: AdoptSummary = {
    adopted: [],
    reattached: [],
    detached: [],
    skipped,
    synced: false,
  };

  const ws = await loadWorkspaceRecord(env, workspaceName);
  if (!ws) return summary;

  const db = dbFor(env);
  const { repo, kind, num } = target;
  const foundKeys = new Set(keys);

  // Baseline BEFORE this pass's copies land, so a lone FIRST-time adoption
  // isn't judged against a prefix count its own copy just inflated. Legacy
  // attachments outside the ledger (manual `attach --pr`, pre-#709 adoptions)
  // still count here; ledgered adoptions feed the guard separately below.
  const before = await gatherCommentBody(env, ws, workspaceName, target, { shadow: false });

  for (const key of keys) {
    // A URL that already points at this PR/issue's attachment prefix is the
    // attachment itself (promoted copy, or a dest-URL rewrite). Don't copy
    // it onto itself or take adopt-ownership; the dest-key check below
    // still counts it as "referenced."
    if (isTargetAttachmentKey(key, target)) continue;
    const row = await adoptLedgerRow(db, repo, kind, num, key);
    if (row) {
      if (row.detachedAt === null) {
        // Already adopted and currently attached under some source — cheap
        // skip, never re-copies. If the link moved between sources (e.g. an
        // edit relocated it from the body into a comment), the ledger's
        // source pointer follows.
        if (row.source !== source) await setAdoptLedgerSource(db, repo, kind, num, key, source);
        continue;
      }
      // Previously detached, now referenced again — un-detach without a
      // re-copy; the object is still in storage untouched.
      await setFileMetadata(db, workspaceName, row.objectKey, { "gh.detached": "false" });
      await reattachAttachmentSafe(db, workspaceName, row.objectKey);
      await setAdoptLedgerDetached(db, repo, kind, num, key, null);
      if (row.source !== source) await setAdoptLedgerSource(db, repo, kind, num, key, source);
      summary.reattached.push(row.objectKey);
      continue;
    }

    try {
      // Attachment index (issue #934): `indexSource` makes the copy's own
      // (single) row say "adopt" rather than "attach", so the write path
      // stays attributable. The repo it records is `target.repo`, the
      // webhook-resolved one, passed on by attachExistingObject.
      const result = await attachExistingObject(
        env,
        ws,
        workspaceName,
        {
          source: key,
          target: { repo: target.repo, kind: target.kind, num: target.num },
        },
        { indexSource: "adopt" },
      );
      await setFileMetadata(db, workspaceName, result.key, { "gh.detached": "false" });
      await recordAdoptedLink(db, {
        repo,
        kind,
        num,
        sourceKey: key,
        workspace: workspaceName,
        objectKey: result.key,
        source,
        createdAt: new Date().toISOString(),
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

  // Un-adoption: a ledgered key for THIS source that's no longer referenced
  // when this source is rescanned. Scoped by source (not the whole target)
  // so a link still referenced from a different comment isn't detached just
  // because this particular comment stopped mentioning it.
  //
  // Referenced = the original source key OR the destination key still
  // appears in the text (issue #865: a staged URL rewritten to the
  // `pull/<n>/` dest is the same file, not a removal).
  const existingForSource = await adoptLedgerRowsForSource(db, repo, kind, num, source);
  for (const row of existingForSource) {
    const referenced = foundKeys.has(row.sourceKey) || foundKeys.has(row.objectKey);
    if (referenced) {
      if (row.detachedAt !== null) {
        await setFileMetadata(db, workspaceName, row.objectKey, { "gh.detached": "false" });
        await reattachAttachmentSafe(db, workspaceName, row.objectKey);
        await setAdoptLedgerDetached(db, repo, kind, num, row.sourceKey, null);
        summary.reattached.push(row.objectKey);
      }
      continue;
    }
    if (row.detachedAt !== null) continue;
    await setFileMetadata(db, workspaceName, row.objectKey, { "gh.detached": "true" });
    await detachAttachmentSafe(db, workspaceName, row.objectKey);
    await setAdoptLedgerDetached(db, repo, kind, num, row.sourceKey, new Date().toISOString());
    summary.detached.push(row.objectKey);
  }

  const changed =
    summary.adopted.length > 0 || summary.reattached.length > 0 || summary.detached.length > 0;
  if (!changed) return summary;

  const totalAdopted = (await adoptLedgerRowsForTarget(db, repo, kind, num)).filter(
    (r) => r.detachedAt === null,
  ).length;

  const sync = await shouldSyncAfterAdopt(
    env,
    workspaceName,
    target,
    totalAdopted,
    before.count,
    summary.detached.length > 0,
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
  const link = await findRepoLinkStrict(dbFor(env), ref.repo);
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
  // `text === null` (source deleted, e.g. a comment removed) still needs to
  // reconcile — any links previously adopted from it must detach — so it
  // scans as empty text rather than short-circuiting. A merely-linkless
  // text is the same case (nothing new to adopt, but a prior adoption from
  // this exact source may need to detach), so `hasLinkCandidate` is no
  // longer a valid early-return here — only a cheap presort in the caller
  // that decided `ev.adopt` was worth building at all.
  await adoptLinkedFiles(
    env,
    link.workspaceName,
    null,
    { repo: ref.repo, kind: ref.kind, num: ref.num },
    text ?? "",
    ref.source,
  );
}
