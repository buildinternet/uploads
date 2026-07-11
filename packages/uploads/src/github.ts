import { inferContentType } from "./embed.js";
import { sanitizeKeySegment } from "./keys.js";

export type GhTargetKind = "pull" | "issues";

export interface GhTarget {
  /** "owner/name" */
  repo: string;
  kind: GhTargetKind;
  num: number;
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function isValidRepo(repo: string): boolean {
  return REPO_RE.test(repo);
}

/** Parse "owner/name" from a git remote URL (SSH or HTTPS), else undefined. */
export function parseRepoFromRemoteUrl(url: string): string | undefined {
  const match = url.trim().match(/[/:]([^/:\s]+\/[^/:\s]+?)(?:\.git)?\/?$/);
  const repo = match?.[1];
  return repo && isValidRepo(repo) ? repo : undefined;
}

export function ghKeyPrefix(target: GhTarget): string {
  const [owner, name] = target.repo.split("/");
  return `gh/${sanitizeKeySegment(owner)}/${sanitizeKeySegment(name)}/${target.kind}/${target.num}/`;
}

/**
 * Stable attachment key: same filename → same key → same public URL, so
 * re-uploading updates every existing embed. Deliberately NO content hash
 * (unlike buildScreenshotKey).
 */
export function ghAttachmentKey(target: GhTarget, filename: string): string {
  return `${ghKeyPrefix(target)}${sanitizeKeySegment(filename)}`;
}

/** Hidden marker identifying the one comment this CLI manages. Never change it — existing comments are found by exact match. */
export const ATTACHMENTS_MARKER = "<!-- uploads.sh:attachments -->";

export interface AttachmentItem {
  key: string;
  url: string | null;
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

export function attachmentsCommentBody(items: AttachmentItem[]): string {
  const sorted = items.toSorted((a, b) => a.key.localeCompare(b.key));
  const lines: string[] = [ATTACHMENTS_MARKER, "### 📎 Attachments", ""];
  for (const item of sorted) {
    const name = item.key.slice(item.key.lastIndexOf("/") + 1);
    if (item.url && inferContentType(name).startsWith("image/")) {
      // Markdown ![]() has no width control — phone frames become full-column giants.
      const w = attachmentImageWidth(name);
      const alt = escapeHtmlAttr(name);
      lines.push(`<img width="${w}" alt="${alt}" src="${item.url}">`);
      lines.push("");
    } else if (item.url) {
      lines.push(`- [${name}](${item.url})`);
    } else {
      lines.push(`- ${name}`);
    }
  }
  lines.push(
    '<sub>Maintained by <a href="https://uploads.sh">uploads.sh</a> — re-uploading a file with the same name updates it everywhere it is embedded.</sub>',
  );
  return lines.join("\n");
}
