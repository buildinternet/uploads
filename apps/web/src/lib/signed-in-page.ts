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
import { safeSameOriginPath } from "./workspace-ui";

/**
 * Same-origin sentinel `resolveSignedInOrigins` returns for `apiOrigin`
 * (#731 phase D). Unlike `authOrigin("")` → `""` (auth's own templates
 * already bake in `/api/auth/...`), api-client's templates are bare
 * `${apiOrigin}/v1/...` with no prefix — and a good many browser call sites
 * (admin pages, inline `<script>`s, WorkspaceFileTable, file-opener,
 * workspace-rail, gh-context) build URLs the same bare way directly off
 * `window.__UPLOADS_API_ORIGIN__`, never through a shared "" → "/api"
 * mapping helper. Returning `""` here would silently 404 every one of them
 * against this origin's own routes instead of the api proxy. Returning the
 * concrete `"/api"` prefix instead means every existing `${apiOrigin}${path}`
 * template — inside api-client.ts and outside it — keeps working unmodified.
 */
export const SAME_ORIGIN_API_BASE = "/api";

/**
 * Same-origin path we'll send the user back to after login. Rejects `/login`
 * itself so a bounce can't loop, and anything `safeSameOriginPath` already
 * refuses (absolute URLs, protocol-relative, embedded schemes).
 */
export function loginReturnPath(raw: string | null | undefined): string | null {
  const path = safeSameOriginPath(raw);
  if (!path) return null;
  const bare = path.split(/[?#]/, 1)[0] ?? path;
  if (bare === "/login") return null;
  return path;
}

/** `/login`, or `/login?callbackURL=` when `returnTo` is a safe in-app path. */
export function loginHref(returnTo?: string | null): string {
  const path = loginReturnPath(returnTo);
  if (!path) return "/login";
  return `/login?callbackURL=${encodeURIComponent(path)}`;
}

export function isSignedInShellPath(pathname: string): boolean {
  return pathname.startsWith("/account") || pathname.startsWith("/admin");
}

/**
 * Login path for an unsigned-in visitor to a signed-in shell, or null to
 * render the page (local demo, live session, or auth unavailable).
 */
export function signedInShellLoginRedirect(opts: {
  pathname: string;
  search?: string;
  allowLocalDemo: boolean;
  hasCookie: boolean;
  sessionKind: "signed_in" | "signed_out" | "unavailable" | null;
}): string | null {
  if (!isSignedInShellPath(opts.pathname) || opts.allowLocalDemo) return null;
  if (opts.sessionKind === "signed_in" || opts.sessionKind === "unavailable") return null;
  if (!opts.hasCookie || opts.sessionKind === "signed_out") {
    return loginHref(`${opts.pathname}${opts.search ?? ""}`);
  }
  return null;
}

export function resolveSignedInOrigins(): {
  authOrigin: string;
  apiOrigin: string;
} {
  return {
    // Same-origin (#731 phase B): browser auth traffic goes through this
    // origin's /api/auth proxy, not a configured auth-worker origin. The
    // cookie's Domain scope is unchanged in this phase — only where the
    // browser sends requests.
    authOrigin: "",
    // Same-origin (#731 phase D): browser api traffic goes through this
    // origin's /api proxy — see SAME_ORIGIN_API_BASE for why this is "/api"
    // and not "". env.UPLOADS_API_ORIGIN / PUBLIC_UPLOADS_API_ORIGIN no
    // longer drive the browser-facing value; they still back the api proxy's
    // own astro-dev HTTP fallback (api-proxy.ts) and any SSR call site that
    // still needs a real absolute origin (e.g. public-file.ts's server fetch).
    apiOrigin: SAME_ORIGIN_API_BASE,
  };
}

/**
 * `origin` for a `connect-src` token: `""` (auth) or `"/api"` (api) both mean
 * same-origin (#731 phases B/D), which CSP expresses as `'self'` rather than
 * an origin literal — any other relative (`/`-leading) path is same-origin
 * too, so treat that generally rather than hard-coding just these two.
 * Exported for `public-file.ts`'s `publicFileCsp`, which applies the same
 * rule to its own (single) api origin rather than duplicating it.
 */
export function connectSrcToken(origin: string): string {
  return origin === "" || origin.startsWith("/") ? "'self'" : origin;
}

/**
 * Builds a `connect-src` directive from one or more origins plus the RUM
 * allowance, de-duping tokens — `origin === ""` and `CF_RUM_CONNECT_SRC`'s own
 * `'self'` would otherwise both land in the list. Exported for the same
 * reason as `connectSrcToken`.
 */
export function connectSrc(...origins: string[]): string {
  const tokens = [...origins.map(connectSrcToken), ...CF_RUM_CONNECT_SRC.split(" ")];
  return `connect-src ${[...new Set(tokens)].join(" ")}`;
}

/** Strict CSP used by /account/* and /admin/* (session + API fetches only). */
export function signedInCsp(authOrigin: string, apiOrigin: string): string {
  return [
    "default-src 'none'",
    connectSrc(authOrigin, apiOrigin),
    `script-src 'self' 'unsafe-inline' ${CF_RUM_SCRIPT_SRC}`,
    `style-src ${STYLE_SRC_SELF_AND_INLINE}`,
    "font-src 'self'",
    // Local stack workspaces serve thumbnails from plain-http loopback
    // origins, which `https:` alone rejects — without the DEV allowance
    // every signed-in thumbnail is a broken image in `astro dev`.
    import.meta.env.DEV
      ? "img-src data: https: http://127.0.0.1:* http://localhost:*"
      : "img-src data: https:",
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
    connectSrc(authOrigin),
    // 'self' covers Astro-bundled /_astro/*.js; CF RUM is edge-injected.
    `script-src 'self' 'unsafe-inline' ${CF_RUM_SCRIPT_SRC}`,
    `style-src ${STYLE_SRC_SELF_AND_INLINE}`,
    "font-src 'self'",
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * CSP for `/device`. `authPageCsp` plus the API origin in `connect-src`: since
 * issue #362 the approval page can create a workspace inline (POST
 * /v1/workspaces on the API worker) for an account that has none. Deliberately
 * NOT `signedInCsp` — that one also relaxes `img-src` to `https:`, which this
 * page has no need for.
 */
export function devicePageCsp(authOrigin: string, apiOrigin: string): string {
  return [
    "default-src 'none'",
    connectSrc(authOrigin, apiOrigin),
    `script-src 'self' 'unsafe-inline' ${CF_RUM_SCRIPT_SRC}`,
    `style-src ${STYLE_SRC_SELF_AND_INLINE}`,
    "font-src 'self'",
    "img-src 'self' data:",
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
  "img-src 'self' data:",
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
