/**
 * Pure derivations for one `WorkspaceFileTable` row (3A files tab, Task 8):
 * thumbnail choice, the metadata-filter chip glyph, a short type label, and
 * folder-prefix bookkeeping (child name / breadcrumb segments). Kept free of
 * React/DOM so they're directly unit-testable — see the co-located
 * `workspace-file-row.test.ts`.
 */
import { fileKind } from "./public-file";

/** Minimal shape a thumbnail decision needs — satisfied by both folder-listing and search rows. */
export interface ThumbnailSource {
  contentType?: string;
  url: string | null;
  embedUrl: string | null;
}

export type ThumbnailDecision =
  | { kind: "image"; src: string }
  | { kind: "video" }
  /** An image the viewer can't inline (private, or the workspace has no public URL for it). */
  | { kind: "lock" }
  | { kind: "none" };

/**
 * Decide how a row's name-cell tile renders:
 *  - video → a play-glyph tile (no fetch needed to know that).
 *  - image with an `embedUrl` → the real thumbnail (`background-image:url(embedUrl)`).
 *    `embedUrl` (not `url`) is what's safe to inline — it's null whenever the
 *    dual-host embed-CDN policy doesn't apply (e.g. a BYO custom domain), even
 *    when `url` itself is set.
 *  - image with no `url` at all → private/unconfigured; a lock fallback.
 *  - image with a `url` but no `embedUrl` (no embeddable twin) → no tile,
 *    same as any other non-thumbnailable file.
 *  - everything else → no tile.
 */
export function pickThumbnail(file: ThumbnailSource): ThumbnailDecision {
  const kind = fileKind(file.contentType ?? "");
  if (kind === "video") return { kind: "video" };
  if (kind === "image") {
    if (file.embedUrl) return { kind: "image", src: file.embedUrl };
    if (file.url === null) return { kind: "lock" };
    return { kind: "none" };
  }
  return { kind: "none" };
}

export type ChipKind = "repo" | "pr" | "plain";

/** Icon a metadata-filter chip gets: `gh.repo` → GitHub mark, `gh.number` → PR glyph, else a plain `key=value` pill. */
export function chipKind(key: string): ChipKind {
  if (key === "gh.repo") return "repo";
  if (key === "gh.number") return "pr";
  return "plain";
}

/** Short lowercase type label for the row's "type" column — prefers the MIME subtype, falls back to the key's extension. */
export function fileTypeLabel(file: { contentType?: string; key: string }): string {
  const contentType = file.contentType?.split(";")[0]?.trim();
  if (contentType) {
    const subtype = contentType.split("/")[1] ?? "";
    const clean = subtype.split("+")[0];
    if (clean) return clean.toLowerCase();
  }
  const match = /\.([a-z0-9]{1,8})$/i.exec(file.key);
  return match ? match[1].toLowerCase() : "file";
}

/** Strip a folder prefix from a key/folder path, dropping any trailing slash (folders). Falls back to the full key when it doesn't start with `prefix`. */
export function childName(key: string, prefix: string): string {
  const relative = key.startsWith(prefix) ? key.slice(prefix.length) : key;
  const trimmed = relative.replace(/\/$/, "");
  return trimmed || key;
}

export interface BreadcrumbSegment {
  label: string;
  /** Cumulative prefix through this segment, trailing `/` included — pass to folder navigation. */
  prefix: string;
}

/** Split a normalized folder prefix ("a/b/c/") into cumulative breadcrumb segments. `""` → `[]` (root only). */
export function breadcrumbSegments(prefix: string): BreadcrumbSegment[] {
  let accumulated = "";
  return prefix
    .split("/")
    .filter(Boolean)
    .map((label) => {
      accumulated += `${label}/`;
      return { label, prefix: accumulated };
    });
}

/** True when a row's known visibility is explicitly "private". Missing/unknown visibility (e.g. search results) defaults to public. */
export function isPrivateFile(file: { visibility?: "public" | "private" }): boolean {
  return file.visibility === "private";
}
