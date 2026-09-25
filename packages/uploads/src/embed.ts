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
export {
  fileKindFromName,
  inferContentType,
  buildAttachmentMarkdown,
} from "./comment-render.generated.js";
import { buildAttachmentMarkdown } from "./comment-render.generated.js";

/**
 * Image-only markdown, kept for callers that already know the file is an
 * image (and for back-compat — this was the CLI's only markdown builder
 * before issue #1030). Non-image files need `buildAttachmentMarkdown`
 * instead, which degrades by type.
 */
export function buildMarkdown(url: string, opts: { alt: string; width?: number }): string {
  if (opts.width) {
    const alt = opts.alt.replace(/"/g, "&quot;");
    return `<img width="${opts.width}" alt="${alt}" src="${url}">`;
  }
  return `![${opts.alt}](${url})`;
}

/**
 * Null-safe, type-aware wrapper for upload flows: workspaces with no public
 * base URL (BYO signed-URLs-only) upload fine but have no embeddable URL,
 * and the markdown must degrade to honest plain text instead of
 * `![alt](null)`. Otherwise defers to `buildAttachmentMarkdown` (issue
 * #1030) so a PDF or log doesn't print broken image syntax.
 */
export function buildUploadMarkdown(
  url: string | null | undefined,
  opts: {
    alt: string;
    width?: number;
    key: string;
    /** Defaults to `key`'s basename when omitted. */
    filename?: string;
    contentType?: string;
    /** A poster frame known at call time — see `AttachmentMarkdownOptions.posterUrl`. */
    posterUrl?: string | null;
  },
): string {
  if (!url) {
    return `\`${opts.key}\` uploaded (no public URL — this workspace serves signed URLs only)`;
  }
  const filename = opts.filename ?? opts.key.slice(opts.key.lastIndexOf("/") + 1);
  return buildAttachmentMarkdown(filename, url, {
    alt: opts.alt,
    width: opts.width,
    contentType: opts.contentType,
    posterUrl: opts.posterUrl,
  });
}
