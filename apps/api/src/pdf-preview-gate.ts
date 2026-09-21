/**
 * Kill switch for PDF first-page previews (issue #1009).
 *
 * Same shape as `posterGenerationAllowed` in poster.ts: Flagship fails
 * closed, a missing rate-limiter binding is off, and a workspace opt-out
 * wins before any token is spent. PDFium runs in-process, so this gate does
 * not require the MEDIA binding video posters use.
 */

import { allowPoster } from "./guards";

/** Flagship flag. Default `false` — a missing flag stays off in production. */
export const PDF_POSTER_FLAG = "pdf-poster-generation";

/**
 * Every kill switch, cheapest first. Ordering matters: local checks run
 * before the limiter so an opted-out workspace never spends a token.
 */
export async function pdfPreviewAllowed(
  env: Env,
  ws: { pdfPosterEnabled?: boolean },
  workspaceName: string,
): Promise<boolean> {
  if (ws.pdfPosterEnabled === false) return false;
  // Typed as always-present, but a self-hoster may have deleted the binding.
  if (!env.FLAGS) return false;
  // Shared with video posters. Absent means off, not the fail-open default
  // `allowPoster` uses for a missing WRITE_LIMITER.
  if (!env.POSTER_LIMITER) return false;
  try {
    if (!(await env.FLAGS.getBooleanValue(PDF_POSTER_FLAG, false))) return false;
  } catch {
    return false;
  }
  return await allowPoster(env, workspaceName);
}
