/**
 * Phase 2 of the D1 attachment index (#934): read the index alongside the
 * R2 fan-out in `gatherAttachments`, keep rendering from the fan-out, and
 * log the symmetric difference so the index's coverage can be measured
 * before phase 3 switches the render source to it.
 *
 * Behind the Flagship flag `attachment-index-shadow`. Fails closed and
 * never fails the comment sync: a missing binding, a disabled flag, a thrown
 * flag evaluation, or a thrown D1 read all reduce to "no shadow this sync"
 * (the D1/flag failure is logged; a disabled flag is silent).
 *
 * Log line (Workers Logs, one per sync while the flag is on):
 *   { component: "attachment-index", event: "shadow", workspace, repo, kind,
 *     num, match, fanout, index, missingCount, extraCount, missing, extra }
 * `missing` = rendered by the fan-out but absent from the index; `extra` =
 * in the index but not rendered. Both are capped at `MAX_LOGGED_KEYS` keys;
 * the counts are exact. Private prefix ids are redacted from logged keys
 * (they are capability URLs).
 */

import { dbFor } from "./db-session";
import { listAttachmentsForTarget } from "./github-attachment-index";
import { normalizeRepo } from "./github-private-prefixes";
import type { GhTarget } from "./github-comment-render";

export const ATTACHMENT_INDEX_SHADOW_FLAG = "attachment-index-shadow";

const MAX_LOGGED_KEYS = 5;

/**
 * The shadow's only product is a log line, so it must never hold the sync
 * hostage to a slow D1 (see the D1 stall notes in docs/ops.md). Past this
 * the read is abandoned (it settles in the background, unobserved) and the
 * sync proceeds as if the shadow were off.
 */
export const SHADOW_TIMEOUT_MS = 1000;

const PRIVATE_ID_RE = /^gh\/private\/[0-9a-f]{32}\//;

function redactKey(key: string): string {
  return key.replace(PRIVATE_ID_RE, "gh/private/…/");
}

/**
 * Starts the index read. Returns the active index keys, or `null` when the
 * shadow is off, failed, or timed out. Kick this off BEFORE the R2 fan-out
 * so the two overlap (but after the sync's first real D1 query, so the
 * shadow never becomes the query that anchors the request's D1 session);
 * `await` it once the rendered key list is known.
 */
export async function startAttachmentIndexShadow(
  env: Env,
  workspace: string,
  target: GhTarget,
): Promise<string[] | null> {
  if (!env.FLAGS) return null;
  const context = {
    workspace,
    repo: normalizeRepo(target.repo),
    kind: target.kind,
    num: target.num,
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      console.error(
        JSON.stringify({ message: "attachment index: shadow read timed out", ...context }),
      );
      resolve(null);
    }, SHADOW_TIMEOUT_MS);
  });
  const read = (async () => {
    if (!(await env.FLAGS!.getBooleanValue(ATTACHMENT_INDEX_SHADOW_FLAG, false))) return null;
    const rows = await listAttachmentsForTarget(dbFor(env), workspace, target.repo, target);
    return rows.map((row) => row.objectKey);
  })().catch((err: unknown) => {
    console.error(
      JSON.stringify({
        message: "attachment index: shadow read failed",
        ...context,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return null;
  });
  try {
    return await Promise.race([read, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Logs the diff between what the fan-out rendered and what the index holds. No-op when the shadow was off. */
export function reportAttachmentIndexShadow(
  indexKeys: string[] | null,
  workspace: string,
  target: GhTarget,
  renderedKeys: string[],
): void {
  if (indexKeys === null) return;
  const rendered = new Set(renderedKeys);
  const indexed = new Set(indexKeys);
  const missing = renderedKeys.filter((key) => !indexed.has(key));
  const extra = indexKeys.filter((key) => !rendered.has(key));
  console.log(
    JSON.stringify({
      component: "attachment-index",
      event: "shadow",
      workspace,
      repo: normalizeRepo(target.repo),
      kind: target.kind,
      num: target.num,
      match: missing.length === 0 && extra.length === 0,
      fanout: renderedKeys.length,
      index: indexKeys.length,
      missingCount: missing.length,
      extraCount: extra.length,
      missing: missing.slice(0, MAX_LOGGED_KEYS).map(redactKey),
      extra: extra.slice(0, MAX_LOGGED_KEYS).map(redactKey),
    }),
  );
}
