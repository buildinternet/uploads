/**
 * Pure helpers for the two-lane merged listing (PR C, Task C4): the
 * composite cursor codec, the per-lane resume-state codec, and the k-way
 * merge across lane pages. See
 * docs/superpowers/specs/2026-08-22-two-lane-storage-design.md, "Listing:
 * merged fan-out". Single-lane records never touch this module —
 * `listObjects` (files-core.ts) short-circuits straight to today's raw
 * provider-cursor path, so an in-flight single-lane cursor never gets
 * reinterpreted as a composite one.
 */
import { b64urlDecode, b64urlEncode } from "./secrets";

/**
 * Per-lane pagination state, keyed by lane id (`"active"` for the
 * active/null lane): each value is either `LANE_DONE` (this lane will never
 * produce another item) or the per-lane resume state from
 * `encodeLaneResumeState`. `after` is the global high-water key — the
 * largest key emitted across every lane so far. Every fresh fetch drops any
 * item at or before it, so an exhausted lane that (for any reason) resolves
 * back to "start of listing" can never re-emit something already returned;
 * `LANE_DONE` is the primary mechanism, `after` is the defense in depth.
 */
export interface LaneCursorMap {
  v: 1;
  lanes: Record<string, string>;
  after?: string;
}

/** base64url(JSON) of a `LaneCursorMap` — the composite cursor a multi-lane listing hands back. */
export function encodeLaneCursor(map: LaneCursorMap): string {
  return b64urlEncode(new TextEncoder().encode(JSON.stringify(map)));
}

function isLaneCursorMap(value: unknown): value is LaneCursorMap {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if ((value as { v?: unknown }).v !== 1) return false;
  const lanes = (value as { lanes?: unknown }).lanes;
  if (lanes === null || typeof lanes !== "object" || Array.isArray(lanes)) return false;
  if (Object.values(lanes as Record<string, unknown>).some((v) => typeof v !== "string")) {
    return false;
  }
  const after = (value as { after?: unknown }).after;
  return after === undefined || typeof after === "string";
}

/**
 * Decodes a composite cursor. Returns `null` on anything that isn't a
 * well-formed `{ v: 1, lanes: { [id]: string }, after?: string }` — garbage,
 * a plain single-lane provider cursor handed to a record that has since
 * grown a second lane, or a crafted cursor with a non-string `lanes` value
 * (rejected rather than reaching `decodeLaneResumeState` with the wrong
 * type). Degrades to "start over" rather than throwing either way.
 */
export function decodeLaneCursor(raw: string | undefined): LaneCursorMap | null {
  if (!raw) return null;
  try {
    const json = new TextDecoder().decode(b64urlDecode(raw));
    const parsed: unknown = JSON.parse(json);
    return isLaneCursorMap(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Sentinel `LaneCursorMap` lane value: this lane will never produce another item — never re-fetched, and never mistaken for "hasn't started yet" (which is what an *absent* entry meant in an earlier, buggier version of this cursor — see the regression test in list-page-url.test.ts). */
export const LANE_DONE = "done";

/** Packs a lane's next-fetch provider cursor into its `LaneCursorMap` value. `undefined` (start of listing) encodes as `""`. */
export function encodeLaneResumeState(cursor: string | undefined): string {
  return cursor ?? "";
}

/** Unpacks a lane's `LaneCursorMap` value. Anything that isn't `LANE_DONE` is a provider cursor (empty string decodes to `undefined` — start of listing). */
export function decodeLaneResumeState(raw: string | undefined): {
  cursor: string | undefined;
  done: boolean;
} {
  if (raw === LANE_DONE) return { cursor: undefined, done: true };
  return { cursor: raw ? raw : undefined, done: false };
}

/** One lane's page of already ascending-key-sorted items. Pages must be pre-ordered by merge priority — index 0 wins a duplicate key over index 1, etc. (the active lane goes first, matching write-lane reality). */
export interface LanePage<T extends { key: string }> {
  items: T[];
}

/** Result of a bounded k-way merge: the merged page, plus how many raw entries were scanned (emitted, or discarded as a lower-priority duplicate) from each input page — parallel to the `pages` argument, so a caller can advance each lane's own pagination state by exactly that many items. */
export interface MergeResult<T> {
  items: T[];
  consumed: number[];
}

/**
 * k-way merge by ascending key across `pages`, indexed by priority (index 0
 * wins a duplicate key — spec: "Listing: merged fan-out", active lane wins
 * over fallbacks). Stable within a page. Stops once `limit` items have been
 * emitted (or every page is exhausted), which is what lets a caller trim a
 * fan-out page to a fixed size while still knowing exactly how far to
 * advance each lane's cursor for the next page.
 */
export function mergeBounded<T extends { key: string }>(
  pages: Array<LanePage<T>>,
  limit: number,
): MergeResult<T> {
  const pointers = pages.map(() => 0);
  const consumed = pages.map(() => 0);
  const items: T[] = [];

  while (items.length < limit) {
    let winner = -1;
    let winnerKey: string | undefined;
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      if (pointers[i] >= page.items.length) continue;
      const key = page.items[pointers[i]].key;
      if (winnerKey === undefined || key < winnerKey) {
        winnerKey = key;
        winner = i;
      }
    }
    if (winner === -1) break;
    items.push(pages[winner].items[pointers[winner]]);
    // Advance every page currently pointing at the winning key — the winner
    // itself, and any lower-priority duplicates, which are discarded here
    // rather than ever being emitted.
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      if (pointers[i] < page.items.length && page.items[pointers[i]].key === winnerKey) {
        pointers[i]++;
        consumed[i]++;
      }
    }
  }

  return { items, consumed };
}
