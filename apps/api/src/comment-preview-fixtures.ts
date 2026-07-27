/**
 * Static fallback items for the comment-settings preview endpoint (issue
 * #307, Task 6) — used whenever a workspace has no recent `gh/`-prefixed
 * attachments to render a realistic preview from. All four point at the
 * same real, always-loadable static asset (`og/home.png`, the site-wide OG
 * fallback served by apps/web) so the preview never depends on a workspace's
 * own storage; only the filenames vary, since the renderer's per-item width
 * heuristic (`attachmentImageWidth`) keys off filename patterns
 * (landscape/portrait) and the before/after pairing keys off `meta.state`.
 * `pageUrl: null` throughout — fixtures never claim a real `/f/` file page.
 */
import type { AttachmentItem } from "./github-comment-render";

const FIXTURE_IMAGE_URL = "https://uploads.sh/og/home.png";

export const PREVIEW_FIXTURE_ITEMS: AttachmentItem[] = [
  {
    key: "gh/preview/pull/0/dashboard-overview.png",
    url: FIXTURE_IMAGE_URL,
    embedUrl: FIXTURE_IMAGE_URL,
    pageUrl: null,
  },
  {
    key: "gh/preview/pull/0/iphone-checkout.png",
    url: FIXTURE_IMAGE_URL,
    embedUrl: FIXTURE_IMAGE_URL,
    pageUrl: null,
  },
  {
    key: "gh/preview/pull/0/hero-before.png",
    url: FIXTURE_IMAGE_URL,
    embedUrl: FIXTURE_IMAGE_URL,
    pageUrl: null,
    meta: { state: "before" },
  },
  {
    key: "gh/preview/pull/0/hero-after.png",
    url: FIXTURE_IMAGE_URL,
    embedUrl: FIXTURE_IMAGE_URL,
    pageUrl: null,
    meta: { state: "after" },
  },
];
