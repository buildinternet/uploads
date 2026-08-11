/**
 * Server-side promotion (phase 2a): copy a workspace's own branch-staged
 * attachments (`gh/<owner>/<name>/branch/<branch>/<filename>`) into a PR's
 * stable attachment prefix (`gh/<owner>/<name>/pull/<num>/<filename>`) so the
 * managed-comment gatherer (`github-comment.ts`, which lists that prefix)
 * picks them up unchanged. Pure workspace-data operation: no GitHub API call,
 * no installation lookup — just reading and writing the calling workspace's
 * own bucket/prefix and D1 rows.
 *
 * Originals are never deleted here, and no reaper exists to delete them
 * later — this is deliberate, not a gap to be filled. Staged originals are
 * removed only by per-workspace retention or explicit `files:delete`, same
 * as any other object; see docs/deletion.md ("Branch-staged attachments
 * after promotion") for the contract and why a promoted-at-based reaper was
 * tried and retired. A second PR promoting the same branch is expected to
 * re-promote and just overwrites the destination copies (last-write-wins,
 * same contract as any other overwrite in this API).
 */

import { getMetadataForKeys, setFileMetadata } from "./file-metadata";
import { putObject } from "./files-core";
import { ghPrivateAttachmentKey, ghPrivateBranchKeyPrefix } from "./github-comment-render";
import { resolveGhKeyContext } from "./github-private-prefix-service";
import { storage } from "./storage";
import { objectVisibility } from "./visibility";
import type { WorkspaceRecord } from "./workspace";

/**
 * Max staged files processed per call — bounds the work a pathological branch
 * prefix can trigger, and keeps the request's subrequest count well inside
 * the Workers paid-plan ceiling (1000/request; this worker runs on paid).
 * Each promoted file costs ~9 subrequests: R2 get (download) + R2 head +
 * R2 put, each inside `putObject`, plus that call's D1 usage-read,
 * reservation batch, usage-record batch, and metadata-replace batch, plus
 * this module's own D1 read + write batch to tag the staged original. Fixed
 * per-request overhead (auth's KV + D1 lookups, the rate limiter, the R2
 * list page, the batched D1 metadata read) adds ~5 more. At the old cap of
 * 100 that's ~905 subrequests worst case — over 90% of the ceiling, too
 * little margin against list pagination or a workspace with extra budget
 * checks. At 50 it's ~455 (well under half), so this is set to 50.
 */
export const PROMOTE_STAGED_CAP = 50;

/** Staged files older than this (by their `gh.staged-at` D1 tag) are skipped, not promoted. */
const FRESHNESS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Same segment-sanitization contract as the staged/attachment key layout: non-safe chars → `-`. */
function sanitizeKeySegment(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "-");
}

function stagedPrefix(owner: string, name: string, branch: string): string {
  return `gh/${sanitizeKeySegment(owner)}/${sanitizeKeySegment(name)}/branch/${sanitizeKeySegment(branch)}/`;
}

function destinationKey(owner: string, name: string, num: number, filename: string): string {
  return `gh/${sanitizeKeySegment(owner)}/${sanitizeKeySegment(name)}/pull/${num}/${filename}`;
}

/**
 * Missing or unparsable `staged-at` is treated as fresh — it's the workspace's
 * own data, and a missing tag shouldn't strand a file from ever promoting.
 */
function isFresh(stagedAt: string | undefined, nowMs: number): boolean {
  if (!stagedAt) return true;
  const parsed = Date.parse(stagedAt);
  if (!Number.isFinite(parsed)) return true;
  return nowMs - parsed <= FRESHNESS_WINDOW_MS;
}

export interface PromoteTarget {
  /** "owner/name", already validated by the caller. */
  repo: string;
  num: number;
  branch: string;
}

export interface PromoteSkip {
  key: string;
  reason: string;
}

export interface PromoteResult {
  /** Destination keys written by this call. */
  promoted: string[];
  skipped: PromoteSkip[];
}

/** One staged key found under one of the prefixes swept for this branch. */
interface StagedEntry {
  key: string;
  /** The prefix `key` was listed under — stripped off to recover the filename. */
  prefix: string;
  /** Destination filename (key with `prefix` stripped); "" for a malformed key. */
  filename: string;
  /** True when `key` was listed under the private branch prefix, not the plain one. */
  private: boolean;
}

/** One filename's worth of work: the entry actually copied, plus any other
 * staged entry that resolves to the SAME destination filename (issue #631's
 * dual-sweep can list the same filename under both the plain and private
 * branch prefixes) and is therefore never copied itself. */
interface PromoteUnit {
  primary: StagedEntry;
  /** Losing duplicates for `primary`'s filename — never copied, but their
   * staged originals are still tagged promoted once `primary` succeeds, so
   * they don't linger as orphaned `gh.status=staged` rows. */
  shadows: StagedEntry[];
}

/**
 * Copy the calling workspace's fresh branch-staged attachments into the
 * target PR's attachment prefix. Degrade-safe: a single-file copy failure is
 * collected into `skipped` rather than failing the whole call. Idempotent —
 * re-running overwrites the destination copies.
 *
 * Private-repo prefixes (issue #631): resolves the current key mode for
 * `(target.repo, target.branch)` via `resolveGhKeyContext` (fail-open —
 * `mintingUserId: null` since this runs server-side with no caller identity;
 * `checkRepoAuthorization` still passes because this repo is already linked
 * to `workspaceName` by the time anything calls promote). Private mode also
 * sweeps the plain staged prefix — files staged before this feature shipped,
 * or during a privacy flip, still promote — but every swept file's
 * destination follows the CURRENT mode, not wherever it happened to be
 * staged.
 */
export async function promoteBranchAttachments(
  env: Env,
  ws: WorkspaceRecord,
  workspaceName: string,
  target: PromoteTarget,
): Promise<PromoteResult> {
  const [owner, name] = target.repo.split("/");
  const plainPrefix = stagedPrefix(owner, name, target.branch);
  const store = await storage(env, ws);

  // resolveGhKeyContext's own D1 tail (checkRepoAuthorization →
  // findRepoLinkStrict) deliberately PROPAGATES D1 errors rather than
  // degrading — that's fine for its direct HTTP route caller, but promote
  // must never abort just because the mode couldn't be determined. Guard
  // here, same fail-open idiom as the webhook's privacy-cache write-through.
  let mode: Awaited<ReturnType<typeof resolveGhKeyContext>>;
  try {
    mode = await resolveGhKeyContext(env, workspaceName, null, {
      repo: target.repo,
      branch: target.branch,
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        message: "promote: resolveGhKeyContext failed; degrading to plain",
        repo: target.repo,
        branch: target.branch,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    mode = { mode: "plain" };
  }

  const promoted: string[] = [];
  const skipped: PromoteSkip[] = [];

  // Enumerate every staged key under the swept prefix(es) (bounded
  // pagination — a pathological prefix can't loop forever), then split at
  // the cap: the head gets processed, everything past it is reported as
  // skipped rather than silently dropped.
  const entries: StagedEntry[] = [];
  const MAX_LIST_PAGES = 50; // 50k objects at the 1000-per-page ceiling; far beyond any real staging prefix.
  async function listPrefix(prefix: string, isPrivate: boolean): Promise<void> {
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const result = await store.list({ prefix, limit: 1000, cursor });
      for (const item of result.items) {
        entries.push({
          key: item.key,
          prefix,
          filename: item.key.slice(prefix.length),
          private: isPrivate,
        });
      }
      cursor = result.cursor ?? undefined;
      if (!cursor) break;
    }
  }
  await listPrefix(plainPrefix, false);
  if (mode.mode === "private") {
    await listPrefix(ghPrivateBranchKeyPrefix(mode.prefixId), true);
  }

  if (entries.length === 0) return { promoted, skipped };

  // Dedupe by destination filename: the dual sweep above can list the SAME
  // filename under both the plain and private branch prefixes (a file
  // staged before this feature shipped, or during a privacy flip, plus a
  // freshly-staged private copy of the same name). Only one copy is ever
  // written — the private-staged entry wins when both exist, since it's the
  // newer-mode staging — and the loser becomes a "shadow" of the winning
  // unit: never copied itself, but its staged original still gets the same
  // promoted-tag treatment once the winner succeeds (mirrors the loop below)
  // so it doesn't linger as an orphaned `gh.status=staged` row.
  const invalidEntries: StagedEntry[] = [];
  const unitByFilename = new Map<string, PromoteUnit>();
  const units: PromoteUnit[] = [];
  for (const entry of entries) {
    if (!entry.filename) {
      invalidEntries.push(entry);
      continue;
    }
    const existing = unitByFilename.get(entry.filename);
    if (!existing) {
      const unit: PromoteUnit = { primary: entry, shadows: [] };
      unitByFilename.set(entry.filename, unit);
      units.push(unit);
    } else if (entry.private && !existing.primary.private) {
      // A private entry outranks an already-seen plain primary for the same
      // filename — promote it to primary, demote the old primary to a shadow.
      existing.shadows.push(existing.primary);
      existing.primary = entry;
    } else {
      existing.shadows.push(entry);
    }
  }

  // Cap applies to distinct processing items (deduped units + invalid-key
  // entries), matching PROMOTE_STAGED_CAP's per-request subrequest budget —
  // a shadow duplicate costs one extra best-effort D1 write, not a full copy.
  type ProcessItem = { kind: "unit"; unit: PromoteUnit } | { kind: "invalid"; entry: StagedEntry };
  const combined: ProcessItem[] = [
    ...units.map((unit): ProcessItem => ({ kind: "unit", unit })),
    ...invalidEntries.map((entry): ProcessItem => ({ kind: "invalid", entry })),
  ];
  const toProcess = combined.slice(0, PROMOTE_STAGED_CAP);
  for (const item of combined.slice(PROMOTE_STAGED_CAP)) {
    const key = item.kind === "unit" ? item.unit.primary.key : item.entry.key;
    skipped.push({ key, reason: "cap_exceeded" });
  }

  const metaByKey = await getMetadataForKeys(
    env.DB,
    workspaceName,
    toProcess
      .filter((i) => i.kind === "unit")
      .map((i) => (i as { unit: PromoteUnit }).unit.primary.key),
  );
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const ref = `${owner}/${name}#${target.num}`.toLowerCase();

  /** Best-effort mirror of the staged-original tag applied to `primary` onto
   * one shadow duplicate — same merge, same failure doctrine (log, never
   * throw, never affect promoted/skipped). */
  async function tagShadowOriginal(shadow: StagedEntry, destKey: string): Promise<void> {
    try {
      await setFileMetadata(env.DB, workspaceName, shadow.key, {
        "gh.promoted-to": ref,
        "gh.promoted-at": nowIso,
        "gh.status": "promoted",
      });
    } catch (err) {
      console.error(
        JSON.stringify({
          message: "promote: failed to tag shadow-duplicate staged original",
          key: shadow.key,
          destKey,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  for (const item of toProcess) {
    if (item.kind === "invalid") {
      skipped.push({ key: item.entry.key, reason: "invalid_key" });
      continue;
    }
    const { primary, shadows } = item.unit;
    const key = primary.key;
    const filename = primary.filename;
    const stagedMeta = metaByKey.get(key);
    const stagedAt = stagedMeta?.["gh.staged-at"];
    if (!isFresh(stagedAt, nowMs)) {
      skipped.push({ key, reason: "stale" });
      continue;
    }

    const destKey =
      mode.mode === "private"
        ? ghPrivateAttachmentKey(
            mode.prefixId,
            { repo: target.repo, kind: "pull", num: target.num },
            filename,
          )
        : destinationKey(owner, name, target.num, filename);

    try {
      const source = await store.download(key);
      const bytes = new Uint8Array(await source.arrayBuffer());
      const visibility = objectVisibility(source.metadata);

      // A full replace (opts.metadata): the copy gets a fresh, self-contained
      // gh.* tag set rather than inheriting the staged original's tags.
      await putObject(env, ws, destKey, bytes, workspaceName, {
        provenance: source.metadata,
        visibility,
        metadata: {
          // Uploader attribution (issue #340) survives promotion: the copy is
          // written by the server, so the staged original's tags are the only
          // source of "who staged this".
          ...(stagedMeta?.["gh.uploader"] ? { "gh.uploader": stagedMeta["gh.uploader"] } : {}),
          ...(stagedMeta?.["gh.uploader-id"]
            ? { "gh.uploader-id": stagedMeta["gh.uploader-id"] }
            : {}),
          "gh.repo": `${owner}/${name}`.toLowerCase(),
          "gh.kind": "pull",
          "gh.number": String(target.num),
          "gh.ref": ref,
          "gh.branch": target.branch,
          "gh.promoted-at": nowIso,
        },
        surface: "promote",
      });
    } catch (err) {
      // Never leak internal error detail (D1/R2 messages, key policy
      // internals) to API callers — log the detail server-side and report a
      // generic reason.
      console.error(
        JSON.stringify({
          message: "promote copy failed",
          key,
          destKey,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      skipped.push({ key, reason: "copy_failed" });
      continue;
    }

    // The copy succeeded — destKey is promoted regardless of what happens
    // below. Tagging the staged original is best-effort bookkeeping: a
    // failure here must not un-promote the file or land it in `skipped`.
    promoted.push(destKey);
    try {
      // Merge (not replace) onto the staged original: mark it promoted
      // without disturbing its own gh.repo/gh.kind/gh.branch/gh.staged-at
      // tags. `gh.status` (issue #339) flips so in-flight staged media is a
      // plain equality query (`meta.gh.status=staged`).
      await setFileMetadata(env.DB, workspaceName, key, {
        "gh.promoted-to": ref,
        "gh.promoted-at": nowIso,
        "gh.status": "promoted",
      });
    } catch (err) {
      console.error(
        JSON.stringify({
          message: "promote: failed to tag staged original",
          key,
          destKey,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }

    // Mirror the same tag onto every shadow duplicate's staged original
    // (best-effort, never affects promoted/skipped) — see the module doc
    // above the dedupe pass for why.
    for (const shadow of shadows) {
      await tagShadowOriginal(shadow, destKey);
    }
  }

  return { promoted, skipped };
}
