/**
 * Static fallback items for the comment-settings preview endpoint (issue
 * #307, Task 6) — used whenever a workspace has no recent `gh/`-prefixed
 * attachments to render a realistic preview from.
 *
 * The images are purpose-drawn generic wireframes (`/preview/*.svg`, served
 * by apps/web) rather than screenshots of uploads.sh itself: the preview's
 * job is to show how the *comment* lays out, and a picture of our own UI
 * reads as if it were the reader's own attachment. They're always-loadable
 * static assets, so the preview never depends on a workspace's own storage.
 * The before/after pair are two visibly different drawings — reusing one
 * image for both made the pairing look broken.
 *
 * Three items (one wide dashboard + one before/after pair) land in the
 * sparse density tier so the settings preview shows readable image sizes
 * and path/state `<code>` captions — matching what a typical PR looks like.
 * Filenames stay `.png` — they stand in for what a real uploaded screenshot
 * is called, and the renderer's per-item width heuristic
 * (`attachmentImageWidth`) keys off filename patterns while the before/after
 * pairing keys off `meta.state`. `pageUrl: null` throughout — fixtures never
 * claim a real `/f/` file page.
 */
import type { AttachmentItem } from "./github-comment-render";
import { webOrigin } from "./web-url";

/**
 * Build the fixture items against `env.WEB_ORIGIN` (via `webOrigin`, the
 * same single source of truth `filePageUrl` uses) instead of a hardcoded
 * production origin, so the preview's fixture images resolve correctly in
 * local/staging environments too — only the origin varies.
 */
export function previewFixtureItems(env: Env): AttachmentItem[] {
  const asset = (name: string): string => `${webOrigin(env)}/preview/${name}.svg`;
  const item = (
    filename: string,
    assetName: string,
    meta: AttachmentItem["meta"],
  ): AttachmentItem => ({
    key: `gh/preview/pull/0/${filename}`,
    url: asset(assetName),
    embedUrl: asset(assetName),
    pageUrl: null,
    meta,
  });
  return [
    item("dashboard-overview.png", "comment-dashboard", { path: "/dashboard", state: "after" }),
    item("settings-before.png", "comment-settings-before", { path: "/settings", state: "before" }),
    item("settings-after.png", "comment-settings-after", { path: "/settings", state: "after" }),
  ];
}
