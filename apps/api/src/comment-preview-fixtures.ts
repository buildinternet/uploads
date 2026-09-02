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
  // Two non-media fixtures (issue #946) so the settings preview also shows
  // the file table, not just the image grid — plausible preview-base paths,
  // never a real `/f/` file page (`pageUrl: null`, matching the images above).
  const file = (filename: string, size: number, contentType: string): AttachmentItem => ({
    key: `gh/preview/pull/0/${filename}`,
    url: `${webOrigin(env)}/preview/${filename}`,
    embedUrl: null,
    pageUrl: null,
    size,
    contentType,
  });
  return [
    item("dashboard-overview.png", "comment-dashboard", { path: "/dashboard", state: "after" }),
    item("settings-before.png", "comment-settings-before", { path: "/settings", state: "before" }),
    item("settings-after.png", "comment-settings-after", { path: "/settings", state: "after" }),
    file("report.pdf", 1_240_000, "application/pdf"),
    file("bundle.zip", 8_400_000, "application/zip"),
  ];
}
