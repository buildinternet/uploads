/**
 * Static fallback items for the comment-settings preview endpoint (issue
 * #307, Task 6) — used whenever a workspace has no recent `gh/`-prefixed
 * attachments to render a realistic preview from. All three point at the
 * same real, always-loadable static asset (`og/home.png`, the site-wide OG
 * fallback served by apps/web) so the preview never depends on a workspace's
 * own storage; only the filenames vary, since the renderer's per-item width
 * heuristic (`attachmentImageWidth`) keys off filename patterns
 * (landscape/portrait) and the before/after pairing keys off `meta.state`.
 *
 * Three items (one wide dashboard + one before/after pair) land in the
 * sparse density tier so the settings preview shows readable image sizes
 * and path/state `<code>` captions — matching what a typical PR looks like.
 * `pageUrl: null` throughout — fixtures never claim a real `/f/` file page.
 */
import type { AttachmentItem } from "./github-comment-render";
import { webOrigin } from "./web-url";

/**
 * Build the fixture items against `env.WEB_ORIGIN` (via `webOrigin`, the
 * same single source of truth `filePageUrl` uses) instead of a hardcoded
 * production origin, so the preview's fixture image resolves correctly in
 * local/staging environments too. `/og/home.png` is the one path — only the
 * origin varies.
 */
export function previewFixtureItems(env: Env): AttachmentItem[] {
  const fixtureImageUrl = `${webOrigin(env)}/og/home.png`;
  return [
    {
      key: "gh/preview/pull/0/dashboard-overview.png",
      url: fixtureImageUrl,
      embedUrl: fixtureImageUrl,
      pageUrl: null,
      meta: { path: "/dashboard", state: "after" },
    },
    {
      key: "gh/preview/pull/0/settings-before.png",
      url: fixtureImageUrl,
      embedUrl: fixtureImageUrl,
      pageUrl: null,
      meta: { path: "/settings", state: "before" },
    },
    {
      key: "gh/preview/pull/0/settings-after.png",
      url: fixtureImageUrl,
      embedUrl: fixtureImageUrl,
      pageUrl: null,
      meta: { path: "/settings", state: "after" },
    },
  ];
}
