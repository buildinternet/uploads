/**
 * Shared server helpers for the signed-in shells (/account/*, /admin/*) and
 * auth surfaces (login, device, accept-invitation, invite): origins, CSP, and
 * console-link visibility. The favicon ships via BaseHead.
 *
 * CSP is applied as an HTTP response header (not `<meta http-equiv>`) so
 * `frame-ancestors` is honored — browsers ignore that directive in meta.
 * Same delivery model as `applyPublicFileHeaders` / `applyPublicGalleryHeaders`.
 */
import { resolveConsoleMode } from "./console-mode";
import { CF_RUM_CONNECT_SRC, CF_RUM_SCRIPT_SRC, STYLE_SRC_SELF_AND_INLINE } from "./csp";

type OriginEnv = {
  UPLOADS_AUTH_ORIGIN?: string;
  UPLOADS_API_ORIGIN?: string;
};

export function resolveSignedInOrigins(env: OriginEnv): {
  authOrigin: string;
  apiOrigin: string;
} {
  // In dev, the stack supervisor (scripts/dev-stack.mjs) injects the live
  // portless origins as PUBLIC_* process env — but the Cloudflare adapter's
  // runtime env lets a stale apps/web/.dev.vars shadow them. Prefer the
  // supervisor's values in dev so the CSP and clients point at the workers
  // that are actually running; production is untouched (PUBLIC_* is unset
  // there, so the runtime-env chain below still decides).
  const devAuth = import.meta.env.DEV ? import.meta.env.PUBLIC_UPLOADS_AUTH_ORIGIN : undefined;
  const devApi = import.meta.env.DEV ? import.meta.env.PUBLIC_UPLOADS_API_ORIGIN : undefined;
  return {
    authOrigin:
      devAuth ??
      env.UPLOADS_AUTH_ORIGIN ??
      import.meta.env.PUBLIC_UPLOADS_AUTH_ORIGIN ??
      "https://auth.uploads.sh",
    apiOrigin:
      devApi ??
      env.UPLOADS_API_ORIGIN ??
      import.meta.env.PUBLIC_UPLOADS_API_ORIGIN ??
      "https://api.uploads.sh",
  };
}

/** Strict CSP used by /account/* and /admin/* (session + API fetches only). */
export function signedInCsp(authOrigin: string, apiOrigin: string): string {
  return [
    "default-src 'none'",
    `connect-src ${authOrigin} ${apiOrigin} ${CF_RUM_CONNECT_SRC}`,
    `script-src 'self' 'unsafe-inline' ${CF_RUM_SCRIPT_SRC}`,
    `style-src ${STYLE_SRC_SELF_AND_INLINE}`,
    "font-src 'self'",
    "img-src data: https:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * CSP for auth pages that only talk to the auth origin (login, device,
 * accept-invitation). Slightly tighter than the signed-in shells: no API
 * origin and no https: images.
 */
export function authPageCsp(authOrigin: string): string {
  return [
    "default-src 'none'",
    `connect-src ${authOrigin} ${CF_RUM_CONNECT_SRC}`,
    // 'self' covers Astro-bundled /_astro/*.js; CF RUM is edge-injected.
    `script-src 'self' 'unsafe-inline' ${CF_RUM_SCRIPT_SRC}`,
    `style-src ${STYLE_SRC_SELF_AND_INLINE}`,
    "font-src 'self'",
    "img-src data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * CSP for the CLI enroll invite page (`/invite`). Prod API origin is fixed
 * (page hard-codes api.uploads.sh). Delivered via `public/_headers` for the
 * static asset path — keep that file's Content-Security-Policy value identical
 * to this constant (see tests).
 */
export const INVITE_CSP = [
  "default-src 'none'",
  `connect-src https://api.uploads.sh ${CF_RUM_CONNECT_SRC}`,
  // 'self' future-proofs if Astro extracts the page script to /_astro/*.js.
  `script-src 'self' 'unsafe-inline' ${CF_RUM_SCRIPT_SRC}`,
  `style-src ${STYLE_SRC_SELF_AND_INLINE}`,
  "font-src 'self'",
  "img-src data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * Security headers for signed-in shells and auth pages.
 * Same baseline as public file/gallery pages (`applyPublicFileHeaders`), with a
 * page-specific CSP. CSP must be a response header (not meta) so
 * `frame-ancestors` is enforced.
 */
export function applyAuthSecurityHeaders(headers: Headers, csp: string): void {
  headers.set("Content-Security-Policy", csp);
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set("Cache-Control", "no-store");
}

/**
 * Visibility knob for /console links — not a security boundary (console auth
 * is bearer-token based). Only `"public"` surfaces links from account/admin.
 */
export async function resolveShowConsoleLinks(
  env: Parameters<typeof resolveConsoleMode>[0],
): Promise<boolean> {
  return (await resolveConsoleMode(env)) === "public";
}
