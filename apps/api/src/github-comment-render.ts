/**
 * Server-side COPY of the CLI's managed-comment renderer + gh-key helpers
 * (packages/uploads/src/github.ts). The published CLI imports no @uploads/*
 * package, so the renderer cannot be shared — it is copied here for the bot
 * path. Kept byte-identical to the CLI copy by test/fixtures/github-comment-
 * golden.json, asserted from both sides. Change both copies together.
 */

export type GhTargetKind = "pull" | "issues";

export interface GhTarget {
  /** "owner/name" */
  repo: string;
  kind: GhTargetKind;
  num: number;
}

function sanitizeKeySegment(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "-");
}

export function ghKeyPrefix(target: GhTarget): string {
  const [owner, name] = target.repo.split("/");
  return `gh/${sanitizeKeySegment(owner)}/${sanitizeKeySegment(name)}/${target.kind}/${target.num}/`;
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

/** Default max width for images in the managed attachments comment (HTML img). */
export const ATTACHMENT_IMAGE_WIDTH_DEFAULT = 400;
/** Portrait / device mockups — keep phones readable, not full-column. */
export const ATTACHMENT_IMAGE_WIDTH_PORTRAIT = 280;
/** Wide UI / browser chrome. */
export const ATTACHMENT_IMAGE_WIDTH_WIDE = 640;

/**
 * Pick a display width for GitHub comment embeds. Filenames are a weak but
 * practical signal (we don't re-fetch dimensions when rebuilding the comment).
 */
export function attachmentImageWidth(filename: string): number {
  const n = filename.toLowerCase();
  if (/(?:^|[-_.])(browser|desktop|dashboard|wide)(?:[-_.]|$)/.test(n)) {
    return ATTACHMENT_IMAGE_WIDTH_WIDE;
  }
  if (
    /(?:^|[-_.])(phone|iphone|ipad|pixel|android|mobile|device)(?:[-_.]|$)/.test(n) ||
    /iphone|pixel-?\d/.test(n)
  ) {
    return ATTACHMENT_IMAGE_WIDTH_PORTRAIT;
  }
  return ATTACHMENT_IMAGE_WIDTH_DEFAULT;
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
 * width constants — a raw 1920 would blow out the comment column — and the
 * result is capped at the real width so a small clip is never upscaled.
 */
function posterImageWidth(videoMeta: AttachmentItem["videoMeta"], filename: string): number {
  const w = videoMeta?.width ?? 0;
  const h = videoMeta?.height ?? 0;
  if (w <= 0 || h <= 0) return attachmentImageWidth(filename);
  const chosen =
    h > w
      ? ATTACHMENT_IMAGE_WIDTH_PORTRAIT
      : w / h >= 16 / 9
        ? ATTACHMENT_IMAGE_WIDTH_WIDE
        : ATTACHMENT_IMAGE_WIDTH_DEFAULT;
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
 * An attachment's caption parts — `path`, then `state` (issue #365). Empty
 * when neither is usable, so callers emit nothing at all and a body with no
 * metadata stays byte-identical to the pre-#365 render.
 *
 * Neither value is pre-sanitized: metadata values are printable ASCII up to
 * 512 chars, and while the CLI validates `--state` against a closed enum,
 * `PATCH /v1/:workspace/files/:key` can set any valid metadata value. A
 * whitespace-only value passes that validation (length-1 printable ASCII), so
 * treat it as absent rather than rendering a dangling separator.
 */
function metaCaptionParts(meta: AttachmentItem["meta"]): string[] {
  const parts: string[] = [];
  for (const value of [meta?.path, meta?.state]) {
    const trimmed = value?.trim();
    if (trimmed) parts.push(trimmed);
  }
  return parts;
}

/** `<sub>` caption body for an inline image, or null when there is nothing to say. */
function metaCaptionHtml(meta: AttachmentItem["meta"]): string | null {
  const parts = metaCaptionParts(meta);
  return parts.length > 0 ? parts.map(escapeHtmlText).join(" · ") : null;
}

/**
 * ` · …` suffix for a markdown list row, or `""` when there is nothing to add.
 * HTML-escapes first, then markdown-escapes: HTML escaping introduces no
 * backslashes or brackets, so the markdown pass cannot corrupt its entities.
 */
function metaCaptionMarkdown(meta: AttachmentItem["meta"]): string {
  const parts = metaCaptionParts(meta);
  if (parts.length === 0) return "";
  return ` · ${parts.map((p) => escapeMarkdownText(escapeHtmlText(p))).join(" · ")}`;
}

/**
 * Render the one marker-owned GitHub comment. When there are no galleries this
 * intentionally preserves the legacy attachment-only body byte-for-byte.
 */
export function attachmentsCommentBody(
  items: AttachmentItem[],
  galleries: GalleryCommentItem[] = [],
  marker: string = ATTACHMENTS_MARKER,
): string {
  // Non-mutating sort (equivalent to Array#toSorted) — the api worker's
  // tsconfig targets lib ES2022, which predates Array#toSorted (ES2023);
  // packages/uploads/src/github.ts uses toSorted directly.
  const sorted = [...items].sort((a, b) => a.key.localeCompare(b.key));
  const sortedGalleries = [...galleries].sort(
    (a, b) => a.title.localeCompare(b.title) || a.url.localeCompare(b.url),
  );
  const lines: string[] = [marker];
  if (sortedGalleries.length > 0) {
    lines.push("### 🖼️ Galleries", "");
    for (const gallery of sortedGalleries) {
      const href = escapeHtmlAttr(gallery.url);
      lines.push(`#### <a href="${href}">${escapeHtmlText(gallery.title)}</a>`);
      for (const preview of gallery.previews ?? []) {
        const previewHref = preview.itemUrl ? escapeHtmlAttr(preview.itemUrl) : href;
        const previewSrc = escapeHtmlAttr(preview.embedUrl ?? preview.url);
        lines.push(
          `<a href="${previewHref}"><img width="320" alt="${escapeHtmlAttr(preview.alt)}" src="${previewSrc}"></a>`,
        );
      }
      lines.push(`<sub><a href="${href}">Open gallery</a></sub>`, "");
    }
    lines.push("");
  }
  if (sorted.length > 0 || sortedGalleries.length === 0) lines.push("### 📎 Attachments", "");
  let inlinedImages = 0;
  const overflowImages: AttachmentItem[] = [];
  for (const item of sorted) {
    const name = item.key.slice(item.key.lastIndexOf("/") + 1);
    const stable = item.url;
    const src = item.embedUrl ?? item.url;
    const link = item.pageUrl ?? stable; // click-through: file page when known, else raw
    const isImage = Boolean(src) && inferContentType(name).startsWith("image/");
    const isPosterVideo = Boolean(item.posterUrl) && inferContentType(name).startsWith("video/");
    const inlines = isImage || isPosterVideo;
    if (inlines && inlinedImages >= MAX_INLINE_ATTACHMENT_IMAGES) {
      // Cap hit — defer to the collapsed overflow list below rather than
      // embedding every remaining image inline.
      overflowImages.push(item);
      continue;
    }
    if (isPosterVideo) {
      inlinedImages++;
      const w = posterImageWidth(item.videoMeta, name);
      const href = escapeHtmlAttr(link ?? (item.posterUrl as string));
      lines.push(
        `<a href="${href}"><img width="${w}" alt="${escapeHtmlAttr(name)}" src="${escapeHtmlAttr(item.posterUrl as string)}"></a>`,
      );
      // GitHub strips <video>, so a still frame needs an explicit affordance
      // or it reads as a screenshot.
      const parts = ["▶ Play video"];
      if (item.videoMeta?.durationSeconds != null) {
        parts.push(formatDuration(item.videoMeta.durationSeconds));
      }
      parts.push(...metaCaptionParts(item.meta).map(escapeHtmlText));
      lines.push(`<sub>${parts.join(" · ")}</sub>`, "");
    } else if (isImage) {
      inlinedImages++;
      // Markdown ![]() has no width control — phone frames become full-column giants.
      // img src uses embed host when available (Camo revalidates); click-through prefers the file page.
      const w = attachmentImageWidth(name);
      const alt = escapeHtmlAttr(name);
      const href = escapeHtmlAttr(link ?? (src as string));
      const imgSrc = escapeHtmlAttr(src as string);
      lines.push(`<a href="${href}"><img width="${w}" alt="${alt}" src="${imgSrc}"></a>`);
      const caption = metaCaptionHtml(item.meta);
      if (caption) lines.push(`<sub>${caption}</sub>`);
      lines.push("");
    } else if (link) {
      lines.push(`- [${name}](${link})${metaCaptionMarkdown(item.meta)}`);
    } else {
      lines.push(`- ${name}${metaCaptionMarkdown(item.meta)}`);
    }
  }
  if (overflowImages.length > 0) {
    const n = overflowImages.length;
    lines.push(`<details><summary>${n} more attachment${n === 1 ? "" : "s"}</summary>`, "");
    for (const item of overflowImages) {
      const name = item.key.slice(item.key.lastIndexOf("/") + 1);
      const link = item.pageUrl ?? item.url;
      const suffix = metaCaptionMarkdown(item.meta);
      lines.push(link ? `- [${name}](${link})${suffix}` : `- ${name}${suffix}`);
    }
    lines.push("", "</details>", "");
  }
  lines.push(
    '<sub>Maintained by <a href="https://uploads.sh">uploads.sh</a> — re-uploading a file with the same name updates it everywhere it is embedded.</sub>',
  );
  lines.push(
    '<sub>Add media: <code>uploads put &lt;file&gt; --pr &lt;N&gt; --comment</code> (or <code>--issue &lt;N&gt;</code>) · <a href="https://uploads.sh/docs/github-app">docs</a></sub>',
  );
  return lines.join("\n");
}
