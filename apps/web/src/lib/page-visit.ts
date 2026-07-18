/**
 * ClientRouter visit generation for account/admin shells.
 *
 * Module scripts register `astro:page-load` once and keep firing after every
 * body swap. Async fetches started on visit N must not paint into visit N+1
 * (workspace A → profile → workspace B races). Call {@link markPageLoad} once
 * per `astro:page-load` (see `onAstroPageLoad`), then capture the id and check
 * {@link isCurrentPageVisit} before DOM writes.
 */

let pageVisit = 0;

/** Bump the visit id. Returns the new id. */
export function markPageLoad(): number {
  pageVisit += 1;
  return pageVisit;
}

/** Current visit id (0 before the first page-load). */
export function getPageVisit(): number {
  return pageVisit;
}

/** True when `visit` is still the active ClientRouter page. */
export function isCurrentPageVisit(visit: number): boolean {
  return visit === pageVisit && visit > 0;
}

/** Test helper — do not use in app code. */
export function resetPageVisitForTests(): void {
  pageVisit = 0;
}
