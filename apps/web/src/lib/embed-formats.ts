/**
 * Pure embed-format-string builder for the public file + gallery-item "Copy as"
 * control (design spec §3.3). Consumed by `CopyAsControls.astro` on both pages.
 * Dependency-free so it stays unit-testable without a render harness.
 */

export type EmbedFormatId =
  | "page"
  | "url"
  | "markdown-image"
  | "markdown-image-linked"
  | "markdown-link"
  | "html-img";

/** Escapes `&`, `<`, `>`, and `"` for HTML attribute values. */
function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Escapes `\` then `]` so CommonMark link text (`[text](url)`) stays one link.
 * Cosmetic only — not a security sink (confirmed on #168).
 */
function escapeMarkdownLinkText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/]/g, "\\]");
}

export interface EmbedFormatOption {
  id: EmbedFormatId;
  label: string;
  value: string;
}

export interface EmbedFormatInput {
  /** On-site canonical page URL (`/f/<workspace>/<key>` or `/g/<id>/<item>`). */
  canonical: string;
  /** Stable public URL — `PublicFile.url` / `PublicGalleryItem.url`. */
  url: string;
  /** Embed-host URL when available (dual-host GitHub Camo policy); null otherwise. */
  embedUrl: string | null;
  filename: string;
  /** `"missing"` gallery items never reach this — callers only call it when a URL exists. */
  kind: "image" | "video" | "file" | "unsupported";
}

/**
 * The first element is the pre-selected default. For images that's the linked
 * Markdown image — the agent-PR headline: a screenshot that opens the file page
 * when clicked. Full order for images: Markdown image (linked), Markdown image,
 * Page link, Direct file URL, Markdown link, HTML `<img>`. Non-image kinds get
 * Page link, Direct file URL, Markdown link (Page link is their default). Embed
 * *snippet* formats prefer `embedUrl` and fall back to `url`; "Direct file URL"
 * always uses the stable `url` (same convention as the CLI MARKDOWN path).
 */
export function buildEmbedFormats(input: EmbedFormatInput): EmbedFormatOption[] {
  const embedSrc = input.embedUrl ?? input.url;
  const isImage = input.kind === "image";
  return [
    ...(isImage
      ? [
          {
            id: "markdown-image-linked" as const,
            label: "Markdown image (linked)",
            value: `[![](${embedSrc})](${input.canonical})`,
          },
          { id: "markdown-image" as const, label: "Markdown image", value: `![](${embedSrc})` },
        ]
      : []),
    { id: "page", label: "Page link", value: input.canonical },
    { id: "url", label: "Direct file URL", value: input.url },
    {
      id: "markdown-link",
      label: "Markdown link",
      value: `[${escapeMarkdownLinkText(input.filename)}](${input.canonical})`,
    },
    ...(isImage
      ? [
          {
            id: "html-img" as const,
            label: "HTML <img>",
            value: `<img src="${embedSrc}" alt="${escapeHtmlAttr(input.filename)}">`,
          },
        ]
      : []),
  ];
}
