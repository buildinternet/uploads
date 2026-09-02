/** GitHub-embed helpers (content type + markdown). */

/**
 * The filename→type map and its two readers live in
 * packages/comment-render/src/index.ts (inlined here as
 * `comment-render.generated.ts`), so the CLI and the managed-comment renderer
 * cannot drift apart. Re-exported from this module because every existing
 * caller imports them from `./embed.js`. That map mirrors the upload table in
 * apps/api/src/guards.ts; keep the two in step. `svg` maps to
 * `image/svg+xml` here same as any other type (issue #929): the server no
 * longer rejects it outright — it accepts SVG only on a storage lane
 * verified to serve it behind a sandboxing CSP (`apps/api/src/active-content.ts`),
 * so whether a given upload actually lands depends on that lane's state,
 * not on anything this map decides.
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
