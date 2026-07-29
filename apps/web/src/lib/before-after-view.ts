/**
 * Pure derivations for the file page's before/after paired view (issue #420).
 *
 * The API has already done the visibility- and content-type-safe counterpart
 * lookup (apps/api/src/routes/public-files.ts); everything here is layout
 * bookkeeping, kept out of the page's frontmatter so it can be tested.
 */

export type BeforeAfterState = "before" | "after";

/** One row of the rail's Comparison section; `href` is null for this file. */
export interface ComparisonRow {
  state: BeforeAfterState;
  current: boolean;
  href: string | null;
}

/**
 * This file's own role, given the counterpart it was paired with. Uses its own
 * `state` metadata when that is one of the two valid values, else it is simply
 * the counterpart's opposite.
 */
export function ownBeforeAfterState(
  metadataState: string | undefined,
  counterpartState: BeforeAfterState,
): BeforeAfterState {
  if (metadataState === "before" || metadataState === "after") return metadataState;
  return counterpartState === "before" ? "after" : "before";
}

/** Which URL goes on each side of the slider, whichever half this page is. */
export function compareImages(
  ownState: BeforeAfterState,
  ownUrl: string,
  counterpartUrl: string,
): { beforeUrl: string; afterUrl: string } {
  return ownState === "before"
    ? { beforeUrl: ownUrl, afterUrl: counterpartUrl }
    : { beforeUrl: counterpartUrl, afterUrl: ownUrl };
}

/** Both roles, always before-then-after, with only the counterpart linked. */
export function comparisonRows(
  ownState: BeforeAfterState,
  counterpartHref: string,
): ComparisonRow[] {
  return (["before", "after"] as const).map((state) => ({
    state,
    current: state === ownState,
    href: state === ownState ? null : counterpartHref,
  }));
}
