/** GitHub-embed helpers (content type + markdown). */

export function inferContentType(filename: string): string {
  const ext = filename.includes(".") ? filename.slice(filename.lastIndexOf(".") + 1).toLowerCase() : "";
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