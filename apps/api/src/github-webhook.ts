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
 */

import { githubAppConfig, installationForRepo } from "./github-app";
import { gatherCommentBody, upsertBotComment } from "./github-comment";
import type { GhTarget } from "./github-comment-render";
import { promoteBranchAttachments } from "./github-promote";
import { deleteRepoLink, findRepoLink } from "./github-repo-links";
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
 * Best-effort webhook-driven auto-promotion for one `pull_request` delivery.
 * No-ops (never throws) on: a cross-repo PR (fork head), no repo link, a
 * missing/tombstoned linked workspace (also cleans up the stale link), or
 * any downstream promote/gather/comment failure. Reuses
 * `promoteBranchAttachments` and `gatherCommentBody`/`upsertBotComment`
 * verbatim — no duplicated copy/render/post logic.
 */
async function autoPromoteAndComment(env: Env, p: PullRequestPayload): Promise<void> {
  const repo = p.repository?.full_name;
  const pr = p.pull_request;
  const num = pr?.number;
  const headRef = pr?.head?.ref;
  const headRepo = pr?.head?.repo?.full_name;
  if (
    typeof repo !== "string" ||
    typeof num !== "number" ||
    typeof headRef !== "string" ||
    typeof headRepo !== "string"
  ) {
    return;
  }
  // Fork PRs stage attachments under the fork's own workspace context (if
  // any) — never promote a base repo's binding against a head branch that
  // lives in a different repo.
  if (headRepo.toLowerCase() !== repo.toLowerCase()) return;

  try {
    const link = await findRepoLink(env.DB, repo);
    if (!link) return;

    const ws = await loadWorkspaceRecord(env, link.workspaceName);
    if (!ws) {
      // The bound workspace is gone or tombstoned — the link is stale;
      // clean it up so a future claim (e.g. from another workspace) isn't
      // blocked by first-claim-wins forever.
      await deleteRepoLink(env.DB, repo);
      return;
    }

    await promoteBranchAttachments(env, ws, link.workspaceName, {
      repo,
      num,
      branch: headRef,
    });

    // Gather AFTER promoting: the just-promoted copies are now real objects
    // under the PR's attachment prefix, so this single gather call (reused
    // verbatim from the comment route) already reflects them — no separate
    // "promoted > 0" branch needed.
    const target: GhTarget = { repo, kind: "pull", num };
    const gathered = await gatherCommentBody(env, ws, link.workspaceName, target);
    if (gathered.skip) return; // nothing staged and nothing pre-existing — no empty comment.

    const cfg = githubAppConfig(env);
    if (!cfg) return;
    const installId = link.installationId ?? (await installationForRepo(env, cfg, repo));
    if (installId === null) return;

    const result = await upsertBotComment(env, cfg, installId, target, gathered.body);
    if ("degrade" in result) {
      console.error(
        JSON.stringify({
          message: "webhook auto-comment degraded",
          repo,
          num,
          reason: result.degrade,
        }),
      );
    }
  } catch (err) {
    console.error(
      JSON.stringify({
        message: "webhook auto-promote failed",
        repo,
        num,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/**
 * Invalidate the phase-1 cache entries implied by one webhook delivery, and
 * (for a same-repo `pull_request` opened/reopened/synchronize) kick off
 * best-effort auto-promotion via `ctx.waitUntil` so the response isn't
 * delayed by it. `ping` and unknown events are no-ops. Never throws on
 * partial payloads.
 */
export async function handleWebhook(
  env: Env,
  eventType: string,
  payload: unknown,
  ctx?: Pick<ExecutionContext, "waitUntil">,
): Promise<void> {
  const p = (payload ?? {}) as Record<string, unknown>;
  const keys: string[] = [];

  if (eventType === "installation") {
    const id = (p.installation as { id?: unknown } | undefined)?.id;
    if (typeof id === "number") keys.push(`ghtok:${id}`);
    for (const repo of repoFullNames(p.repositories)) keys.push(`ghinst:${repo}`);
  } else if (eventType === "installation_repositories") {
    for (const repo of repoFullNames(p.repositories_added)) keys.push(`ghinst:${repo}`);
    for (const repo of repoFullNames(p.repositories_removed)) keys.push(`ghinst:${repo}`);
  } else if (eventType === "issues" || eventType === "pull_request") {
    const fullName = (p.repository as { full_name?: unknown } | undefined)?.full_name;
    const item = (eventType === "issues" ? p.issue : p.pull_request) as
      | { number?: unknown }
      | undefined;
    if (typeof fullName === "string" && typeof item?.number === "number") {
      keys.push(`ghref:${fullName.toLowerCase()}#${item.number}`);
    }
  }
  // ping and unknown events fall through with no keys.

  // Use allSettled, not all: a rejecting delete must never propagate out of
  // handleWebhook and become a 500 on the webhook route. A failed delete is
  // harmless — the entry self-heals on its phase-1 TTL — so a webhook outage
  // must never break anything.
  await Promise.allSettled(keys.map((key) => env.GITHUB_CACHE.delete(key)));

  if (eventType === "pull_request") {
    const action = (p as PullRequestPayload).action;
    if (typeof action === "string" && PROMOTE_ACTIONS.has(action)) {
      const work = autoPromoteAndComment(env, p as PullRequestPayload);
      if (ctx) ctx.waitUntil(work);
      else await work; // no executionCtx (e.g. some test/call sites) — run inline.
    }
  }
}
