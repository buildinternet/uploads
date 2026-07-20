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

export interface AttachmentItem {
  key: string;
  url: string | null;
  /** Prefer for `<img src>` on GitHub (Camo-friendly host). Falls back to `url`. */
  embedUrl?: string | null;
  /** Canonical `/f/` file-page URL (server-computed). Preferred click-through target; falls back to `url`. */
  pageUrl?: string | null;
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

function escapeHtmlAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escapeHtmlText(s: string): string {
  return escapeHtmlAttr(s).replace(/'/g, "&#39;").replace(/>/g, "&gt;");
}

/**
 * Render the one marker-owned GitHub comment. When there are no galleries this
 * intentionally preserves the legacy attachment-only body byte-for-byte.
 */
export function attachmentsCommentBody(
  items: AttachmentItem[],
  galleries: GalleryCommentItem[] = [],
): string {
  // Non-mutating sort (equivalent to Array#toSorted) — the api worker's
  // tsconfig targets lib ES2022, which predates Array#toSorted (ES2023);
  // packages/uploads/src/github.ts uses toSorted directly.
  const sorted = [...items].sort((a, b) => a.key.localeCompare(b.key));
  const sortedGalleries = [...galleries].sort(
    (a, b) => a.title.localeCompare(b.title) || a.url.localeCompare(b.url),
  );
  const lines: string[] = [ATTACHMENTS_MARKER];
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
  for (const item of sorted) {
    const name = item.key.slice(item.key.lastIndexOf("/") + 1);
    const stable = item.url;
    const src = item.embedUrl ?? item.url;
    const link = item.pageUrl ?? stable; // click-through: file page when known, else raw
    if (src && inferContentType(name).startsWith("image/")) {
      // Markdown ![]() has no width control — phone frames become full-column giants.
      // img src uses embed host when available (Camo revalidates); click-through prefers the file page.
      const w = attachmentImageWidth(name);
      const alt = escapeHtmlAttr(name);
      const href = escapeHtmlAttr(link ?? src);
      const imgSrc = escapeHtmlAttr(src);
      lines.push(`<a href="${href}"><img width="${w}" alt="${alt}" src="${imgSrc}"></a>`);
      lines.push("");
    } else if (link) {
      lines.push(`- [${name}](${link})`);
    } else {
      lines.push(`- ${name}`);
    }
  }
  lines.push(
    '<sub>Maintained by <a href="https://uploads.sh">uploads.sh</a> — re-uploading a file with the same name updates it everywhere it is embedded.</sub>',
  );
  return lines.join("\n");
}
