/** GitHub-embed helpers (content type + markdown). */

const CONTENT_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  pdf: "application/pdf",
  zip: "application/zip",
  gz: "application/gzip",
  tgz: "application/gzip",
  txt: "text/plain",
  text: "text/plain",
  log: "text/plain",
  jsonl: "text/plain",
  ndjson: "text/plain",
  yaml: "text/plain",
  yml: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  json: "application/json",
};

/**
 * Content type from a filename's extension. Mirrors `CONTENT_TYPE_BY_EXTENSION`
 * in apps/api/src/guards.ts (the server's key-extension fallback); keep the
 * two in step. `svg` stays here only so the optimizer can pass it through —
 * the server rejects it.
 */
export function inferContentType(filename: string): string {
  const ext = filename.includes(".")
    ? filename.slice(filename.lastIndexOf(".") + 1).toLowerCase()
    : "";
  return CONTENT_TYPE_BY_EXTENSION[ext] ?? "application/octet-stream";
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
