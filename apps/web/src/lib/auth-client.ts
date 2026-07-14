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
import { fetchWithTimeout, type RequestFailure } from "./request";

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
  /** First CLI device-flow session (sticky); de-emphasizes account setup. */
  cliOnboardedAt?: string | Date | null;
}

/** Session row from get-session / list-sessions. */
export interface AuthSession {
  id: string;
  token: string;
  createdAt: string | Date;
  updatedAt: string | Date;
  expiresAt: string | Date;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface SessionResponse {
  user: SessionUser;
  /** Better Auth session; `token` is present on a full cookie path response. */
  session: Partial<AuthSession> & Record<string, unknown>;
}

/** Linked identity provider from list-accounts (e.g. providerId: "github"). */
export interface LinkedAccount {
  id: string;
  providerId: string;
  accountId: string;
  /** OAuth scopes granted to this linked account (from list-accounts). */
  scopes?: string[];
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

/**
 * Live provider profile from GET /api/auth/account-info.
 * For GitHub, `data.login` is the username; `user` is the mapped BA profile.
 */
export interface ProviderAccountInfo {
  user: {
    id?: string | number;
    name?: string | null;
    email?: string | null;
    image?: string | null;
    emailVerified?: boolean;
  };
  data?: Record<string, unknown>;
}

export type SessionResult =
  | { kind: "signed_in"; session: SessionResponse }
  | { kind: "signed_out" }
  | { kind: "unavailable"; reason: RequestFailure | "server" | "malformed" };

const LOCAL_STACK_AUTH_ORIGIN = "http://127.0.0.1:8788";
const LOCAL_STACK_WEB_ORIGIN = "http://127.0.0.1:4321";

type LocalDemoSessionStart =
  | { kind: "started" }
  | { kind: "not_enabled" }
  | { kind: "unavailable"; reason: RequestFailure | "server" };

/**
 * GET /api/auth/get-session. A valid no-session response is distinct from an
 * auth timeout, network failure, 503, or malformed response so protected
 * pages never send a user to sign in when the service is merely unavailable.
 */
export async function getSession(origin: string): Promise<SessionResult> {
  const result = await fetchWithTimeout(`${authOrigin(origin)}/api/auth/get-session`, {
    credentials: "include",
    cache: "no-store",
  });
  if (result.kind === "unavailable") return result;
  const { response } = result;
  if (response.status === 401) return { kind: "signed_out" };
  if (!response.ok) return { kind: "unavailable", reason: "server" };
  const body = (await response.json().catch(() => undefined)) as SessionResponse | null | undefined;
  if (body === null) return { kind: "signed_out" };
  if (!body || !body.user) return { kind: "unavailable", reason: "malformed" };
  return { kind: "signed_in", session: body };
}

/**
 * Creates the ordinary local demo session when, and only when, this page and
 * Auth both use the stack's exact loopback origins. The Auth worker applies
 * the authoritative gate again; this browser-side check keeps production and
 * arbitrary development origins from ever probing the endpoint.
 */
export async function startLocalDemoSession(
  origin: string,
  pageOrigin: string,
): Promise<LocalDemoSessionStart> {
  const normalizedOrigin = authOrigin(origin);
  if (normalizedOrigin !== LOCAL_STACK_AUTH_ORIGIN || pageOrigin !== LOCAL_STACK_WEB_ORIGIN) {
    return { kind: "not_enabled" };
  }

  const result = await fetchWithTimeout(`${normalizedOrigin}/api/auth/dev-session`, {
    method: "POST",
    credentials: "include",
    // better-call (better-auth's router) sees a non-null `request.body` for
    // every POST under the Workers runtime, even with no body supplied, so
    // it always runs its Content-Type gate and 415s without this header.
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (result.kind === "unavailable") return result;
  if (result.response.ok) return { kind: "started" };
  return result.response.status >= 500
    ? { kind: "unavailable", reason: "server" }
    : { kind: "not_enabled" };
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

/**
 * Phase 3 (plan D4/D6): organization-plugin wrappers for the
 * `/accept-invitation/[id]` page.
 */
export interface InvitationInfo {
  id: string;
  email: string;
  status: string;
  organizationName?: string;
  organizationId: string;
}

/**
 * GET /api/auth/organization/get-invitation?id=. Better Auth's own endpoint
 * requires an authenticated session whose email matches the invite (it 401s
 * otherwise) — this page calls it after sign-in to show invite context and
 * confirm before accepting; it also tolerates the pre-sign-in case by
 * returning null on any non-2xx rather than throwing.
 */
export async function getInvitation(origin: string, id: string): Promise<InvitationInfo | null> {
  try {
    const res = await fetch(
      `${authOrigin(origin)}/api/auth/organization/get-invitation?id=${encodeURIComponent(id)}`,
      { credentials: "include", cache: "no-store" },
    );
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as InvitationInfo | null;
    return body ?? null;
  } catch {
    return null;
  }
}

/**
 * Phase 4 (plan D5/D6): device-authorization (RFC 8628) wrappers for the
 * `/device` approval page — the browser half of `uploads login`. The CLI
 * speaks the `/device/code` + `/device/token` endpoints directly; this page
 * only needs to look up, approve, or deny a user code.
 */
export type DeviceStatus = "pending" | "approved" | "denied";
export type DeviceLookup = { ok: true; status: DeviceStatus } | { ok: false; code?: string };

/**
 * GET /api/auth/device?user_code=. Verifies the code and — when a session is
 * present and the code is still pending+unclaimed — CLAIMS it (binds it to the
 * signed-in user), which is what makes a subsequent approve succeed. Returns
 * `{ ok: false, code }` for an invalid/expired code, mirroring the other
 * helpers' never-throw contract.
 */
export async function getDeviceStatus(origin: string, userCode: string): Promise<DeviceLookup> {
  try {
    const res = await fetch(
      `${authOrigin(origin)}/api/auth/device?user_code=${encodeURIComponent(userCode)}`,
      { credentials: "include", cache: "no-store" },
    );
    const body = (await res.json().catch(() => null)) as {
      status?: DeviceStatus;
      error?: string;
    } | null;
    if (!res.ok) return { ok: false, code: body?.error };
    const status = body?.status;
    if (status !== "pending" && status !== "approved" && status !== "denied") return { ok: false };
    return { ok: true, status };
  } catch {
    return { ok: false };
  }
}

/** POST /api/auth/device/approve — grants the CLI a session. Requires a session. */
export async function approveDevice(origin: string, userCode: string): Promise<boolean> {
  try {
    const res = await fetch(`${authOrigin(origin)}/api/auth/device/approve`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userCode }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** POST /api/auth/device/deny — rejects the pending request. Requires a session. */
export async function denyDevice(origin: string, userCode: string): Promise<boolean> {
  try {
    const res = await fetch(`${authOrigin(origin)}/api/auth/device/deny`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userCode }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  createdAt?: string;
}

/**
 * GET /api/auth/organization/list — the signed-in user's organizations
 * (Better Auth organization plugin). Returns [] on any failure — the
 * /account page treats "no orgs" and "couldn't load" the same way visually,
 * with copy that covers both.
 */
export async function listOrganizations(origin: string): Promise<OrganizationSummary[]> {
  try {
    const res = await fetch(`${authOrigin(origin)}/api/auth/organization/list`, {
      credentials: "include",
      cache: "no-store",
    });
    if (!res.ok) return [];
    const body = (await res.json().catch(() => null)) as OrganizationSummary[] | null;
    return Array.isArray(body) ? body : [];
  } catch {
    return [];
  }
}

export type AcceptInvitationResult = { ok: true } | { ok: false; status: number; code?: string };

/**
 * POST /api/auth/organization/accept-invitation. Requires a valid session.
 * Returns `{ ok: false, status: 0 }` on a thrown fetch (network error, CSP
 * block, etc.) rather than throwing — matching getSession/getInvitation's
 * defensiveness so a caller can always branch on the result.
 */
export async function acceptInvitation(
  origin: string,
  id: string,
): Promise<AcceptInvitationResult> {
  try {
    const res = await fetch(`${authOrigin(origin)}/api/auth/organization/accept-invitation`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invitationId: id }),
    });
    if (res.ok) return { ok: true };
    const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
    return { ok: false, status: res.status, code: body?.error?.code };
  } catch {
    return { ok: false, status: 0 };
  }
}

/**
 * GET a JSON array from the auth worker. Returns null on outage/auth/malformed
 * so callers can distinguish "couldn't load" from an empty list.
 */
async function getAuthArray(origin: string, path: string): Promise<unknown[] | null> {
  const result = await fetchWithTimeout(`${authOrigin(origin)}${path}`, {
    credentials: "include",
    cache: "no-store",
  });
  if (result.kind === "unavailable" || !result.response.ok) return null;
  const body = (await result.response.json().catch(() => undefined)) as unknown;
  return Array.isArray(body) ? body : null;
}

/** GET /api/auth/list-sessions — active sessions (browser + CLI device flow). */
export async function listSessions(origin: string): Promise<AuthSession[] | null> {
  const body = await getAuthArray(origin, "/api/auth/list-sessions");
  if (!body) return null;
  return body.filter((row): row is AuthSession => {
    if (!row || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    return typeof r.id === "string" && typeof r.token === "string";
  });
}

/** GET /api/auth/list-accounts — linked identity providers (e.g. GitHub). */
export async function listAccounts(origin: string): Promise<LinkedAccount[] | null> {
  const body = await getAuthArray(origin, "/api/auth/list-accounts");
  if (!body) return null;
  const accounts: LinkedAccount[] = [];
  for (const row of body) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (
      typeof r.id !== "string" ||
      typeof r.providerId !== "string" ||
      typeof r.accountId !== "string"
    ) {
      continue;
    }
    const account: LinkedAccount = {
      id: r.id,
      providerId: r.providerId,
      accountId: r.accountId,
    };
    if (Array.isArray(r.scopes)) {
      const scopes = r.scopes.filter((s): s is string => typeof s === "string" && s.length > 0);
      if (scopes.length > 0) account.scopes = scopes;
    }
    if (r.createdAt !== undefined) account.createdAt = r.createdAt as string | Date;
    if (r.updatedAt !== undefined) account.updatedAt = r.updatedAt as string | Date;
    accounts.push(account);
  }
  return accounts;
}

/**
 * GET /api/auth/account-info — live profile from the linked OAuth provider
 * (uses the stored access token). Pass accountId from list-accounts; without
 * it Better Auth only resolves via an account cookie we do not enable.
 */
export async function getAccountInfo(
  origin: string,
  opts: { providerId: string; accountId: string },
): Promise<ProviderAccountInfo | null> {
  const params = new URLSearchParams({
    providerId: opts.providerId,
    accountId: opts.accountId,
  });
  const result = await fetchWithTimeout(`${authOrigin(origin)}/api/auth/account-info?${params}`, {
    credentials: "include",
    cache: "no-store",
  });
  if (result.kind === "unavailable" || !result.response.ok) return null;
  const body = (await result.response.json().catch(() => undefined)) as
    | { user?: unknown; data?: unknown }
    | null
    | undefined;
  if (!body || typeof body !== "object" || !body.user || typeof body.user !== "object") {
    return null;
  }
  const info: ProviderAccountInfo = {
    user: body.user as ProviderAccountInfo["user"],
  };
  if (body.data && typeof body.data === "object") {
    info.data = body.data as Record<string, unknown>;
  }
  return info;
}

/** POST /api/auth/revoke-session — end one other session. */
export async function revokeSession(origin: string, token: string): Promise<boolean> {
  try {
    const res = await fetch(`${authOrigin(origin)}/api/auth/revoke-session`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
