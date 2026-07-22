/**
 * Before/after counterpart detection for the public file page (issue #420).
 *
 * Pairing rule, in priority order — mirrors the managed-comment pairing rule
 * from issue #365 / PR #424:
 *   1. Same `path` metadata where one file has `state=before` and the other
 *      `state=after` (queryable-tier D1 metadata, file-metadata.ts).
 *   2. Fallback: filename stems differing only by a before/after token
 *      (`hero-before.webp` / `hero-after.webp`) — but only when the file has
 *      no usable `path`/`state` metadata at all. A file with usable path
 *      metadata is rule-1-only, same as the comment side: a stem-swapped
 *      neighbor that happens to sit alongside it is not treated as a
 *      counterpart, since the file's own metadata already declares which
 *      other object (if any) it pairs with.
 *
 * Both rules are scoped to the same attachment prefix (same PR or same
 * staged branch — everything up to the last `/` in the object key) so
 * unrelated files sharing a `state` value never pair across a workspace.
 *
 * This module only *finds a candidate key* — it has no storage binding, so
 * it cannot check the candidate's own visibility, content type, or whether
 * it actually exists. Callers (routes/public-files.ts) must verify all of
 * that before treating the candidate as a real counterpart, so a public page
 * never reveals a private object's existence and never pairs a non-image.
 */

import { findObjectsByMetadata } from "./file-metadata";

export type BeforeAfterState = "before" | "after";

const STATE_VALUES = new Set<string>(["before", "after"]);

function opposite(state: BeforeAfterState): BeforeAfterState {
  return state === "before" ? "after" : "before";
}

/** Everything up to and including the last `/` — same PR / same staged branch. */
export function attachmentPrefix(key: string): string {
  const idx = key.lastIndexOf("/");
  return idx === -1 ? "" : key.slice(0, idx + 1);
}

// Token bounded by `-`, `_`, `.`, or string start/end, so `hero-before.webp`
// matches but `beforehand.webp` does not.
const TOKEN_RE = /(^|[-_.])(before|after)(?=[-_.]|$)/i;

/**
 * Swaps a filename's before/after token for its opposite, preserving the
 * token's original case style (all-lower, all-upper, or Capitalized).
 * Returns null when the filename has no such token.
 */
export function swapBeforeAfterToken(
  filename: string,
): { filename: string; state: BeforeAfterState } | null {
  const match = TOKEN_RE.exec(filename);
  if (!match) return null;
  const found = match[2]!;
  const state = found.toLowerCase() as BeforeAfterState;
  const replacement = opposite(state);
  let cased: string;
  if (found === found.toUpperCase()) cased = replacement.toUpperCase();
  else if (found[0] === found[0]!.toUpperCase()) {
    cased = replacement[0]!.toUpperCase() + replacement.slice(1);
  } else cased = replacement;
  const start = match.index + match[1]!.length;
  const end = start + found.length;
  return { filename: filename.slice(0, start) + cased + filename.slice(end), state };
}

export interface CounterpartCandidate {
  key: string;
  /** The counterpart's role (opposite of this file's own role). */
  state: BeforeAfterState;
}

// v1 pairing only supports images side by side (issue #420's static layout
// renders both sides as <img>) — same allowlist apps/web's fileKind() treats
// as "image", minus SVG (never previewed inline, see guards.ts).
const IMAGE_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]);

/** True for content types the paired view can render as an `<img>`. */
export function isPairableImageContentType(contentType: string): boolean {
  return IMAGE_CONTENT_TYPES.has(contentType);
}

/**
 * Finds a before/after counterpart candidate for `key`, or null if none
 * applies. Does not check the candidate's existence or visibility — see the
 * module doc.
 */
export async function findCounterpartCandidate(
  db: D1Database,
  workspace: string,
  key: string,
  metadata: Record<string, string>,
): Promise<CounterpartCandidate | null> {
  const prefix = attachmentPrefix(key);
  const path = metadata.path;
  const state = metadata.state;
  const hasUsablePathMetadata = Boolean(path && state && STATE_VALUES.has(state));

  if (hasUsablePathMetadata) {
    const want = opposite(state as BeforeAfterState);
    const matches = await findObjectsByMetadata(
      db,
      workspace,
      { path: path!, state: want },
      { prefix, limit: 5 },
    );
    const match = matches.find((row) => row.key !== key);
    // Rule-1-only once path metadata is usable — mirrors the comment-side
    // rule (#424): don't fall through to a filename-guess for a file that
    // already declares its own pairing via metadata.
    return match ? { key: match.key, state: want } : null;
  }

  const filename = key.slice(prefix.length);
  const swapped = swapBeforeAfterToken(filename);
  if (!swapped) return null;
  return { key: prefix + swapped.filename, state: opposite(swapped.state) };
}
