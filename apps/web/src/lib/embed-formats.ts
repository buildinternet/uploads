/**
 * Pure embed-format-string builder shared by the public file page
 * (`pages/f/[workspace]/[...key].astro`) and the public gallery-item page
 * (`pages/g/[id]/[item].astro`) — issue's "Copy as" control (design spec
 * §3.3). Kept dependency-free and framework-free so both `.astro` pages can
 * import it directly and it stays unit-testable without a render harness.
 */

export type EmbedFormatId = "page" | "url" | "markdown-image" | "markdown-link" | "html-img";

/** Escapes `&`, `<`, `>`, and `"` for safe interpolation into an HTML attribute value. */
function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
 * Five candidate formats, gated by `kind`, in the fixed order the design
 * spec's §3.3 table lists them: Page link, Direct file URL, Markdown image
 * (image only), Markdown link, HTML `<img>` (image only). Embed *snippet*
 * formats (Markdown image, HTML img) prefer `embedUrl` and fall back to the
 * stable `url`; "Direct file URL" always uses the stable `url` — mirrors
 * `packages/uploads/src/commands.ts`'s existing "MARKDOWN prefers embedUrl"
 * convention.
 */
export function buildEmbedFormats(input: EmbedFormatInput): EmbedFormatOption[] {
  const embedSrc = input.embedUrl ?? input.url;
  const options: EmbedFormatOption[] = [
    { id: "page", label: "Page link", value: input.canonical },
    { id: "url", label: "Direct file URL", value: input.url },
  ];
  if (input.kind === "image") {
    options.push({ id: "markdown-image", label: "Markdown image", value: `![](${embedSrc})` });
  }
  options.push({
    id: "markdown-link",
    label: "Markdown link",
    value: `[${input.filename}](${input.canonical})`,
  });
  if (input.kind === "image") {
    options.push({
      id: "html-img",
      label: "HTML <img>",
      value: `<img src="${embedSrc}" alt="${escapeHtmlAttr(input.filename)}">`,
    });
  }
  return options;
}
