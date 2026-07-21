/**
 * GitHub App webhook verification + cache invalidation (spec
 * .context/284-github-webhooks-design.md), plus phase 3 webhook-driven
 * auto-promotion. Every delivery is HMAC-verified, then dispatched to a set
 * of targeted KV deletes against GITHUB_CACHE — no key-prefix scans. All
 * handlers tolerate missing fields: a partial payload means "nothing to
 * invalidate here", never a throw. Entries self-heal via their phase-1 TTLs,
 * so a dropped delete only reverts to TTL latency.
 *
 * Auto-promotion (`pull_request` `opened`/`reopened`/`synchronize`): if the
 * PR's repo is bound to a workspace (github-repo-links.ts), that workspace's
 * branch-staged attachments are promoted into the PR's attachment prefix
 * (reusing github-promote.ts) and the managed bot comment is upserted
 * (reusing github-comment.ts's gather+render+upsert) — with zero CLI
 * involvement. This runs off the request's fast path via `ctx.waitUntil` so
 * the webhook still responds 204 promptly; every failure inside is caught
 * and logged, never surfaced as a 5xx.
 *
 * Reconcile (`issue_comment` `edited`/`deleted`, issue #291): heals the
 * managed comment when it's deleted or mangled out from under the bot (the
 * cached `ghcomment:` id going stale). Gated by a cheap, I/O-free payload
 * check (`isReconcilableCommentEvent`) since this event fires on every
 * comment in every installed repo — only a bot-authored deletion or an edit
 * still carrying the attachments marker proceeds to the (binding-gated)
 * gather+upsert. Same `ctx.waitUntil`/degrade-safe doctrine as above; never
 * creates a repo binding, only consumes `findRepoLink`.
 *
 * Queue ingestion (issue #287): payload parsing is split into a pure
 * `extractWebhookEvent` (delivery → compact `WebhookEvent` or null) and an
 * effectful `processWebhookEvent` (KV deletes + promote/reconcile). When the
 * `GITHUB_WEBHOOK_QUEUE` producer binding is present, `handleWebhook`
 * enqueues the compact event — never the raw payload, which can exceed the
 * 128 KB queue message cap — and the `queue()` consumer (index.ts →
 * github-webhook-queue.ts) processes it with retries + a DLQ. Without the
 * binding (tests, local dev without queues, or a send failure) it falls back
 * to the previous inline waitUntil path, so the endpoint keeps working
 * degraded rather than dropping deliveries.
 */

import { githubAppConfig, installationForRepo } from "./github-app";
import { commentCacheKey, gatherCommentBody, upsertBotComment } from "./github-comment";
import { ATTACHMENTS_MARKER } from "./github-comment-render";
import type { GhTarget } from "./github-comment-render";
import { promoteBranchAttachments } from "./github-promote";
// Strict lookup on purpose (#287): a D1 outage must THROW so the queue
// consumer retries the event, not read as "repo not linked" and ack-drop it.
import { deleteRepoLink, findRepoLinkStrict, type RepoLink } from "./github-repo-links";
import { loadWorkspaceRecord } from "./workspace";

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

// Constant-time compare is hand-rolled over the hex strings rather than via the
// Workers-native `crypto.subtle.timingSafeEqual` (as admin.ts/workspace.ts do):
// that API is a Workers-only extension absent from this repo's plain-Node vitest
// runtime, so reusing it would make this security-sensitive path untestable.
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

interface PullRequestPayload {
  action?: unknown;
  repository?: { full_name?: unknown };
  pull_request?: {
    number?: unknown;
    head?: { ref?: unknown; repo?: { full_name?: unknown } };
  };
}

/**
 * Look up the repo's bound workspace, gather its own current attachments for
 * `target`, and upsert the managed comment from that render. Shared by both
 * auto-promotion (after a fresh promote) and reconcile (after an
 * invalidation) — read/delete-only against `github_repo_links` per the #326
 * gate: a missing/tombstoned linked workspace cleans up the stale link and
 * no-ops, never creates a new one. Caller is responsible for catching.
 */
async function gatherAndUpsert(env: Env, link: RepoLink, target: GhTarget): Promise<void> {
  const ws = await loadWorkspaceRecord(env, link.workspaceName);
  if (!ws) {
    // The bound workspace is gone or tombstoned — the link is stale;
    // clean it up so a future claim (e.g. from another workspace) isn't
    // blocked by first-claim-wins forever.
    await deleteRepoLink(env.DB, target.repo);
    return;
  }

  const gathered = await gatherCommentBody(env, ws, link.workspaceName, target);
  if (gathered.skip) return; // nothing staged and nothing pre-existing — no empty comment.

  const cfg = githubAppConfig(env);
  if (!cfg) return;
  const installId = link.installationId ?? (await installationForRepo(env, cfg, target.repo));
  if (installId === null) return;

  const result = await upsertBotComment(
    env,
    cfg,
    installId,
    target,
    gathered.body,
    link.workspaceName,
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
}

/**
 * Webhook-driven auto-promotion for one bound repo/PR. No-ops on: no repo
 * link or a missing/tombstoned linked workspace. Downstream promote/gather/
 * comment failures THROW — the caller decides whether that means a queue
 * retry (consumer) or a swallow-and-log (inline fallback). Reuses
 * `promoteBranchAttachments` and `gatherAndUpsert` (which itself reuses
 * `gatherCommentBody`/`upsertBotComment` verbatim) — no duplicated
 * copy/render/post logic.
 */
async function autoPromoteAndComment(
  env: Env,
  repo: string,
  num: number,
  branch: string,
): Promise<void> {
  const link = await findRepoLinkStrict(env.DB, repo);
  if (!link) return;

  const ws = await loadWorkspaceRecord(env, link.workspaceName);
  if (!ws) {
    await deleteRepoLink(env.DB, repo);
    return;
  }

  await promoteBranchAttachments(env, ws, link.workspaceName, { repo, num, branch });

  // Gather AFTER promoting: the just-promoted copies are now real objects
  // under the PR's attachment prefix, so this single gather call already
  // reflects them — no separate "promoted > 0" branch needed.
  const target: GhTarget = { repo, kind: "pull", num };
  await gatherAndUpsert(env, link, target);
}

/** Substring shared by every managed-comment marker variant (legacy + the
 * per-workspace `ws=<slug>` namespaced form) — cheap to test for without
 * parsing which marker it is. Derived from `ATTACHMENTS_MARKER` so there is
 * one source of truth for the literal. */
const MARKER_SUBSTRING = ATTACHMENTS_MARKER.replace(/^<!--\s*|\s*-->$/g, "");

interface IssueCommentPayload {
  action?: unknown;
  repository?: { full_name?: unknown };
  issue?: { number?: unknown; pull_request?: unknown };
  comment?: { body?: unknown; user?: { login?: unknown; type?: unknown } };
  sender?: { login?: unknown; type?: unknown };
}

/**
 * True iff this `issue_comment` delivery plausibly concerns the managed
 * attachments comment and is worth the (DB + GitHub API) cost of reconciling.
 * This event class fires on EVERY comment in every installed repo, so the
 * check here must stay a pure, allocation-free read of the payload already
 * in hand — no I/O.
 *
 * - `created`: never relevant (a fresh human/bot comment is not the managed
 *   one going stale) — cheap reject on `action` alone.
 * - `deleted`: relevant only when the deleted comment was authored by a bot
 *   AND its (still-included, pre-deletion) body carries the marker —
 *   otherwise it's someone's unrelated comment.
 * - `edited`: relevant only when the current body still carries the marker.
 *   Loop guard lives here too: an edit whose `sender` is itself a bot is
 *   assumed to be our own `upsertBotComment` PATCH (GitHub attributes App-
 *   token writes to the App's bot user) and is skipped, so reconcile never
 *   re-triggers off its own write.
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
 * Reconcile for one gated `issue_comment` delivery: when the managed comment
 * was deleted or mangled out from under us, drop the (now stale) cached
 * comment id and re-run gather+upsert so it's recreated/repaired from the
 * bound workspace's own data. No-ops on a missing repo binding; downstream
 * failures THROW (see `autoPromoteAndComment` for the caller contract).
 * Never creates a repo binding (read/delete-only via
 * `findRepoLink`/`deleteRepoLink`).
 */
async function reconcileBotComment(
  env: Env,
  repo: string,
  num: number,
  kind: GhTarget["kind"],
): Promise<void> {
  const link = await findRepoLinkStrict(env.DB, repo);
  if (!link) return;

  const target: GhTarget = { repo, kind, num };
  // Force a fresh marker hunt + write rather than trusting a cached id that
  // may point at the very comment that was just deleted/mangled.
  await env.GITHUB_CACHE.delete(commentCacheKey(link.workspaceName, target));

  await gatherAndUpsert(env, link, target);
}

/**
 * Compact, queue-safe description of the work one webhook delivery implies.
 * Field-extracted at ingestion (never the raw GitHub payload — those can
 * exceed the 128 KB queue message cap) and consumed by
 * `processWebhookEvent` on either side of the queue boundary.
 */
export interface WebhookEvent {
  /** GITHUB_CACHE keys to delete (targeted; possibly empty). */
  keys: string[];
  /** Same-repo PR opened/reopened/synchronize → promote + comment. */
  promote?: { repo: string; num: number; branch: string };
  /** Gated issue_comment edited/deleted → heal the managed comment. */
  reconcile?: { repo: string; num: number; kind: GhTarget["kind"] };
}

/**
 * Pure payload → `WebhookEvent` extraction for one delivery. Returns null
 * when the delivery implies no work (`ping`, unknown events, partial
 * payloads, ungated `issue_comment`s). Never throws on malformed payloads —
 * missing fields mean "nothing to do here".
 */
export function extractWebhookEvent(eventType: string, payload: unknown): WebhookEvent | null {
  const p = (payload ?? {}) as Record<string, unknown>;
  const ev: WebhookEvent = { keys: [] };

  if (eventType === "installation") {
    const id = (p.installation as { id?: unknown } | undefined)?.id;
    if (typeof id === "number") ev.keys.push(`ghtok:${id}`);
    for (const repo of repoFullNames(p.repositories)) ev.keys.push(`ghinst:${repo}`);
  } else if (eventType === "installation_repositories") {
    for (const repo of repoFullNames(p.repositories_added)) ev.keys.push(`ghinst:${repo}`);
    for (const repo of repoFullNames(p.repositories_removed)) ev.keys.push(`ghinst:${repo}`);
  } else if (eventType === "issues" || eventType === "pull_request") {
    const fullName = (p.repository as { full_name?: unknown } | undefined)?.full_name;
    const item = (eventType === "issues" ? p.issue : p.pull_request) as
      | { number?: unknown }
      | undefined;
    if (typeof fullName === "string" && typeof item?.number === "number") {
      ev.keys.push(`ghref:${fullName.toLowerCase()}#${item.number}`);
    }
  }

  if (eventType === "pull_request") {
    const pp = p as PullRequestPayload;
    const action = pp.action;
    const repo = pp.repository?.full_name;
    const pr = pp.pull_request;
    if (
      typeof action === "string" &&
      PROMOTE_ACTIONS.has(action) &&
      typeof repo === "string" &&
      typeof pr?.number === "number" &&
      typeof pr.head?.ref === "string" &&
      typeof pr.head.repo?.full_name === "string" &&
      // Fork PRs stage attachments under the fork's own workspace context (if
      // any) — never promote a base repo's binding against a head branch that
      // lives in a different repo.
      pr.head.repo.full_name.toLowerCase() === repo.toLowerCase()
    ) {
      ev.promote = { repo, num: pr.number, branch: pr.head.ref };
    }
  } else if (eventType === "issue_comment") {
    // isReconcilableCommentEvent's cheap payload-only check runs here, before
    // any I/O or enqueue, so the common case (an ordinary human comment on
    // any installed repo — this event fires on every one) costs nothing.
    const ip = p as IssueCommentPayload;
    const repo = ip.repository?.full_name;
    const num = ip.issue?.number;
    if (isReconcilableCommentEvent(ip) && typeof repo === "string" && typeof num === "number") {
      ev.reconcile = { repo, num, kind: ip.issue?.pull_request ? "pull" : "issues" };
    }
  }
  // ping and unknown events fall through with no work.

  return ev.keys.length || ev.promote || ev.reconcile ? ev : null;
}

/**
 * Run the work one `WebhookEvent` implies. KV deletes are allSettled — a
 * failed delete is harmless (the entry self-heals on its phase-1 TTL) and
 * must never fail the event. Promote/reconcile failures DO throw: in the
 * queue consumer that drives `msg.retry()` toward the DLQ; inline callers
 * (`handleWebhook`'s no-queue fallback) catch and log instead.
 */
export async function processWebhookEvent(env: Env, ev: WebhookEvent): Promise<void> {
  await Promise.allSettled(ev.keys.map((key) => env.GITHUB_CACHE.delete(key)));

  if (ev.promote) {
    await autoPromoteAndComment(env, ev.promote.repo, ev.promote.num, ev.promote.branch);
  }
  if (ev.reconcile) {
    await reconcileBotComment(env, ev.reconcile.repo, ev.reconcile.num, ev.reconcile.kind);
  }
}

/** `processWebhookEvent` with every failure caught and logged — the inline
 * (queueless) path's degrade-safe doctrine: a webhook must never 5xx. */
async function processInline(env: Env, ev: WebhookEvent): Promise<void> {
  try {
    await processWebhookEvent(env, ev);
  } catch (err) {
    console.error(
      JSON.stringify({
        message: "webhook inline processing failed",
        promote: ev.promote ?? null,
        reconcile: ev.reconcile ?? null,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/**
 * Ingest one verified webhook delivery: extract the compact event, then
 * either enqueue it (GITHUB_WEBHOOK_QUEUE bound — the durable path, issue
 * #287) or run it inline via `ctx.waitUntil` (tests/local dev without
 * queues, or a failed send). Never throws on partial payloads; the inline
 * fallback swallows processing failures so the route still returns 204.
 */
export async function handleWebhook(
  env: Env,
  eventType: string,
  payload: unknown,
  ctx?: Pick<ExecutionContext, "waitUntil">,
): Promise<void> {
  const ev = extractWebhookEvent(eventType, payload);
  if (!ev) return;

  // Local cast rather than an env.d.ts augmentation: the generated
  // worker-configuration.d.ts declares the binding non-optional once it's in
  // wrangler.jsonc, and an optional re-declaration would conflict — while
  // environments regenerating types without the queue (tests, older local
  // checkouts) must still typecheck.
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
