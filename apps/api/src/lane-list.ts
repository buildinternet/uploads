/**
 * Pure helpers for the two-lane merged listing (PR C, Task C4): the
 * composite cursor codec and the k-way merge across lane pages. See
 * docs/superpowers/specs/2026-08-22-two-lane-storage-design.md, "Listing:
 * merged fan-out". Single-lane records never touch this module —
 * `listObjects` (files-core.ts) short-circuits straight to today's raw
 * provider-cursor path, so an in-flight single-lane cursor never gets
 * reinterpreted as a composite one.
 */

/** Per-lane pagination state: lane id (`"active"` for the active/null lane) → an opaque per-lane cursor string (format owned by the caller — see `listObjects`'s skip-and-resume packing). */
export interface LaneCursorMap {
  v: 1;
  lanes: Record<string, string>;
}

function toBase64Url(json: string): string {
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(raw: string): string {
  const base64 = raw.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - (base64.length % 4)) % 4;
  const binary = atob(base64 + "=".repeat(padLength));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** base64url(JSON) of a `LaneCursorMap` — the composite cursor a multi-lane listing hands back. */
export function encodeLaneCursor(map: LaneCursorMap): string {
  return toBase64Url(JSON.stringify(map));
}

/**
 * Decodes a composite cursor. Returns `null` on anything that isn't a
 * well-formed `{ v: 1, lanes: {...} }` — garbage, or a plain single-lane
 * provider cursor handed to a record that has since grown a second lane
 * (rare; degrades to "start over" rather than throwing).
 */
export function decodeLaneCursor(raw: string | undefined): LaneCursorMap | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(fromBase64Url(raw));
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      (parsed as { v?: unknown }).v === 1 &&
      typeof (parsed as { lanes?: unknown }).lanes === "object" &&
      (parsed as { lanes?: unknown }).lanes !== null
    ) {
      return parsed as LaneCursorMap;
    }
    return null;
  } catch {
    return null;
  }
}

/** One lane's page of already ascending-key-sorted items, tagged with merge priority (lower `laneOrder` wins ties — the active lane is always 0). */
export interface LanePage<T extends { key: string }> {
  laneOrder: number;
  items: T[];
}

/** Result of a bounded k-way merge: the merged page, plus how many raw entries were scanned (emitted, or discarded as a lower-priority duplicate) from each input page — parallel to the `pages` argument, so a caller can advance each lane's own pagination state by exactly that many items. */
export interface MergeResult<T> {
  items: T[];
  consumed: number[];
}

/**
 * k-way merge by ascending key across `pages`. On a duplicate key, keeps the
 * entry from the lowest `laneOrder` (the active lane wins over fallbacks,
 * matching write-lane reality — spec: "Listing: merged fan-out") and
 * discards the rest. Stable within a lane. Stops once `limit` items have
 * been emitted (or every page is exhausted), which is what lets a caller
 * trim a fan-out page to a fixed size while still knowing exactly how far to
 * advance each lane's cursor for the next page.
 */
export function mergeBounded<T extends { key: string }>(
  pages: Array<LanePage<T>>,
  limit: number,
): MergeResult<T> {
  const byLaneOrder = [...pages].sort((a, b) => a.laneOrder - b.laneOrder);
  const pointers = byLaneOrder.map(() => 0);
  const consumedSorted = byLaneOrder.map(() => 0);
  const items: T[] = [];

  while (items.length < limit) {
    let winner = -1;
    let winnerKey: string | undefined;
    for (let i = 0; i < byLaneOrder.length; i++) {
      const page = byLaneOrder[i];
      if (pointers[i] >= page.items.length) continue;
      const key = page.items[pointers[i]].key;
      if (winnerKey === undefined || key < winnerKey) {
        winnerKey = key;
        winner = i;
      }
    }
    if (winner === -1) break;
    items.push(byLaneOrder[winner].items[pointers[winner]]);
    // Advance every page currently pointing at the winning key — the winner
    // itself, and any lower-priority duplicates, which are discarded here
    // rather than ever being emitted.
    for (let i = 0; i < byLaneOrder.length; i++) {
      const page = byLaneOrder[i];
      if (pointers[i] < page.items.length && page.items[pointers[i]].key === winnerKey) {
        pointers[i]++;
        consumedSorted[i]++;
      }
    }
  }

  const consumed = pages.map(() => 0);
  byLaneOrder.forEach((page, sortedIndex) => {
    const originalIndex = pages.indexOf(page);
    consumed[originalIndex] = consumedSorted[sortedIndex];
  });
  return { items, consumed };
}

/**
 * Merge multiple lane pages into one ascending-key sequence with the same
 * duplicate-resolution rule as `listObjects`'s fan-out (`mergeBounded`), with
 * no trim. The pure, easy-to-unit-test form; `listObjects` itself uses
 * `mergeBounded` directly so it can also track per-lane cursor advancement.
 */
export function mergeLaneListings<T extends { key: string }>(pages: Array<LanePage<T>>): T[] {
  return mergeBounded(pages, Number.POSITIVE_INFINITY).items;
}
