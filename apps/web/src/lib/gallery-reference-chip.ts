/**
 * Present gallery external references the same way the public file page
 * presents `file.github` — a chip with a kind icon (PR vs issue), optional
 * title, and `owner/repo#N`.
 *
 * Kind preference: API-provided `kind` (from title resolve) → path on
 * `canonicalUrl` (`/pull/` vs `/issues/`) → null (GitHub mark only).
 */

import type { PublicGalleryReference } from "./public-gallery";

export type GalleryReferenceKind = "pull" | "issue";

/** Which glyph the chip should render in the leading slot. */
export type GalleryReferenceGlyph = "kind" | "github-mark" | "provider";

export interface GalleryReferenceChip {
  provider: string;
  coordinate: string;
  href: string | null;
  title: string | null;
  /** Present for github refs when we can show a kind-aware chip. */
  kind: GalleryReferenceKind | null;
  kindLabel: "pull request" | "issue" | null;
  /** Leading icon choice for the template (avoids nested ternaries in Astro). */
  glyph: GalleryReferenceGlyph;
  ariaLabel: string;
}

function kindLabelFor(kind: GalleryReferenceKind | null): "pull request" | "issue" | null {
  if (kind === "pull") return "pull request";
  if (kind === "issue") return "issue";
  return null;
}

function githubAriaLabel(
  kindLabel: "pull request" | "issue" | null,
  title: string | null,
  coordinate: string,
): string {
  if (kindLabel && title) return `${kindLabel} ${title} (${coordinate}) on GitHub`;
  if (kindLabel) return `${kindLabel} ${coordinate} on GitHub`;
  if (title) return `GitHub ${title} (${coordinate})`;
  return `GitHub ${coordinate}`;
}

/** Map one public gallery reference into chip presentation fields. */
export function galleryReferenceChip(reference: PublicGalleryReference): GalleryReferenceChip {
  const coordinate = reference.coordinate;
  const href = reference.canonicalUrl;
  const provider = reference.provider;
  const title =
    typeof reference.title === "string" && reference.title.trim() ? reference.title.trim() : null;

  if (provider.toLowerCase() !== "github") {
    return {
      provider,
      coordinate,
      href,
      title,
      kind: null,
      kindLabel: null,
      glyph: "provider",
      ariaLabel: href ? `${provider} ${coordinate}` : `${provider} ${coordinate} (no link)`,
    };
  }

  const kind =
    reference.kind === "pull" || reference.kind === "issue"
      ? reference.kind
      : kindFromCanonicalUrl(href);
  const kindLabel = kindLabelFor(kind);

  return {
    provider: "github",
    coordinate,
    href,
    title,
    kind,
    kindLabel,
    glyph: kind ? "kind" : "github-mark",
    ariaLabel: githubAriaLabel(kindLabel, title, coordinate),
  };
}

/** Prefer `/pull/` over `/issues/` path segments; null when the URL is missing or ambiguous. */
export function kindFromCanonicalUrl(url: string | null): GalleryReferenceKind | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.hostname.toLowerCase() !== "github.com") return null;
    // /owner/repo/pull/123 or /owner/repo/issues/123
    if (/\/pull\/[1-9][0-9]*\/?$/.test(parsed.pathname)) return "pull";
    if (/\/issues\/[1-9][0-9]*\/?$/.test(parsed.pathname)) return "issue";
    return null;
  } catch {
    return null;
  }
}
