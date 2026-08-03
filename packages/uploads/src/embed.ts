/** GitHub-embed helpers (content type + markdown). */

export function inferContentType(filename: string): string {
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

export function buildMarkdown(url: string, opts: { alt: string; width?: number }): string {
  if (opts.width) {
    const alt = opts.alt.replace(/"/g, "&quot;");
    return `<img width="${opts.width}" alt="${alt}" src="${url}">`;
  }
  return `![${opts.alt}](${url})`;
}

/**
 * Null-safe wrapper for upload flows: workspaces with no public base URL
 * (BYO signed-URLs-only) upload fine but have no embeddable URL, and the
 * markdown must degrade to honest plain text instead of `![alt](null)`.
 */
export function buildUploadMarkdown(
  url: string | null | undefined,
  opts: { alt: string; width?: number; key: string },
): string {
  if (!url) {
    return `\`${opts.key}\` uploaded (no public URL — this workspace serves signed URLs only)`;
  }
  return buildMarkdown(url, opts);
}
