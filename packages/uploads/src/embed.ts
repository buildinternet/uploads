/** GitHub-embed helpers (content type + markdown). */

/**
 * The filename→type map and its two readers live in
 * packages/comment-render/src/index.ts (inlined here as
 * `comment-render.generated.ts`), so the CLI and the managed-comment renderer
 * cannot drift apart. Re-exported from this module because every existing
 * caller imports them from `./embed.js`. That map mirrors the upload table in
 * apps/api/src/guards.ts; keep the two in step. `svg` is the one deliberate
 * difference — it stays here only so the optimizer can pass it through, and
 * the server rejects it.
 */
export { fileKindFromName, inferContentType } from "./comment-render.generated.js";

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
