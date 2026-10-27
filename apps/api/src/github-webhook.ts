/**
 * GitHub App webhooks. Every delivery is HMAC-verified, then turned into a
 * compact `WebhookEvent` (`extractWebhookEvent`, pure) and processed
 * (`processWebhookEvent`). With `GITHUB_WEBHOOK_QUEUE` bound the compact
 * event is enqueued (raw payloads can exceed the 128 KB message cap) and
 * processed with retries and a DLQ; otherwise, or if the send fails, it runs
 * inline via `waitUntil`. Partial payloads mean "nothing to do", never a
 * throw.
 *
 * - Cache invalidation: targeted KV deletes against GITHUB_CACHE. A dropped
 *   delete only reverts to TTL latency.
 * - Auto-promotion (`pull_request` opened/reopened/synchronize): for a bound
 *   repo, promote the branch's staged attachments into the PR and upsert
 *   the managed comment.
 * - Reconcile (`issue_comment` edited/deleted): heal the managed comment
 *   when it's deleted or mangled. A cheap payload check gates it, since the
 *   event fires on every comment.
 * - Merge tagging (`pull_request` closed + merged): stamp the PR's
 *   screenshots `gh.merged=true`, found by metadata so private keys are
 *   covered. The only PR lifecycle fact persisted; open/closed stay live in
 *   the title cache.
 * - Visibility (`repository` privatized/publicized): write through to the
 *   `ghpriv:` cache; `privatized` also bumps the public-title epoch so cached
 *   public titles stop serving at once.
 */

import { hasIngestableAttachmentUrl, hasRepoMediaUrl } from "./github-attachment-extract";
import { cacheRepoPrivacy, githubAppConfig, installationForRepo } from "./github-app";
import { commentCacheKey, gatherCommentBody, upsertBotComment } from "./github-comment";
import { checksDeniedKey, syncUploadsCheck } from "./github-check-run";
import { bumpPublicTitleEpoch, titleCacheKeys } from "./github-titles";
import { applyPrActivityWebhook, type PrState } from "./github-pr-activity";
import { ATTACHMENTS_MARKER } from "./github-comment-render";
import { findObjectsByMetadata, setFileMetadata } from "./file-metadata";
import type { GhTarget } from "./github-comment-render";
import { ingestForWebhook, type IngestSourceRef } from "./github-ingest";
import {
  adoptLinkedFilesForWebhook,
  hasLinkCandidate,
  type AdoptSourceRef,
} from "./github-link-adopt";
import { promoteBranchAttachments } from "./github-promote";
// Strict lookup: a D1 outage must throw so the queue retries, not read as
// "repo not linked".
import { deleteRepoLink, findRepoLinkStrict, type RepoLink } from "./github-repo-links";
import { loadWorkspaceRecord } from "./workspace";
import { resolveRepoCommentOptions } from "./repo-comment-config";
import { matchingSkipLabel } from "./github-check-requirements";
import { dbFor } from "./db-session";
import { recordAdoptionSafe } from "./adoption";

const enc = new TextEncoder();

/** Lowercase hex HMAC-SHA256 of `body` under `secret`, matching GitHub's digest. */
async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  let hex = "";
  for (const b of new Uint8Array(sig)) hex += b.toString(16).padStart(2, "0");
  return hex;
}

// Hand-rolled rather than `crypto.subtle.timingSafeEqual`, which is
// Workers-only and would leave this path untestable under Node vitest.
/** Constant-time compare of two hex strings (length check + XOR accumulate). */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * True iff `signatureHeader` (`X-Hub-Signature-256`, `sha256=<hex>`) is a valid
 * HMAC of the exact raw body under `secret`. Callers MUST verify before parsing
 * JSON — the signature is over the bytes GitHub sent.
 */
export async function verifySignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): Promise<boolean> {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const provided = signatureHeader.slice("sha256=".length);
  const expected = await hmacSha256Hex(secret, rawBody);
  return timingSafeEqualHex(provided, expected);
}

/** Lowercased `full_name` strings from a repositories-array field; [] if absent/malformed. */
function repoFullNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const name = (entry as { full_name?: unknown } | null)?.full_name;
    if (typeof name === "string") out.push(name.toLowerCase());
  }
  return out;
}

/** `pull_request` actions that trigger auto-promotion (a fresh/updated head to promote from). */
const PROMOTE_ACTIONS = new Set(["opened", "reopened", "synchronize"]);

/** `pull_request` actions whose payload title/state goes onto the PR rollup row. */
const PR_ACTIVITY_ACTIONS = new Set(["opened", "edited", "closed", "reopened"]);

/** Rollup state from a `pull_request` delivery, or null when the action is not one we record. */
function pullRequestState(action: unknown, pr: PullRequestPayload["pull_request"]): PrState | null {
  if (typeof action !== "string" || !PR_ACTIVITY_ACTIONS.has(action) || !pr) return null;
  const merged =
    pr.merged === true || (typeof pr.merged_at === "string" && pr.merged_at.length > 0);
  if (action === "closed") return merged ? "merged" : "closed";
  if (action === "opened" || action === "reopened") return "open";
  if (pr.state === "closed") return merged ? "merged" : "closed";
  if (pr.state === "open") return "open";
  return null;
}

/** `{ repo, isPrivate }` when `repo` carries a boolean `private` field, else undefined. */
function repoPrivacy(
  repo: PullRequestPayload["repository"] | IssueCommentPayload["repository"],
): WebhookEvent["privacy"] {
  if (typeof repo?.full_name === "string" && typeof repo.private === "boolean") {
    return { repo: repo.full_name, isPrivate: repo.private };
  }
  return undefined;
}

interface PullRequestPayload {
  action?: unknown;
  repository?: { full_name?: unknown; private?: unknown };
  pull_request?: {
    number?: unknown;
    title?: unknown;
    state?: unknown;
    merged_at?: unknown;
    /** Only meaningful on `action: "closed"` — true iff the PR was merged
     * (vs. closed without merging). */
    merged?: unknown;
    head?: { ref?: unknown; sha?: unknown; repo?: { full_name?: unknown } };
  };
}

/**
 * A comment + check re-sync one step of a delivery asked for. Steps return
 * these instead of syncing, so `processWebhookEvent` gathers once per target
 * after every step has run (each gather lists R2 per attachment prefix).
 */
interface PendingSync {
  link: RepoLink;
  target: GhTarget;
  headBranch?: string;
  headSha?: string;
}

/** Collapse syncs for the same target, keeping the first head branch/sha. */
export function mergePendingSyncs(syncs: readonly PendingSync[]): PendingSync[] {
  const byTarget = new Map<string, PendingSync>();
  for (const s of syncs) {
    const key = `${s.target.repo.toLowerCase()}#${s.target.kind}#${s.target.num}`;
    const prev = byTarget.get(key);
    if (!prev) {
      byTarget.set(key, { ...s });
      continue;
    }
    prev.headBranch ??= s.headBranch;
    prev.headSha ??= s.headSha;
  }
  return [...byTarget.values()];
}

/**
 * Gather the bound workspace's attachments for `target` and upsert the
 * managed comment. A missing or tombstoned workspace cleans up the stale link
 * and no-ops; never creates a link. Caller catches. Resolves to the upsert's
 * action, or null when nothing was attempted.
 */
async function gatherAndUpsert(
  env: Env,
  link: RepoLink,
  target: GhTarget,
  opts: { headBranch?: string; headSha?: string } = {},
): Promise<"created" | "updated" | "skipped" | null> {
  const ws = await loadWorkspaceRecord(env, link.workspaceName);
  if (!ws) {
    // Stale link: delete it so first-claim-wins doesn't block a future claim.
    await deleteRepoLink(dbFor(env), target.repo);
    return null;
  }

  const gathered = await gatherCommentBody(env, ws, link.workspaceName, target, {
    headBranch: opts.headBranch,
    detectUiChanges: true,
  });

  const cfg = githubAppConfig(env);
  if (!cfg) return null;
  const installId = link.installationId ?? (await installationForRepo(env, cfg, target.repo));
  if (installId === null) return null;

  // Never create a comment just to say "empty" (this fires on every PR event
  // for a bound repo), except the no-uploads how-to a repo opts into.
  const result = await upsertBotComment(
    env,
    cfg,
    installId,
    target,
    gathered.body,
    link.workspaceName,
    fetch,
    { createIfMissing: gathered.count > 0 || gathered.noUploads },
  );
  if ("degrade" in result) {
    console.error(
      JSON.stringify({
        message: "webhook bot-comment degraded",
        repo: target.repo,
        num: target.num,
        reason: result.degrade,
      }),
    );
  }
  await syncUploadsCheck(env, cfg, installId, target, gathered, {
    headSha: opts.headSha,
    commentUrl: "commentUrl" in result ? result.commentUrl : null,
    workspaceName: link.workspaceName,
  });
  return "degrade" in result ? null : result.action;
}

/**
 * The repo's bound workspace, or null (deleting the link if its workspace is
 * gone, so first-claim-wins never blocks forever). Never creates a link.
 */
async function resolveLinkedWorkspaceOrCleanup(
  env: Env,
  repo: string,
): Promise<{
  link: RepoLink;
  ws: NonNullable<Awaited<ReturnType<typeof loadWorkspaceRecord>>>;
} | null> {
  const link = await findRepoLinkStrict(dbFor(env), repo);
  if (!link) return null;

  const ws = await loadWorkspaceRecord(env, link.workspaceName);
  if (!ws) {
    await deleteRepoLink(dbFor(env), repo);
    return null;
  }
  return { link, ws };
}

/**
 * Webhook auto-promotion for one bound repo/PR. No-ops without a valid link.
 * Downstream failures throw; the caller decides between queue retry and
 * log-and-swallow. The comment sync runs later, after the promoted copies
 * have landed.
 */
async function autoPromote(
  env: Env,
  repo: string,
  num: number,
  branch: string,
  headSha?: string,
): Promise<PendingSync | null> {
  const resolved = await resolveLinkedWorkspaceOrCleanup(env, repo);
  if (!resolved) return null;
  const { link, ws } = resolved;

  await promoteBranchAttachments(env, ws, link.workspaceName, { repo, num, branch });

  // A metadata-less private attachment resolves under the head branch.
  return { link, target: { repo, kind: "pull", num }, headBranch: branch, headSha };
}

/**
 * Webhook merge tagging for one bound repo/PR. Finds screenshots by
 * metadata (`gh.ref`/`gh.kind`), so private keys are covered. Per-shot
 * stamping is best-effort; a D1 outage resolving or listing throws so the
 * queue retries.
 */
async function stampMergedScreenshots(env: Env, repo: string, num: number): Promise<void> {
  const resolved = await resolveLinkedWorkspaceOrCleanup(env, repo);
  if (!resolved) return;
  const { link } = resolved;

  const [owner, name] = repo.split("/");
  const ref = `${owner}/${name}#${num}`.toLowerCase();
  const matches = await findObjectsByMetadata(dbFor(env), link.workspaceName, {
    "gh.ref": ref,
    "gh.kind": "pull",
  });

  for (const match of matches) {
    try {
      await setFileMetadata(dbFor(env), link.workspaceName, match.key, { "gh.merged": "true" });
    } catch (err) {
      console.error(
        JSON.stringify({
          message: "webhook: failed to stamp gh.merged",
          repo,
          num,
          key: match.key,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
}

/** Substring shared by every marker variant (legacy and per-workspace). */
const MARKER_SUBSTRING = ATTACHMENTS_MARKER.replace(/^<!--\s*|\s*-->$/g, "");

interface IssueCommentPayload {
  action?: unknown;
  repository?: { full_name?: unknown; private?: unknown };
  issue?: { number?: unknown; pull_request?: unknown };
  comment?: { id?: unknown; body?: unknown; user?: { login?: unknown; type?: unknown } };
  sender?: { login?: unknown; type?: unknown };
}

/**
 * Whether an `issue_comment` delivery is worth reconciling. Fires on every
 * comment, so this is a pure payload read with no I/O.
 *
 * - `created`: never.
 * - `deleted`: only a bot-authored comment whose body has the marker.
 * - `edited`: only when the body still has the marker and the sender isn't a
 *   bot (our own PATCH would otherwise loop).
 */
function isReconcilableCommentEvent(p: IssueCommentPayload): boolean {
  const body = p.comment?.body;
  if (typeof body !== "string" || !body.includes(MARKER_SUBSTRING)) return false;

  if (p.action === "deleted") {
    return p.comment?.user?.type === "Bot";
  }
  if (p.action === "edited") {
    if (p.sender?.type === "Bot") return false; // our own write — no loop.
    return true;
  }
  return false; // "created" and anything else.
}

/**
 * Reconcile one gated `issue_comment`: drop the stale cached comment id and
 * ask for a re-sync. No-ops without a binding; failures throw. Never
 * creates a binding.
 */
async function reconcileBotComment(
  env: Env,
  repo: string,
  num: number,
  kind: GhTarget["kind"],
): Promise<PendingSync | null> {
  const link = await findRepoLinkStrict(dbFor(env), repo);
  if (!link) return null;

  const target: GhTarget = { repo, kind, num };
  // Force a fresh marker search; the cached id may be the deleted comment.
  await env.GITHUB_CACHE.delete(commentCacheKey(link.workspaceName, target));

  return { link, target };
}

/**
 * A skip label was added or removed: re-sync the comment and check, so the
 * check passes right away. Other labels, and repos that don't require
 * uploads, skip the work. Throws like reconcile.
 */
async function recheckForLabels(
  env: Env,
  repo: string,
  num: number,
  label: string,
): Promise<PendingSync | null> {
  const link = await findRepoLinkStrict(dbFor(env), repo);
  if (!link) return null;
  const ws = await loadWorkspaceRecord(env, link.workspaceName);
  if (!ws) return null;
  const { options } = await resolveRepoCommentOptions(env, ws, repo);
  if (options.checkRequire.length === 0) return null;
  if (!matchingSkipLabel([label], options.checkSkipLabels)) return null;
  return { link, target: { repo, kind: "pull", num } };
}

/**
 * A PR's description or a comment changed in a way that wakes ingest: re-sync
 * the comment and check, so screenshots dragged in on GitHub count right
 * away, imported or not. Throws like reconcile.
 */
async function recheckForGithubAttachments(
  env: Env,
  repo: string,
  num: number,
): Promise<PendingSync | null> {
  const link = await findRepoLinkStrict(dbFor(env), repo);
  if (!link) return null;
  return { link, target: { repo, kind: "pull", num } };
}

/**
 * Compact, queue-safe work for one delivery (never the raw payload, which
 * can exceed the 128 KB cap).
 */
export interface WebhookEvent {
  /** GITHUB_CACHE keys to delete (targeted; possibly empty). */
  keys: string[];
  /** Same-repo PR opened/reopened/synchronize → promote + comment + check
   * run on the head commit (`sha`, absent on older queued events). */
  promote?: { repo: string; num: number; branch: string; sha?: string };
  /** Gated issue_comment edited/deleted → heal the managed comment. */
  reconcile?: { repo: string; num: number; kind: GhTarget["kind"] };
  /** Same-repo PR closed with `merged: true` → stamp `gh.merged=true`. */
  merge?: { repo: string; num: number };
  /** Opt-in GitHub attachment ingest. Source ref only; the consumer
   * re-fetches current text. */
  ingest?: IngestSourceRef;
  /** Opt-in uploads.sh link adoption. Source ref only, like `ingest`. */
  adopt?: AdoptSourceRef;
  /** Write-through for `repoIsPrivate`'s cache, saving a GitHub API call. */
  privacy?: { repo: string; isPrivate: boolean };
  /** `repository` privatized: lowercased `owner/name` whose public-title
   * epoch to bump. */
  privatized?: string;
  /** PR opened/edited/closed/reopened → title and state onto the rollup row
   * (update only, linked repos only). */
  prActivity?: { repo: string; number: number; title: string; state: PrState };
  /** `pull_request` labeled/unlabeled → re-sync the check, since a skip
   * label can excuse required uploads (`check.skipLabels`). */
  labels?: { repo: string; num: number; label: string };
  /** PR comment created/deleted with repo-hosted media and no ingestable
   * url → re-sync the check, which counts those links too. Edits already
   * re-sync through `ingest`. */
  recheck?: { repo: string; num: number };
}

/**
 * Delivery → `WebhookEvent`, or null when there's no work. Never throws on
 * malformed payloads.
 */
export function extractWebhookEvent(eventType: string, payload: unknown): WebhookEvent | null {
  const p = (payload ?? {}) as Record<string, unknown>;
  const ev: WebhookEvent = { keys: [] };

  if (eventType === "installation") {
    const id = (p.installation as { id?: unknown } | undefined)?.id;
    // The denied-checks marker too: accepting a new permission (e.g.
    // Checks: write) arrives as an `installation` event.
    if (typeof id === "number") ev.keys.push(`ghtok:${id}`, checksDeniedKey(id));
    for (const repo of repoFullNames(p.repositories)) ev.keys.push(`ghinst:${repo}`);
  } else if (eventType === "installation_repositories") {
    for (const repo of repoFullNames(p.repositories_added)) ev.keys.push(`ghinst:${repo}`);
    for (const repo of repoFullNames(p.repositories_removed)) ev.keys.push(`ghinst:${repo}`);
  } else if (eventType === "issues" || eventType === "pull_request") {
    const fullName = (p.repository as { full_name?: unknown } | undefined)?.full_name;
    const item = (eventType === "issues" ? p.issue : p.pull_request) as
      | { number?: unknown; body?: unknown }
      | undefined;
    if (typeof fullName === "string" && typeof item?.number === "number") {
      ev.keys.push(...titleCacheKeys(`${fullName.toLowerCase()}#${item.number}`));

      // Ingest: opened is gated on GitHub user-attachments or public Cursor
      // art-* URLs (viewer and agent-page links don't count); edited on any
      // body change, since a removal leaves no URL behind. Not lowercased;
      // the ledger normalizes.
      const action = p.action;
      const kind: GhTarget["kind"] = eventType === "pull_request" ? "pull" : "issues";
      if (
        action === "opened" &&
        typeof item.body === "string" &&
        hasIngestableAttachmentUrl(item.body)
      ) {
        ev.ingest = { repo: fullName, kind, num: item.number, source: "body" };
      } else if (action === "edited") {
        const changes = p.changes as { body?: unknown } | undefined;
        if (changes && "body" in changes) {
          ev.ingest = { repo: fullName, kind, num: item.number, source: "body" };
        }
      }

      // Adopt: same shape as ingest, gated on any http(s) link; the consumer
      // does the real resolution.
      if (action === "opened" && typeof item.body === "string" && hasLinkCandidate(item.body)) {
        ev.adopt = { repo: fullName, kind, num: item.number, source: "body" };
      } else if (action === "edited") {
        const changes = p.changes as { body?: unknown } | undefined;
        if (changes && "body" in changes) {
          ev.adopt = { repo: fullName, kind, num: item.number, source: "body" };
        }
      }
    }
  }

  if (eventType === "pull_request") {
    const pp = p as PullRequestPayload;
    ev.privacy = repoPrivacy(pp.repository);
    const action = pp.action;
    const repo = pp.repository?.full_name;
    const pr = pp.pull_request;
    const prState = pullRequestState(action, pr);
    if (
      prState &&
      typeof repo === "string" &&
      typeof pr?.number === "number" &&
      typeof pr.title === "string"
    ) {
      ev.prActivity = { repo, number: pr.number, title: pr.title, state: prState };
    }
    const label = (pp as { label?: { name?: unknown } }).label?.name;
    if (
      (action === "labeled" || action === "unlabeled") &&
      typeof repo === "string" &&
      typeof pr?.number === "number" &&
      typeof label === "string"
    ) {
      ev.labels = { repo, num: pr.number, label };
    }
    if (
      typeof action === "string" &&
      PROMOTE_ACTIONS.has(action) &&
      typeof repo === "string" &&
      typeof pr?.number === "number" &&
      typeof pr.head?.ref === "string" &&
      typeof pr.head.repo?.full_name === "string" &&
      // Never promote against a head branch in a fork.
      pr.head.repo.full_name.toLowerCase() === repo.toLowerCase()
    ) {
      ev.promote = {
        repo,
        num: pr.number,
        branch: pr.head.ref,
        ...(typeof pr.head.sha === "string" ? { sha: pr.head.sha } : {}),
      };
    } else if (
      // Closed without merging is a no-op.
      action === "closed" &&
      pr?.merged === true &&
      typeof repo === "string" &&
      typeof pr.number === "number" &&
      typeof pr.head?.repo?.full_name === "string" &&
      // Same fork guard as promote.
      pr.head.repo.full_name.toLowerCase() === repo.toLowerCase()
    ) {
      ev.merge = { repo, num: pr.number };
    }
  } else if (eventType === "repository") {
    // Keyed by the lowercased name, as the title caches are. The action is
    // authoritative, not `repository.private`.
    const fullName = (p.repository as { full_name?: unknown } | undefined)?.full_name;
    if (typeof fullName === "string" && (p.action === "privatized" || p.action === "publicized")) {
      const repo = fullName.toLowerCase();
      ev.privacy = { repo, isPrivate: p.action === "privatized" };
      if (p.action === "privatized") ev.privatized = repo;
    }
  } else if (eventType === "issue_comment") {
    // The cheap payload gate runs before any I/O or enqueue.
    const ip = p as IssueCommentPayload;
    ev.privacy = repoPrivacy(ip.repository);
    const repo = ip.repository?.full_name;
    const num = ip.issue?.number;
    if (isReconcilableCommentEvent(ip) && typeof repo === "string" && typeof num === "number") {
      ev.reconcile = { repo, num, kind: ip.issue?.pull_request ? "pull" : "issues" };
    }

    // Ingest: created/deleted are gated on user-attachments or public Cursor
    // art-* URLs (a deleted comment's payload has its old body; the
    // consumer's GET then 404s and detaches). edited always fires unless the
    // sender is a bot, since a removal is invisible in the new body.
    const commentId = ip.comment?.id;
    if (typeof repo === "string" && typeof num === "number" && typeof commentId === "number") {
      const kind: GhTarget["kind"] = ip.issue?.pull_request ? "pull" : "issues";
      const source = `comment:${commentId}`;
      const body = ip.comment?.body;
      const hasUrl = typeof body === "string" && hasIngestableAttachmentUrl(body);
      const gated =
        (ip.action === "created" && hasUrl) ||
        (ip.action === "edited" && ip.sender?.type !== "Bot") ||
        (ip.action === "deleted" && hasUrl);
      if (gated) {
        ev.ingest = { repo, kind, num, source };
      } else if (
        kind === "pull" &&
        (ip.action === "created" || ip.action === "deleted") &&
        typeof body === "string" &&
        hasRepoMediaUrl(body)
      ) {
        ev.recheck = { repo, num };
      }

      // Adopt: like ingest, but a deleted comment leaves nothing to adopt.
      const hasLinkUrl = typeof body === "string" && hasLinkCandidate(body);
      const adoptGated =
        (ip.action === "created" && hasLinkUrl) ||
        (ip.action === "edited" && ip.sender?.type !== "Bot");
      if (adoptGated) {
        ev.adopt = { repo, kind, num, source };
      }
    }
  }
  // ping and unknown events fall through with no work.

  return ev.keys.length ||
    ev.promote ||
    ev.reconcile ||
    ev.ingest ||
    ev.adopt ||
    ev.merge ||
    ev.privacy ||
    ev.privatized ||
    ev.prActivity ||
    ev.labels ||
    ev.recheck
    ? ev
    : null;
}

/**
 * Run one `WebhookEvent`. KV deletes are allSettled (a failed delete
 * self-heals on TTL). Promote/reconcile failures throw: the queue retries
 * toward the DLQ; the inline path catches and logs. Every step that wants
 * the comment re-synced queues a `PendingSync`; one gather+upsert per target
 * runs after all of them, so the comment and check see promote, ingest and
 * adoption together.
 */
export async function processWebhookEvent(env: Env, ev: WebhookEvent): Promise<void> {
  if (ev.privacy) {
    // Best-effort priming; a KV outage must not block the work below.
    try {
      await cacheRepoPrivacy(env, ev.privacy.repo, ev.privacy.isPrivate);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const line = JSON.stringify({
        message: "webhook privacy cache write-through failed",
        repo: ev.privacy.repo,
        error,
      });
      // A KV write-rate 429 only skips this priming; readers fall back to
      // the GitHub API.
      if (error.includes("429")) console.warn(line);
      else console.error(line);
    }
  }

  if (ev.privatized) {
    // This write is the point of the event, so let it throw for a retry.
    await bumpPublicTitleEpoch(env, ev.privatized);
  }

  await Promise.allSettled(ev.keys.map((key) => env.GITHUB_CACHE.delete(key)));

  // Before promote/reconcile, which can throw for a retry. Never throws.
  if (ev.prActivity) {
    await applyPrActivityWebhook(dbFor(env), ev.prActivity);
  }

  const syncs: PendingSync[] = [];
  const want = (s: PendingSync | null) => {
    if (s) syncs.push(s);
  };

  if (ev.promote) {
    want(
      await autoPromote(env, ev.promote.repo, ev.promote.num, ev.promote.branch, ev.promote.sha),
    );
  }
  if (ev.reconcile) {
    want(await reconcileBotComment(env, ev.reconcile.repo, ev.reconcile.num, ev.reconcile.kind));
  }
  if (ev.labels) {
    want(await recheckForLabels(env, ev.labels.repo, ev.labels.num, ev.labels.label));
  }
  if (ev.ingest) {
    await ingestForWebhook(env, ev.ingest);
  }
  const recheck = ev.ingest?.kind === "pull" ? ev.ingest : ev.recheck;
  if (recheck) {
    want(await recheckForGithubAttachments(env, recheck.repo, recheck.num));
  }
  let adoptKey: string | null = null;
  if (ev.adopt) {
    const link = await adoptLinkedFilesForWebhook(env, ev.adopt, { deferSync: true });
    if (link) {
      const target: GhTarget = { repo: ev.adopt.repo, kind: ev.adopt.kind, num: ev.adopt.num };
      want({ link, target });
      adoptKey = `${target.repo.toLowerCase()}#${target.kind}#${target.num}`;
    }
  }

  for (const s of mergePendingSyncs(syncs)) {
    const action = await gatherAndUpsert(env, s.link, s.target, s);
    // The adoption path used to post through postManagedComment, which
    // counts posted comments; keep that metric now that it syncs here.
    const key = `${s.target.repo.toLowerCase()}#${s.target.kind}#${s.target.num}`;
    if (key === adoptKey && (action === "created" || action === "updated")) {
      await recordAdoptionSafe(env, { metric: "comment_posted", workspace: s.link.workspaceName });
    }
  }

  if (ev.merge) {
    await stampMergedScreenshots(env, ev.merge.repo, ev.merge.num);
  }
}

/** `processWebhookEvent` with failures logged: the inline path never 5xxs. */
async function processInline(env: Env, ev: WebhookEvent): Promise<void> {
  try {
    await processWebhookEvent(env, ev);
  } catch (err) {
    console.error(
      JSON.stringify({
        message: "webhook inline processing failed",
        promote: ev.promote ?? null,
        reconcile: ev.reconcile ?? null,
        ingest: ev.ingest ?? null,
        adopt: ev.adopt ?? null,
        merge: ev.merge ?? null,
        privatized: ev.privatized ?? null,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/**
 * Handle one verified delivery: enqueue the compact event, or run it inline
 * via `waitUntil` without a queue or on a failed send. The inline path
 * swallows failures so the route still returns 204.
 */
export async function handleWebhook(
  env: Env,
  eventType: string,
  payload: unknown,
  ctx?: Pick<ExecutionContext, "waitUntil">,
): Promise<void> {
  const ev = extractWebhookEvent(eventType, payload);
  if (!ev) return;

  // A local cast: an optional env.d.ts declaration would conflict with the
  // generated one, and builds without the queue must still typecheck.
  const queue = (env as { GITHUB_WEBHOOK_QUEUE?: Queue<WebhookEvent> }).GITHUB_WEBHOOK_QUEUE;
  if (queue) {
    try {
      await queue.send(ev);
      return;
    } catch (err) {
      // Queue outage must not drop the delivery — degrade to the inline path.
      console.error(
        JSON.stringify({
          message: "webhook queue send failed; processing inline",
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  const work = processInline(env, ev);
  if (ctx) ctx.waitUntil(work);
  else await work; // no executionCtx (e.g. some test/call sites) — run inline.
}
