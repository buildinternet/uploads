/**
 * Shared managed-comment renderer and gh-key helpers.
 * API imports @uploads/github-comment; the published CLI inlines this file.
 */

export type GhTargetKind = "pull" | "issues";

export interface GhTarget {
  /** "owner/name" */
  repo: string;
  kind: GhTargetKind;
  num: number;
}

/** Non-safe chars → `-` for a single R2 key segment (owner/name/branch/…).
 * Exported for reuse by other GitHub-key builders (github-ingest.ts) that
 * need the identical sanitization rule — github-promote.ts keeps its own
 * byte-identical private copy rather than importing this one. */
export function sanitizeKeySegment(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "-");
}

export function ghKeyPrefix(target: GhTarget): string {
  const [owner, name] = target.repo.split("/");
  return `gh/${sanitizeKeySegment(owner)}/${sanitizeKeySegment(name)}/${target.kind}/${target.num}/`;
}

/** Literal root under which every private-repo attachment key lives. */
export const GH_PRIVATE_ROOT = "gh/private/";

/** Strict shape for a randomized private-repo prefix id: 32 lowercase hex chars. */
const PRIVATE_PREFIX_ID_RE = /^[0-9a-f]{32}$/;

/**
 * Guard every private-key builder against a malformed `prefixId` — a
 * caller bug here must never silently produce a guessable-ish key.
 */
function assertPrivatePrefixId(prefixId: string): void {
  if (!PRIVATE_PREFIX_ID_RE.test(prefixId)) {
    throw new Error(`invalid private prefix id: "${prefixId}" must be 32 lowercase hex characters`);
  }
}

/**
 * Private-repo key prefix: `gh/private/<32-hex-id>/<kind>/<num>/`.
 * Deliberately omits the repo (unlike `ghKeyPrefix`) — the id is a random,
 * unguessable per-repo prefix rather than an owner/name path, so callers
 * that need the repo back must read `gh.repo` metadata (see
 * `parseGhPrivateKey`, which cannot recover it from the key alone).
 */
export function ghPrivateKeyPrefix(prefixId: string, target: GhTarget): string {
  assertPrivatePrefixId(prefixId);
  return `${GH_PRIVATE_ROOT}${prefixId}/${target.kind}/${target.num}/`;
}

/** Private-repo attachment key: `ghPrivateKeyPrefix` + the sanitized filename. */
export function ghPrivateAttachmentKey(
  prefixId: string,
  target: GhTarget,
  filename: string,
): string {
  return `${ghPrivateKeyPrefix(prefixId, target)}${sanitizeKeySegment(filename)}`;
}

/**
 * Private-repo branch-staged key prefix: `gh/private/<32-hex-id>/branch/`.
 * Unlike `ghBranchKeyPrefix`, there is deliberately NO branch-name segment —
 * the branch name itself is not embedded in a private-repo key.
 */
export function ghPrivateBranchKeyPrefix(prefixId: string): string {
  assertPrivatePrefixId(prefixId);
  return `${GH_PRIVATE_ROOT}${prefixId}/branch/`;
}

/** Private-repo branch-staged attachment key: `ghPrivateBranchKeyPrefix` + the sanitized filename. */
export function ghPrivateBranchAttachmentKey(prefixId: string, filename: string): string {
  return `${ghPrivateBranchKeyPrefix(prefixId)}${sanitizeKeySegment(filename)}`;
}

/**
 * Inverse of `ghPrivateKeyPrefix`: parse the prefix id/kind/number back out
 * of a private-repo attachment key, or undefined for any other key shape.
 * Cannot recover the repo — callers that need it read `gh.repo` metadata.
 */
export function parseGhPrivateKey(
  key: string,
): { prefixId: string; kind: GhTargetKind; num: number } | undefined {
  const match = /^gh\/private\/([0-9a-f]{32})\/(pull|issues)\/([1-9][0-9]*)\/./.exec(key);
  if (!match) return undefined;
  const [, prefixId, kind, num] = match;
  return { prefixId, kind: kind as GhTargetKind, num: Number(num) };
}

/** GitHub-embed helper (content type). Copied from packages/uploads/src/embed.ts. */
function inferContentType(filename: string): string {
  const ext = filename.includes(".")
    ? filename.slice(filename.lastIndexOf(".") + 1).toLowerCase()
    : "";
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "mp4":
      return "video/mp4";
    default:
      return "application/octet-stream";
  }
}

/** Hidden marker identifying the one comment this CLI manages. Never change it — existing comments are found by exact match. */
export const ATTACHMENTS_MARKER = "<!-- uploads.sh:attachments -->";

/** Workspace slugs are `[a-z0-9-]`-ish; only markers built from a slug matching
 * this are trusted as a distinct namespace — anything else (empty, unsafe
 * chars) degrades to the shared legacy marker rather than emitting untrusted
 * text into comment HTML. */
const WORKSPACE_SLUG_RE = /^[a-z0-9-]{1,64}$/;

/**
 * Per-workspace marker (`<!-- uploads.sh:attachments ws=<workspace> -->`) so
 * two workspaces managing the same repo don't clobber each other's comment.
 * Falls back to the shared legacy marker when `workspace` is missing or does
 * not look like a safe slug — degrade, don't guess or risk breaking the
 * comment's HTML.
 */
export function attachmentsMarker(workspace?: string): string {
  if (workspace && WORKSPACE_SLUG_RE.test(workspace)) {
    return `<!-- uploads.sh:attachments ws=${workspace} -->`;
  }
  return ATTACHMENTS_MARKER;
}

/** Max attachments embedded as inline `<img>` tags before the rest collapse
 * into a `<details>` link list. Keeps very large threads from becoming a wall
 * of images. */
export const MAX_INLINE_ATTACHMENT_IMAGES = 16;

/**
 * Per-render knobs for the managed comment (issue #307), sourced from repo
 * comment config. `imageWidth: "auto"` uses per-item filename heuristics plus
 * density-aware sizing (solo/sparse/dense from the inlined count); `"full"`
 * omits the `width` attribute entirely; a number overrides every width site.
 */
export interface CommentRenderOptions {
  imageWidth: "auto" | "full" | number;
  maxInlineImages: number;
  metaPath: boolean;
  metaState: boolean;
  note: string | null;
}

/** Today's behavior, expressed as options — the default for every caller that
 * hasn't opted into repo comment config. */
export const AUTO_RENDER_OPTIONS: CommentRenderOptions = {
  imageWidth: "auto",
  maxInlineImages: MAX_INLINE_ATTACHMENT_IMAGES,
  metaPath: true,
  metaState: true,
  note: null,
};

export interface AttachmentItem {
  key: string;
  url: string | null;
  /** Prefer for `<img src>` on GitHub (Camo-friendly host). Falls back to `url`. */
  embedUrl?: string | null;
  /** Canonical `/f/` file-page URL (server-computed). Preferred click-through target; falls back to `url`. */
  pageUrl?: string | null;
  /**
   * The only canonical metadata the managed comment renders (issue #365).
   * Deliberately two named fields rather than `Record<string, string>`: the
   * comment is posted publicly, and keeping the set narrow at the type level
   * mirrors the server-side query filter that never fetches EXIF-derived
   * keys like `device`/`software` for this path.
   */
  meta?: { path?: string; state?: string };
  /**
   * Poster frame for a video (issue #299), server-computed like `embedUrl` —
   * never taken from client-settable metadata. Absent means "no poster", and
   * the renderer falls back to the bullet link.
   */
  posterUrl?: string | null;
  /** Derived video facts used for the caption and display width. */
  videoMeta?: { durationSeconds?: number; width?: number; height?: number };
}

/** A public gallery linked to the PR or issue whose managed comment is syncing. */
export interface GalleryCommentItem {
  title: string;
  /** Canonical URL returned by the API; callers must not synthesize it. */
  url: string;
  /** A bounded set of available images; each links to its item page when known, else the gallery. */
  previews?: { url: string; alt: string; embedUrl?: string | null; itemUrl?: string }[];
}

/**
 * How crowded the managed comment is. Sparse comments (one shot, a single
 * before/after) get larger embeds; dense comments keep compact historical sizes.
 */
export type AttachmentDensity = "solo" | "sparse" | "dense";

/** Dense (historical) default max width for images in the managed comment. */
export const ATTACHMENT_IMAGE_WIDTH_DEFAULT = 400;
/** Portrait / device mockups — keep phones readable, not full-column. */
export const ATTACHMENT_IMAGE_WIDTH_PORTRAIT = 280;
/** Wide UI / browser chrome. */
export const ATTACHMENT_IMAGE_WIDTH_WIDE = 640;
/** Dense pair-cell cap (side-by-side before/after). */
export const ATTACHMENT_IMAGE_WIDTH_PAIR = 320;

/** Per-density widths for `imageWidth: "auto"`. Dense reuses the exports above. */
const WIDTH_BY_DENSITY = {
  solo: { default: 720, portrait: 360, wide: 800, pair: 400 },
  sparse: { default: 560, portrait: 300, wide: 720, pair: 380 },
  dense: {
    default: ATTACHMENT_IMAGE_WIDTH_DEFAULT,
    portrait: ATTACHMENT_IMAGE_WIDTH_PORTRAIT,
    wide: ATTACHMENT_IMAGE_WIDTH_WIDE,
    pair: ATTACHMENT_IMAGE_WIDTH_PAIR,
  },
} as const satisfies Record<
  AttachmentDensity,
  { default: number; portrait: number; wide: number; pair: number }
>;

/** Map an inlined-media count onto a density tier. */
export function attachmentDensityForCount(inlinedCount: number): AttachmentDensity {
  if (inlinedCount <= 1) return "solo";
  if (inlinedCount <= 3) return "sparse";
  return "dense";
}

/** Pair-cell cap for the given density. */
export function attachmentPairWidth(density: AttachmentDensity = "dense"): number {
  return WIDTH_BY_DENSITY[density].pair;
}

/**
 * Display width for a GitHub comment embed. Filenames are a weak but practical
 * signal (we don't re-fetch dimensions when rebuilding the comment). `density`
 * only affects managed-comment auto layout; other callers leave it `"dense"`.
 */
export function attachmentImageWidth(
  filename: string,
  density: AttachmentDensity = "dense",
): number {
  const table = WIDTH_BY_DENSITY[density];
  const n = filename.toLowerCase();
  if (/(?:^|[-_.])(browser|desktop|dashboard|wide)(?:[-_.]|$)/.test(n)) return table.wide;
  if (
    /(?:^|[-_.])(phone|iphone|ipad|pixel|android|mobile|device)(?:[-_.]|$)/.test(n) ||
    /iphone|pixel-?\d/.test(n)
  ) {
    return table.portrait;
  }
  return table.default;
}

/** `m:ss` under an hour, `h:mm:ss` at or above one. */
function formatDuration(seconds: number): string {
  const total = Math.floor(seconds);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const ss = String(s).padStart(2, "0");
  if (h === 0) return `${m}:${ss}`;
  return `${h}:${String(m).padStart(2, "0")}:${ss}`;
}

/**
 * Display width for a video poster. Real dimensions only *select* among the
 * density table's tiers — a raw 1920 would blow out the comment column — and
 * the result is capped at the real width so a small clip is never upscaled.
 */
function posterImageWidth(
  videoMeta: AttachmentItem["videoMeta"],
  filename: string,
  density: AttachmentDensity = "dense",
): number {
  const w = videoMeta?.width ?? 0;
  const h = videoMeta?.height ?? 0;
  if (w <= 0 || h <= 0) return attachmentImageWidth(filename, density);
  const table = WIDTH_BY_DENSITY[density];
  const chosen = h > w ? table.portrait : w / h >= 16 / 9 ? table.wide : table.default;
  return Math.min(chosen, w);
}

function escapeHtmlAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escapeHtmlText(s: string): string {
  return escapeHtmlAttr(s).replace(/'/g, "&#39;").replace(/>/g, "&gt;");
}

/**
 * Backslash-escape the markdown metacharacters that can appear in a metadata
 * value. `~` is in the set because GitHub's strikethrough extension treats a
 * matching pair of ONE or two tildes as markup, so an unescaped `/a~b~c` would
 * render with `b` struck through.
 */
function escapeMarkdownText(s: string): string {
  return s.replace(/([\\`*_[\]~])/g, "\\$1");
}

/**
 * Collect path then state for a caption (issue #365). Bare `/` and
 * whitespace-only values are omitted (issue #375). Empty when nothing usable.
 */
function metaCaptionValues(meta: AttachmentItem["meta"], options: CommentRenderOptions): string[] {
  const values: string[] = [];
  const path = meta?.path?.trim();
  if (options.metaPath && path && path !== "/") values.push(path);
  const state = meta?.state?.trim();
  if (options.metaState && state) values.push(state);
  return values;
}

/**
 * Format path/state as code tokens. HTML → `<code>…</code>`; markdown →
 * `` `…` `` (backslash-escape if the value itself contains a backtick).
 * Returns `""` when there is nothing to say.
 */
function formatMetaCaption(
  meta: AttachmentItem["meta"],
  options: CommentRenderOptions,
  mode: "html" | "markdown",
): string {
  const values = metaCaptionValues(meta, options);
  if (values.length === 0) return "";
  if (mode === "html") {
    return values.map((v) => `<code>${escapeHtmlText(v)}</code>`).join(" · ");
  }
  return values
    .map((v) => {
      const esc = escapeHtmlText(v);
      return esc.includes("`") ? escapeMarkdownText(esc) : `\`${esc}\``;
    })
    .join(" · ");
}

/** Resolved pixel width for an image site, or `null` meaning "omit the width
 * attribute". `"auto"` defers to the caller's per-item heuristic (`autoPx`);
 * `"full"` always omits; a number always wins. */
function resolvedWidth(autoPx: number, options: CommentRenderOptions): number | null {
  if (options.imageWidth === "auto") return autoPx;
  if (options.imageWidth === "full") return null;
  return options.imageWidth;
}

/** Every `<img>` tag in the managed comment goes through here so the
 * omit-width-attribute case ("full") can't drift between call sites.
 *
 * `escapedAlt`/`escapedSrc` must already be attribute-escaped (via
 * `escapeHtmlAttr`) by the caller — this function interpolates them as-is
 * and does not escape them itself. */
function imgTag(w: number | null, escapedAlt: string, escapedSrc: string): string {
  const widthAttr = w === null ? "" : ` width="${w}"`;
  return `<img${widthAttr} alt="${escapedAlt}" src="${escapedSrc}">`;
}

/** Extract the filename stem's before/after token (issue #419 fallback pairing).
 * `base` is the stem lowercased with the token removed; `null` when the stem
 * carries no recognizable before/after token. Requires a separator (`-`, `_`,
 * or `.`) between the token and the rest of the name — except when the token
 * IS the whole stem (`before.png`) — so `beforehand.png` doesn't false-match. */
// Token bounded by `-`, `_`, `.`, or stem start/end, so `hero-before.webp`
// and `paired-view-before-desktop.webp` match but `beforehand.webp` does
// not. Mirrors before-after.ts's TOKEN_RE (file page), applied to the stem.
const STEM_TOKEN_RE = /(^|[-_.])(before|after)($|[-_.])/i;

function filenameStemToken(name: string): { base: string; state: "before" | "after" } | null {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const m = STEM_TOKEN_RE.exec(stem);
  if (!m) return null;
  const state = m[2]!.toLowerCase() as "before" | "after";
  const tokenStart = m.index + m[1]!.length;
  const tokenEnd = tokenStart + m[2]!.length;
  // Base = stem with the token and one adjoining delimiter removed, so
  // `paired-view-before-desktop` and `paired-view-after-desktop` both
  // collapse to `paired-view-desktop` and group together.
  const base =
    m[1]!.length > 0
      ? stem.slice(0, m.index) + stem.slice(tokenEnd)
      : stem.slice(tokenEnd + m[3]!.length);
  return { base: base.toLowerCase(), state };
}

/**
 * Pair up attachments for the before/after side-by-side row (issue #419).
 * `isImageAt[i]` mirrors the renderer's own image test — only images pair;
 * videos and non-image links render exactly as before.
 *
 * Priority order, checked independently per candidate item so rule 2 only
 * ever claims items rule 1 left untouched:
 *  1. Same `path` metadata (trimmed, not bare `/`), one item `state=before`
 *     and one `state=after`. Ambiguous groups (more than one of a state)
 *     don't pair — no way to know which side goes with which.
 *  2. No usable `path` metadata: filename stems that differ only by a
 *     before/after token, same extension. Same ambiguity rule.
 */
function pairAttachments(
  items: AttachmentItem[],
  isImageAt: boolean[],
): { partnerOf: Map<number, number>; roleOf: Map<number, "before" | "after"> } {
  const partnerOf = new Map<number, number>();
  const roleOf = new Map<number, "before" | "after">();
  const pair = (beforeIdx: number, afterIdx: number) => {
    partnerOf.set(beforeIdx, afterIdx);
    partnerOf.set(afterIdx, beforeIdx);
    roleOf.set(beforeIdx, "before");
    roleOf.set(afterIdx, "after");
  };

  // Priority 1: same path metadata, exactly one before + one after.
  const pathGroups = new Map<string, { before: number[]; after: number[] }>();
  items.forEach((item, i) => {
    if (!isImageAt[i]) return;
    const path = item.meta?.path?.trim();
    if (!path || path === "/") return;
    const state = item.meta?.state?.trim().toLowerCase();
    if (state !== "before" && state !== "after") return;
    const g = pathGroups.get(path) ?? { before: [], after: [] };
    g[state].push(i);
    pathGroups.set(path, g);
  });
  for (const g of pathGroups.values()) {
    if (g.before.length === 1 && g.after.length === 1) pair(g.before[0], g.after[0]);
  }

  // Priority 2: no usable path metadata — filename stem token, same extension.
  const stemGroups = new Map<string, { before: number[]; after: number[] }>();
  items.forEach((item, i) => {
    if (!isImageAt[i] || partnerOf.has(i)) return;
    const path = item.meta?.path?.trim();
    if (path && path !== "/") return; // usable path metadata — rule 1 owns this item
    const name = item.key.slice(item.key.lastIndexOf("/") + 1);
    const tok = filenameStemToken(name);
    if (!tok) return;
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 ? name.slice(dot).toLowerCase() : "";
    const key = `${tok.base}${ext}`;
    const g = stemGroups.get(key) ?? { before: [], after: [] };
    g[tok.state].push(i);
    stemGroups.set(key, g);
  });
  for (const g of stemGroups.values()) {
    if (g.before.length === 1 && g.after.length === 1) pair(g.before[0], g.after[0]);
  }

  return { partnerOf, roleOf };
}

function renderPairCell(
  item: AttachmentItem,
  label: "Before" | "After",
  options: CommentRenderOptions,
  density: AttachmentDensity,
): string {
  const name = item.key.slice(item.key.lastIndexOf("/") + 1);
  const src = item.embedUrl ?? item.url;
  const link = item.pageUrl ?? item.url;
  const autoPx = Math.min(attachmentImageWidth(name, density), attachmentPairWidth(density));
  const w = resolvedWidth(autoPx, options);
  const alt = escapeHtmlAttr(name);
  const href = escapeHtmlAttr((link ?? src) as string);
  const imgSrc = escapeHtmlAttr(src as string);
  const caption = formatMetaCaption(item.meta, options, "html");
  // Caption at body size (issue: <sub> made paths unreadably small); the
  // Before/After label keeps <sub> as a deliberate small header.
  const captionHtml = caption ? `<br>${caption}` : "";
  return `<td align="center"><sub><strong>${label}</strong></sub><br><a href="${href}">${imgTag(w, alt, imgSrc)}</a>${captionHtml}</td>`;
}

/** One side-by-side before/after row (issue #419). */
function renderPairRow(
  beforeItem: AttachmentItem,
  afterItem: AttachmentItem,
  options: CommentRenderOptions,
  density: AttachmentDensity,
): string {
  return `<table><tr>${renderPairCell(beforeItem, "Before", options, density)}${renderPairCell(afterItem, "After", options, density)}</tr></table>`;
}

/** How many image/poster items will fit under `maxInlineImages` (for density). */
function countInlinableMedia(sorted: AttachmentItem[], maxInlineImages: number): number {
  let count = 0;
  for (const item of sorted) {
    if (count >= maxInlineImages) break;
    const name = item.key.slice(item.key.lastIndexOf("/") + 1);
    const src = item.embedUrl ?? item.url;
    const isImage = Boolean(src) && inferContentType(name).startsWith("image/");
    const isPoster = Boolean(item.posterUrl) && inferContentType(name).startsWith("video/");
    if (isImage || isPoster) count++;
  }
  return count;
}

/**
 * Render the one marker-owned GitHub comment. When there are no galleries this
 * intentionally preserves the legacy attachment-only body byte-for-byte.
 */
export function attachmentsCommentBody(
  items: AttachmentItem[],
  galleries: GalleryCommentItem[] = [],
  marker: string = ATTACHMENTS_MARKER,
  options: CommentRenderOptions = AUTO_RENDER_OPTIONS,
): string {
  // Non-mutating sort (equivalent to Array#toSorted) — the api worker's
  // tsconfig targets lib ES2022, which predates Array#toSorted (ES2023);
  // packages/uploads/src/github.ts uses toSorted directly.
  const sorted = [...items].sort((a, b) => a.key.localeCompare(b.key));
  const sortedGalleries = [...galleries].sort(
    (a, b) => a.title.localeCompare(b.title) || a.url.localeCompare(b.url),
  );
  const lines: string[] = [marker];
  if (options.note) lines.push(options.note, "");
  if (sortedGalleries.length > 0) {
    lines.push("### 🖼️ Galleries", "");
    for (const gallery of sortedGalleries) {
      const href = escapeHtmlAttr(gallery.url);
      lines.push(`#### <a href="${href}">${escapeHtmlText(gallery.title)}</a>`);
      for (const preview of gallery.previews ?? []) {
        const previewHref = preview.itemUrl ? escapeHtmlAttr(preview.itemUrl) : href;
        const previewSrc = escapeHtmlAttr(preview.embedUrl ?? preview.url);
        const previewW = resolvedWidth(320, options);
        lines.push(
          `<a href="${previewHref}">${imgTag(previewW, escapeHtmlAttr(preview.alt), previewSrc)}</a>`,
        );
      }
      lines.push(`<sub><a href="${href}">Open gallery</a></sub>`, "");
    }
    lines.push("");
  }
  const isImageAt = sorted.map((item) => {
    const name = item.key.slice(item.key.lastIndexOf("/") + 1);
    const src = item.embedUrl ?? item.url;
    return Boolean(src) && inferContentType(name).startsWith("image/");
  });
  const { partnerOf, roleOf } = pairAttachments(sorted, isImageAt);
  // One screenshot → large; a wall of shots → compact historical sizes.
  const density =
    options.imageWidth === "auto"
      ? attachmentDensityForCount(countInlinableMedia(sorted, options.maxInlineImages))
      : "dense";
  const consumedByPair = new Set<number>();

  let inlinedImages = 0;
  const overflowImages: AttachmentItem[] = [];
  for (let idx = 0; idx < sorted.length; idx++) {
    if (consumedByPair.has(idx)) continue;
    const item = sorted[idx];
    const partnerIdx = partnerOf.get(idx);
    if (partnerIdx !== undefined) {
      const partner = sorted[partnerIdx];
      if (inlinedImages + 2 <= options.maxInlineImages) {
        inlinedImages += 2;
        consumedByPair.add(partnerIdx);
        const beforeItem = roleOf.get(idx) === "before" ? item : partner;
        const afterItem = roleOf.get(idx) === "before" ? partner : item;
        lines.push(renderPairRow(beforeItem, afterItem, options, density), "");
        continue;
      }
      // Cap already full for a two-image row — degrade this pair to two
      // ordinary overflow entries rather than only half-rendering the row.
      overflowImages.push(item, partner);
      consumedByPair.add(partnerIdx);
      continue;
    }
    const name = item.key.slice(item.key.lastIndexOf("/") + 1);
    const stable = item.url;
    const src = item.embedUrl ?? item.url;
    const link = item.pageUrl ?? stable; // click-through: file page when known, else raw
    const isImage = Boolean(src) && inferContentType(name).startsWith("image/");
    const isPosterVideo = Boolean(item.posterUrl) && inferContentType(name).startsWith("video/");
    const inlines = isImage || isPosterVideo;
    if (inlines && inlinedImages >= options.maxInlineImages) {
      // Cap hit — defer to the collapsed overflow list below rather than
      // embedding every remaining image inline.
      overflowImages.push(item);
      continue;
    }
    if (isPosterVideo) {
      inlinedImages++;
      const autoPx = posterImageWidth(item.videoMeta, name, density);
      const w = resolvedWidth(autoPx, options);
      const href = escapeHtmlAttr(link ?? (item.posterUrl as string));
      lines.push(
        `<a href="${href}">${imgTag(w, escapeHtmlAttr(name), escapeHtmlAttr(item.posterUrl as string))}</a>`,
      );
      // GitHub strips <video>, so a still frame needs an explicit affordance
      // or it reads as a screenshot.
      const parts = ["▶ Play video"];
      if (item.videoMeta?.durationSeconds != null) {
        parts.push(formatDuration(item.videoMeta.durationSeconds));
      }
      const metaCap = formatMetaCaption(item.meta, options, "html");
      if (metaCap) parts.push(metaCap);
      lines.push(parts.join(" · "), "");
    } else if (isImage) {
      inlinedImages++;
      // Markdown ![]() has no width control — phone frames become full-column giants.
      // img src uses embed host when available (Camo revalidates); click-through prefers the file page.
      const autoPx = attachmentImageWidth(name, density);
      const w = resolvedWidth(autoPx, options);
      const alt = escapeHtmlAttr(name);
      const href = escapeHtmlAttr(link ?? (src as string));
      const imgSrc = escapeHtmlAttr(src as string);
      lines.push(`<a href="${href}">${imgTag(w, alt, imgSrc)}</a>`);
      const caption = formatMetaCaption(item.meta, options, "html");
      // Body-size caption — <sub> rendered path/state metadata too small.
      if (caption) lines.push(caption);
      lines.push("");
    } else if (link) {
      const cap = formatMetaCaption(item.meta, options, "markdown");
      lines.push(`- [${name}](${link})${cap ? ` · ${cap}` : ""}`);
    } else {
      const cap = formatMetaCaption(item.meta, options, "markdown");
      lines.push(`- ${name}${cap ? ` · ${cap}` : ""}`);
    }
  }
  if (overflowImages.length > 0) {
    const n = overflowImages.length;
    lines.push(`<details><summary>${n} more attachment${n === 1 ? "" : "s"}</summary>`, "");
    for (const item of overflowImages) {
      const name = item.key.slice(item.key.lastIndexOf("/") + 1);
      const link = item.pageUrl ?? item.url;
      const cap = formatMetaCaption(item.meta, options, "markdown");
      const suffix = cap ? ` · ${cap}` : "";
      lines.push(link ? `- [${name}](${link})${suffix}` : `- ${name}${suffix}`);
    }
    lines.push("", "</details>", "");
  }
  // Emptied state: a PR/issue whose attachments and galleries were all removed
  // still keeps its managed comment (a later push can repopulate it) — show a
  // neutral resting state rather than a bare footer. Only the truly-empty case
  // (no attachments, no galleries); a galleries-only comment must not get this.
  if (sorted.length === 0 && sortedGalleries.length === 0) {
    lines.push("_No attachments are currently associated with this pull request._", "");
  }
  // Footer condensed to a single quiet line — the old two-line explainer
  // ("re-uploading updates everywhere", full add-media flags) repeats on
  // every PR and lost value with each appearance; details live in the docs.
  lines.push(
    '<sub>Maintained by <a href="https://uploads.sh">uploads.sh</a> · add media: <code>uploads put &lt;file&gt; --pr &lt;N&gt;</code> · <a href="https://uploads.sh/docs/github-app">docs</a></sub>',
  );
  return lines.join("\n");
}
