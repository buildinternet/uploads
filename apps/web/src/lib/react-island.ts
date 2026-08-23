/**
 * Manual-island hydration helper (`client:*` is banned repo-wide; see
 * astro.config.mjs, so React components are SSR'd plain and `hydrateRoot`-ed
 * from page/layout scripts).
 *
 * Astro's React renderer gives every server-rendered component on a page an
 * incrementing `identifierPrefix` (`r0`, `r1`, … — @astrojs/react server.js),
 * which React folds into every `useId` value (`_r1R_qq_`). A `client:*`
 * island carries that prefix to the client on its `<astro-island>` wrapper,
 * but a manual mount has no wrapper to read it from — hydrating with the
 * default empty prefix makes every useId-bearing node (base-ui dropdown and
 * tooltip triggers, form field ids) mismatch and log hydration errors, and
 * the ids are regenerated instead of adopted. The prefix is recoverable from
 * the server markup itself: every SSR'd useId embeds it as `_<prefix>R_…_`.
 */

/** Matches the prefix inside a server-generated React useId (`_r1R_qq_` → `r1`). */
const SSR_USE_ID_RE = /_(r\d+)R_[0-9a-v]/;

/**
 * The `identifierPrefix` the server render used inside `html`, or `""` when
 * none is detectable (component renders no useId — empty prefix is then
 * harmless). Pass the mount's `innerHTML` before calling `hydrateRoot`, and
 * hand the result to its `identifierPrefix` option.
 */
export function detectIdentifierPrefix(html: string): string {
  return SSR_USE_ID_RE.exec(html)?.[1] ?? "";
}
