/**
 * Auth client for apps/web (plan D6, Phase 2).
 *
 * Decision: plain `fetch()` wrappers against the auth worker's REST
 * endpoints, NOT the `better-auth/client` bundle. apps/web ships zero
 * client-side npm dependencies today — `invite.astro` and `console.astro`
 * are plain inline `<script>` tags with no component-island framework (no
 * React in this repo) and a deliberately strict CSP. Pulling in
 * `better-auth/client` would be this app's first client-bundle dependency,
 * for a page surface (`/login`, the console session indicator, `/admin`)
 * that only needs three calls: get-session, magic-link sign-in, sign-out,
 * plus a redirect to the GitHub social sign-in URL. The plan explicitly
 * sanctions this fallback when the client-bundle approach is awkward for the
 * inline-script model (see plan D6) — this is that case.
 *
 * `credentials: "include"` on every call so the cross-subdomain session
 * cookie (`.uploads.sh`, see apps/auth/src/auth.ts's crossSubDomainCookies)
 * rides along.
 */

/** Public origin of the auth worker. Falls back to the documented local dev
 * origin (apps/auth's pinned wrangler dev port — see apps/auth/wrangler.jsonc
 * and .dev.vars.example) when UPLOADS_AUTH_ORIGIN isn't set. */
export function authOrigin(configuredOrigin?: string): string {
  return (configuredOrigin || "https://auth.uploads.sh").replace(/\/$/, "");
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  image?: string | null;
  role?: string | null;
}

export interface SessionResponse {
  user: SessionUser;
  session: unknown;
}

/** GET /api/auth/get-session. Returns null on any non-2xx or malformed body — never throws. */
export async function getSession(origin: string): Promise<SessionResponse | null> {
  try {
    const res = await fetch(`${authOrigin(origin)}/api/auth/get-session`, {
      credentials: "include",
      cache: "no-store",
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as SessionResponse | null;
    if (!body || !body.user) return null;
    return body;
  } catch {
    return null;
  }
}

/**
 * Starts the GitHub social sign-in flow: POSTs sign-in/social (Better Auth's
 * contract — it returns `{ url }` to redirect to rather than 302ing itself),
 * then navigates the browser there. Returns false (without navigating) if
 * the auth worker rejects the request, e.g. GitHub not configured (D3's gate).
 */
export async function signInWithGitHub(origin: string, callbackURL: string): Promise<boolean> {
  const res = await fetch(`${authOrigin(origin)}/api/auth/sign-in/social`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "github", callbackURL }),
  });
  if (!res.ok) return false;
  const body = (await res.json().catch(() => null)) as { url?: string } | null;
  if (!body?.url) return false;
  location.href = body.url;
  return true;
}

/** POST /api/auth/sign-in/magic-link. Returns true when the auth worker accepted the request. */
export async function sendMagicLink(
  origin: string,
  email: string,
  callbackURL: string,
): Promise<boolean> {
  const res = await fetch(`${authOrigin(origin)}/api/auth/sign-in/magic-link`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, callbackURL }),
  });
  return res.ok;
}

/** POST /api/auth/sign-out. */
export async function signOut(origin: string): Promise<void> {
  await fetch(`${authOrigin(origin)}/api/auth/sign-out`, {
    method: "POST",
    credentials: "include",
  }).catch(() => undefined);
}
