/**
 * Auth client for apps/web: plain `fetch()` wrappers against the auth
 * worker's REST endpoints rather than `better-auth/client`, which would be
 * the app's first client-bundle dependency under a strict CSP and
 * inline-script pages. `credentials: "include"` on every call.
 */
import { emitIssueContext } from "./issue-context";
import { fetchWithTimeout, type RequestFailure } from "./request";
import { normalizeConsentScopes, type ConnectedAppGrant } from "@uploads/auth/connected-apps-wire";
import {
  parseDigestPreferences,
  type DigestWorkspacePreference,
} from "@uploads/auth/digest-preferences-wire";

/**
 * Browser auth traffic goes through this origin's `/api/auth` proxy. Pages
 * that inject a browser-facing auth origin use this constant.
 */
export const SAME_ORIGIN_AUTH_BASE = "";

/**
 * Public origin of the auth worker, defaulting to the local dev origin when
 * unset. `""` (`SAME_ORIGIN_AUTH_BASE`) means same-origin: templates become
 * `/api/auth/...`, which hits this origin's proxy.
 */
export function authOrigin(configuredOrigin?: string): string {
  if (configuredOrigin === "") return "";
  return (configuredOrigin || "https://auth.uploads.sh").replace(/\/$/, "");
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  image?: string | null;
  role?: string | null;
  /** Set when Better Auth's admin plugin has banned the account. */
  banned?: boolean | null;
  /** First CLI device-flow session (sticky); de-emphasizes account setup. */
  cliOnboardedAt?: string | Date | null;
  /** Per-user pref: email me when someone joins a workspace I administer. */
  notifyMemberJoin?: boolean | null;
  /** Per-user pref: email me when a workspace I administer nears its usage limit. */
  notifyUsageLimits?: boolean | null;
  /** Per-user pref: message me in Slack when an upload is held for review. */
  notifySlackHolds?: boolean | null;
  /** Per-user pref: email me when an upload is held for review. Default off. */
  notifyEmailHolds?: boolean | null;
  /** Per-user pref: email me product updates and announcements. Default on. */
  notifyProductUpdates?: boolean | null;
}

export type { DigestWorkspacePreference };

/** Operator-facing copy when sign-in is refused for a banned account. */
export const BANNED_ACCOUNT_MESSAGE =
  "This account has been deactivated. Contact support if you believe this is a mistake.";

/** Session row from get-session / list-sessions. */
export interface AuthSession {
  id: string;
  token: string;
  createdAt: string | Date;
  updatedAt: string | Date;
  expiresAt: string | Date;
  ipAddress?: string | null;
  userAgent?: string | null;
  /** Installed CLI package version (session.additionalFields.cliVersion). */
  cliVersion?: string | null;
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

const LOCAL_STACK_WEB_ORIGIN = "http://127.0.0.1:4321";
/** Keep in sync with `LOCAL_STACK_DEV_HOST` in `apps/auth/src/local-demo.ts`. */
const LOCAL_STACK_DEV_HOST = "local.uploadrouter.dev";

/**
 * True only for a recognized local-stack web origin: the raw stack's
 * loopback port, a portless `*.localhost` origin, or the
 * `local.uploadrouter.dev` zone (optionally worktree-prefixed). Auth origins
 * are always same-origin now, so the page origin is the only signal. A
 * convenience check; the auth worker's `/api/auth/dev-session` enforces.
 */
export function isLocalDemoStack(pageOrigin: string): boolean {
  const normalized = pageOrigin.replace(/\/$/, "");
  if (normalized === LOCAL_STACK_WEB_ORIGIN) return true;
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(url.protocol)) return false;
  const host = url.hostname;
  if (host === LOCAL_STACK_DEV_HOST || host.endsWith(`.${LOCAL_STACK_DEV_HOST}`)) return true;
  const parts = host.split(".");
  return parts.length >= 2 && parts.at(-1) === "localhost";
}

type LocalDemoSessionStart =
  | { kind: "started" }
  | { kind: "not_enabled" }
  | { kind: "unavailable"; reason: RequestFailure | "server" };

/**
 * Parses a get-session response. "No session" (401, or 200 with null) stays
 * distinct from an outage or malformed body, so protected pages never send
 * someone to sign in when the service is merely down. Shared by the browser
 * and SSR paths.
 */
export async function sessionResultFromResponse(response: Response): Promise<SessionResult> {
  if (response.status === 401) return { kind: "signed_out" };
  if (!response.ok) return { kind: "unavailable", reason: "server" };
  const body = (await response.json().catch(() => undefined)) as SessionResponse | null | undefined;
  if (body === null) return { kind: "signed_out" };
  if (!body || !body.user) return { kind: "unavailable", reason: "malformed" };
  // Treat a banned user as signed out so shells never paint account chrome.
  if (body.user.banned === true) return { kind: "signed_out" };
  emitIssueContext({
    userId: body.user.id,
    sessionId: typeof body.session?.id === "string" ? body.session.id : undefined,
  });
  return { kind: "signed_in", session: body };
}

/**
 * GET /api/auth/get-session. `opts.cookie` forwards the request's cookie for
 * a server render, where `credentials: "include"` does nothing.
 */
export async function getSession(
  origin: string,
  opts?: { cookie?: string; fetchImpl?: typeof fetch },
): Promise<SessionResult> {
  const result = await fetchWithTimeout(
    `${authOrigin(origin)}/api/auth/get-session`,
    {
      credentials: "include",
      cache: "no-store",
      ...(opts?.cookie ? { headers: { cookie: opts.cookie } } : {}),
    },
    { fetchImpl: opts?.fetchImpl },
  );
  if (result.kind === "unavailable") return result;
  return sessionResultFromResponse(result.response);
}

/**
 * Creates the local demo session only when this page and Auth both use the
 * stack's exact loopback origins. Auth checks again; this keeps other
 * origins from ever probing the endpoint.
 */
export async function startLocalDemoSession(
  origin: string,
  pageOrigin: string,
): Promise<LocalDemoSessionStart> {
  const normalizedOrigin = authOrigin(origin);
  if (!isLocalDemoStack(pageOrigin)) {
    return { kind: "not_enabled" };
  }

  const result = await fetchWithTimeout(`${normalizedOrigin}/api/auth/dev-session`, {
    method: "POST",
    credentials: "include",
    // better-call sees a non-null body on every POST under Workers and 415s
    // without a Content-Type.
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
 * Social/link endpoints return `{ url }` instead of 302ing. Navigate when
 * present; false when rejected or GitHub is unconfigured.
 */
async function redirectToGitHubOAuth(
  origin: string,
  path: "/api/auth/sign-in/social" | "/api/auth/link-social",
  body: Record<string, unknown>,
): Promise<boolean> {
  try {
    const res = await fetch(`${authOrigin(origin)}${path}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return false;
    const data = (await res.json().catch(() => null)) as { url?: string } | null;
    if (!data?.url) return false;
    location.href = data.url;
    return true;
  } catch {
    return false;
  }
}

/** Start GitHub sign-in (unauthenticated). Carries the OAuth resume query, see oauthResumeBody. */
export async function signInWithGitHub(origin: string, callbackURL: string): Promise<boolean> {
  return redirectToGitHubOAuth(origin, "/api/auth/sign-in/social", {
    provider: "github",
    callbackURL,
    ...oauthResumeBody(),
  });
}

/**
 * Link GitHub to the current session (POST /link-social), so magic-link users
 * can add it without signing out. Failures return to `callbackURL` with
 * `?error=`.
 */
export async function linkGitHub(origin: string, callbackURL: string): Promise<boolean> {
  return redirectToGitHubOAuth(origin, "/api/auth/link-social", {
    provider: "github",
    callbackURL,
    errorCallbackURL: callbackURL,
  });
}

/**
 * Write the "email me when someone joins a workspace I administer" preference
 * through update-user. False on any failure so the toggle can revert.
 */
export async function updateNotifyMemberJoin(origin: string, value: boolean): Promise<boolean> {
  try {
    const res = await fetch(`${authOrigin(origin)}/api/auth/update-user`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notifyMemberJoin: value }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Write the usage-limit email preference. Same contract as `updateNotifyMemberJoin`. */
export async function updateNotifyUsageLimits(origin: string, value: boolean): Promise<boolean> {
  try {
    const res = await fetch(`${authOrigin(origin)}/api/auth/update-user`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notifyUsageLimits: value }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Write the Slack held-upload preference. Same contract as `updateNotifyMemberJoin`. */
export async function updateNotifySlackHolds(origin: string, value: boolean): Promise<boolean> {
  try {
    const res = await fetch(`${authOrigin(origin)}/api/auth/update-user`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notifySlackHolds: value }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Write the email held-upload preference. Same contract as `updateNotifyMemberJoin`. */
export async function updateNotifyEmailHolds(origin: string, value: boolean): Promise<boolean> {
  try {
    const res = await fetch(`${authOrigin(origin)}/api/auth/update-user`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notifyEmailHolds: value }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Write the product-updates preference. Same contract as `updateNotifyMemberJoin`. */
export async function updateNotifyProductUpdates(origin: string, value: boolean): Promise<boolean> {
  try {
    const res = await fetch(`${authOrigin(origin)}/api/auth/update-user`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notifyProductUpdates: value }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Weekly digest switches, one row per workspace the signed-in user belongs
 * to. Null when the request fails, so the page can tell "couldn't load"
 * from "not in any workspace".
 */
export async function listDigestPreferences(
  origin: string,
  opts?: { cookie?: string; fetchImpl?: typeof fetch },
): Promise<DigestWorkspacePreference[] | null> {
  const result = await fetchWithTimeout(
    `${authOrigin(origin)}/api/auth/digest-preferences`,
    {
      credentials: "include",
      cache: "no-store",
      ...(opts?.cookie ? { headers: { cookie: opts.cookie } } : {}),
    },
    { fetchImpl: opts?.fetchImpl },
  );
  if (result.kind === "unavailable" || !result.response.ok) return null;
  return parseDigestPreferences(await result.response.json().catch(() => null));
}

/** Writes one workspace's digest switch. Returns false so the toggle can revert. */
export async function updateDigestPreference(
  origin: string,
  organizationId: string,
  patch: { notifyWeeklyDigest?: boolean; notifyWeeklyWorkspaceDigest?: boolean },
): Promise<boolean> {
  try {
    const res = await fetch(`${authOrigin(origin)}/api/auth/digest-preferences`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organizationId, ...patch }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * OAuth resume: when the AS sends an unauthenticated user to
 * `/login?<signed authorize query>`, sign-in must post `oauth_query` (the
 * query without "?") to resume. Triggered by `sig=`, as in the official
 * oauth-provider client plugin.
 */
function oauthResumeBody(): { oauth_query: string } | Record<string, never> {
  if (typeof location === "undefined") return {};
  const search = location.search;
  if (!search || !new URLSearchParams(search).has("sig")) return {};
  return { oauth_query: search.slice(1) };
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
    body: JSON.stringify({ email, callbackURL, ...oauthResumeBody() }),
  });
  return res.ok;
}

export type PasswordSignInResult =
  | { ok: true; url: string | null }
  | { ok: false; code: string | null };

/**
 * POST /api/auth/sign-in/email. On success `url` is where to go next: the
 * resumed OAuth authorize redirect when signing in mid-OAuth, else null.
 */
export async function signInWithPassword(
  origin: string,
  email: string,
  password: string,
  callbackURL: string,
): Promise<PasswordSignInResult> {
  const res = await fetch(`${authOrigin(origin)}/api/auth/sign-in/email`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, callbackURL, ...oauthResumeBody() }),
  });
  const body = (await res.json().catch(() => null)) as { url?: unknown; code?: unknown } | null;
  if (!res.ok) return { ok: false, code: typeof body?.code === "string" ? body.code : null };
  return { ok: true, url: typeof body?.url === "string" ? body.url : null };
}

/**
 * POST /api/auth/request-password-reset. Emails a link to /reset-password,
 * which both sets a first password and replaces an existing one. The auth
 * worker answers the same whether or not the email has an account.
 */
export async function requestPasswordEmail(origin: string, email: string): Promise<boolean> {
  const res = await fetch(`${authOrigin(origin)}/api/auth/request-password-reset`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, redirectTo: `${location.origin}/reset-password` }),
  });
  return res.ok;
}

/** POST /api/auth/reset-password with the emailed token. Signs out every session on success. */
export async function resetPassword(
  origin: string,
  token: string,
  newPassword: string,
): Promise<{ ok: boolean; code: string | null }> {
  const res = await fetch(`${authOrigin(origin)}/api/auth/reset-password`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, newPassword }),
  });
  if (res.ok) return { ok: true, code: null };
  const body = (await res.json().catch(() => null)) as { code?: unknown } | null;
  return { ok: false, code: typeof body?.code === "string" ? body.code : null };
}

/**
 * POST /api/auth/sign-out. The JSON header and body are needed: a bare POST
 * 415s and leaves the session cookie intact.
 */
export async function signOut(origin: string): Promise<void> {
  await fetch(`${authOrigin(origin)}/api/auth/sign-out`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }).catch(() => undefined);
}

/** Organization-plugin wrappers for `/accept-invitation/[id]`. */
export interface InvitationInfo {
  id: string;
  email: string;
  status: string;
  organizationName?: string;
  organizationId: string;
}

/**
 * GET /api/auth/organization/get-invitation?id=. 401s unless the session
 * email matches the invite; returns null on any non-2xx.
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
 * Device-authorization wrappers for the `/device` approval page, the browser
 * half of `uploads login`.
 */
export type DeviceStatus = "pending" | "approved" | "denied";
export type DeviceLookup = { ok: true; status: DeviceStatus } | { ok: false; code?: string };

/**
 * GET /api/auth/device?user_code=. With a session and a pending code, this
 * claims it for the user, which approve requires. `{ ok: false, code }` for
 * an invalid or expired code.
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

export interface DeviceWorkspaceLookup {
  requested: string | null;
  create: boolean;
  workspaces: { slug: string; name: string }[];
}

/**
 * GET /api/auth/device/workspace — the requested workspace and the ones this
 * account can pick. `{ ok: false }` on an unusable code or outage.
 */
export async function getDeviceWorkspace(
  origin: string,
  userCode: string,
): Promise<{ ok: true; value: DeviceWorkspaceLookup } | { ok: false }> {
  try {
    const res = await fetch(
      `${authOrigin(origin)}/api/auth/device/workspace?user_code=${encodeURIComponent(userCode)}`,
      { credentials: "include", cache: "no-store" },
    );
    if (!res.ok) return { ok: false };
    const body = (await res.json().catch(() => null)) as Partial<DeviceWorkspaceLookup> | null;
    if (!body || !Array.isArray(body.workspaces)) return { ok: false };
    return {
      ok: true,
      value: {
        requested: typeof body.requested === "string" ? body.requested : null,
        create: body.create === true,
        workspaces: body.workspaces.filter(
          (w): w is { slug: string; name: string } =>
            Boolean(w) && typeof w.slug === "string" && typeof w.name === "string",
        ),
      },
    };
  } catch {
    return { ok: false };
  }
}

/** POST /api/auth/device/workspace — record which workspace this login mints for. */
export async function setDeviceWorkspace(
  origin: string,
  userCode: string,
  workspace: string,
): Promise<boolean> {
  try {
    const res = await fetch(`${authOrigin(origin)}/api/auth/device/workspace`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userCode, workspace }),
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
 * GET /api/auth/organization/list. Null when it couldn't load, so the consent
 * page doesn't misroute users into workspace creation on a blip.
 */
export async function listOrganizations(origin: string): Promise<OrganizationSummary[] | null> {
  try {
    const res = await fetch(`${authOrigin(origin)}/api/auth/organization/list`, {
      credentials: "include",
      cache: "no-store",
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as OrganizationSummary[] | null;
    return Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

export type AcceptInvitationResult = { ok: true } | { ok: false; status: number; code?: string };

/**
 * POST /api/auth/organization/accept-invitation. Requires a session. A thrown
 * fetch returns `{ ok: false, status: 0 }`.
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
 * GET a JSON array from the auth worker. Null on outage, auth, or malformed
 * body. `opts.cookie` as in getSession.
 */
async function getAuthArray(
  origin: string,
  path: string,
  opts?: { cookie?: string; fetchImpl?: typeof fetch },
): Promise<unknown[] | null> {
  const result = await fetchWithTimeout(
    `${authOrigin(origin)}${path}`,
    {
      credentials: "include",
      cache: "no-store",
      ...(opts?.cookie ? { headers: { cookie: opts.cookie } } : {}),
    },
    { fetchImpl: opts?.fetchImpl },
  );
  if (result.kind === "unavailable" || !result.response.ok) return null;
  const body = (await result.response.json().catch(() => undefined)) as unknown;
  return Array.isArray(body) ? body : null;
}

/** GET /api/auth/list-sessions (browser and CLI sessions). `opts.cookie` as in getSession. */
export async function listSessions(
  origin: string,
  opts?: { cookie?: string; fetchImpl?: typeof fetch },
): Promise<AuthSession[] | null> {
  const body = await getAuthArray(origin, "/api/auth/list-sessions", opts);
  if (!body) return null;
  return body.filter((row): row is AuthSession => {
    if (!row || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    return typeof r.id === "string" && typeof r.token === "string";
  });
}

/**
 * Global user row from Better Auth's admin plugin (`GET /admin/list-users`).
 * Session + `user.role === "admin"` required; non-admins get 403.
 */
export interface AdminUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  image?: string | null;
  role?: string | null;
  banned?: boolean | null;
  banReason?: string | null;
  createdAt: string | Date;
  updatedAt?: string | Date;
  cliOnboardedAt?: string | Date | null;
}

export interface ListAdminUsersResult {
  users: AdminUser[];
  total: number;
  limit?: number;
  offset?: number;
}

export type ListAdminUsersOptions = {
  /** Max rows (Better Auth coerces the query string). Default 100. */
  limit?: number;
  offset?: number;
  /** Substring match on email or name (see `searchField`). */
  searchValue?: string;
  searchField?: "email" | "name";
  sortBy?: string;
  sortDirection?: "asc" | "desc";
};

function parseAdminUserRow(row: unknown): AdminUser | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.email !== "string" || typeof r.name !== "string") {
    return null;
  }
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    emailVerified: Boolean(r.emailVerified),
    createdAt: (r.createdAt as string | Date) ?? new Date(0),
    ...(r.image !== undefined ? { image: r.image as string | null } : {}),
    ...(r.role !== undefined ? { role: r.role as string | null } : {}),
    ...(r.banned !== undefined ? { banned: r.banned as boolean | null } : {}),
    ...(r.banReason !== undefined ? { banReason: r.banReason as string | null } : {}),
    ...(r.updatedAt !== undefined ? { updatedAt: r.updatedAt as string | Date } : {}),
    ...(r.cliOnboardedAt !== undefined
      ? { cliOnboardedAt: r.cliOnboardedAt as string | Date | null }
      : {}),
  };
}

/**
 * GET /api/auth/admin/list-users — operator directory for `/admin/users`.
 * Null on outage / non-2xx so the page can tell "couldn't load" from empty.
 */
export async function listAdminUsers(
  origin: string,
  options: ListAdminUsersOptions = {},
): Promise<ListAdminUsersResult | null> {
  const params = new URLSearchParams({
    limit: String(options.limit ?? 100),
    sortBy: options.sortBy ?? "createdAt",
    sortDirection: options.sortDirection ?? "desc",
  });
  if (options.offset !== undefined) params.set("offset", String(options.offset));
  if (options.searchValue) {
    params.set("searchValue", options.searchValue);
    params.set("searchField", options.searchField ?? "email");
    params.set("searchOperator", "contains");
  }

  const result = await fetchWithTimeout(
    `${authOrigin(origin)}/api/auth/admin/list-users?${params}`,
    { credentials: "include", cache: "no-store" },
  );
  if (result.kind === "unavailable" || !result.response.ok) return null;
  const body = (await result.response.json().catch(() => undefined)) as
    | { users?: unknown; total?: unknown; limit?: unknown; offset?: unknown }
    | null
    | undefined;
  if (!body || !Array.isArray(body.users) || typeof body.total !== "number") return null;

  const users = body.users
    .map((row) => parseAdminUserRow(row))
    .filter((u): u is AdminUser => u !== null);

  return {
    users,
    total: body.total,
    ...(typeof body.limit === "number" ? { limit: body.limit } : {}),
    ...(typeof body.offset === "number" ? { offset: body.offset } : {}),
  };
}

export type BanUserResult =
  | { ok: true; user: AdminUser | null; tokensRevoked: number }
  | { ok: false; status: number; message: string; code?: string };

type BanWirePayload = {
  user?: unknown;
  tokensRevoked?: unknown;
  error?: { message?: string; code?: string } | string;
  message?: string;
} | null;

function wireError(payload: BanWirePayload, fallback: string): { message: string; code?: string } {
  if (payload?.error && typeof payload.error === "object") {
    return {
      message: payload.error.message || fallback,
      code: payload.error.code,
    };
  }
  if (typeof payload?.error === "string") return { message: payload.error };
  if (payload?.message) return { message: payload.message };
  return { message: fallback };
}

async function postAdminUserAction(
  apiOrigin: string,
  userId: string,
  action: "ban" | "unban",
  body: Record<string, unknown>,
): Promise<BanUserResult> {
  try {
    const res = await fetch(
      `${apiOrigin.replace(/\/$/, "")}/admin-ui/users/${encodeURIComponent(userId)}/${action}`,
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    const payload = (await res.json().catch(() => null)) as BanWirePayload;
    if (!res.ok) {
      const { message, code } = wireError(payload, `${action} failed (${res.status})`);
      return { ok: false, status: res.status, message, code };
    }
    return {
      ok: true,
      user: parseAdminUserRow(payload?.user),
      tokensRevoked: typeof payload?.tokensRevoked === "number" ? payload.tokensRevoked : 0,
    };
  } catch {
    return { ok: false, status: 0, message: "Couldn't reach the API." };
  }
}

/** POST /admin-ui/users/:id/ban — wipe sessions + revoke minted workspace tokens. */
export function banUser(
  apiOrigin: string,
  userId: string,
  options: { banReason?: string } = {},
): Promise<BanUserResult> {
  return postAdminUserAction(apiOrigin, userId, "ban", {
    banReason: options.banReason?.trim() || undefined,
  });
}

/** POST /admin-ui/users/:id/unban — clears ban flags (does not restore tokens). */
export function unbanUser(apiOrigin: string, userId: string): Promise<BanUserResult> {
  return postAdminUserAction(apiOrigin, userId, "unban", {});
}

/** True when a login callback / error body is a Better Auth ban refusal. */
export function isBannedAuthError(input: {
  error?: string | null;
  errorCode?: string | null;
  message?: string | null;
}): boolean {
  const blob = [input.error, input.errorCode, input.message]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join(" ")
    .toLowerCase();
  return (
    blob.includes("banned_user") ||
    blob.includes("has been banned") ||
    blob.includes("has been deactivated") ||
    blob.includes("you have been banned")
  );
}

/** GET /api/auth/list-accounts — linked providers. `opts.cookie` as in getSession. */
export async function listAccounts(
  origin: string,
  opts?: { cookie?: string; fetchImpl?: typeof fetch },
): Promise<LinkedAccount[] | null> {
  const body = await getAuthArray(origin, "/api/auth/list-accounts", opts);
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
 * GET /api/auth/account-info — live provider profile. Pass accountId from
 * list-accounts (no account cookie is enabled). `opts.cookie` as in
 * getSession.
 */
export async function getAccountInfo(
  origin: string,
  opts: { providerId: string; accountId: string; cookie?: string; fetchImpl?: typeof fetch },
): Promise<ProviderAccountInfo | null> {
  const params = new URLSearchParams({
    providerId: opts.providerId,
    accountId: opts.accountId,
  });
  const result = await fetchWithTimeout(
    `${authOrigin(origin)}/api/auth/account-info?${params}`,
    {
      credentials: "include",
      cache: "no-store",
      ...(opts.cookie ? { headers: { cookie: opts.cookie } } : {}),
    },
    { fetchImpl: opts.fetchImpl },
  );
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

/**
 * Organization-subscription wrappers for the billing tab, against the
 * `@better-auth/stripe` endpoints. Both reply `{ url, redirect }`; callers
 * navigate to `url`.
 */
export type SubscriptionActionResult = { ok: true; url: string } | { ok: false; message: string };

async function postSubscriptionAction(
  origin: string,
  path: string,
  body: Record<string, unknown>,
): Promise<SubscriptionActionResult> {
  try {
    const res = await fetch(`${authOrigin(origin)}${path}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => null)) as {
      url?: string;
      message?: string;
      code?: string;
      error?: { message?: string };
    } | null;
    if (!res.ok || typeof data?.url !== "string") {
      return {
        ok: false,
        message: data?.error?.message ?? data?.message ?? "Something went wrong. Try again.",
      };
    }
    return { ok: true, url: data.url };
  } catch {
    return { ok: false, message: "Couldn't reach the auth service. Try again." };
  }
}

/** POST /api/auth/subscription/upgrade for an organization reference. */
export function upgradeOrganizationSubscription(
  origin: string,
  opts: { plan: string; referenceId: string; successUrl: string; cancelUrl: string },
): Promise<SubscriptionActionResult> {
  return postSubscriptionAction(origin, "/api/auth/subscription/upgrade", {
    plan: opts.plan,
    referenceId: opts.referenceId,
    customerType: "organization",
    successUrl: opts.successUrl,
    cancelUrl: opts.cancelUrl,
  });
}

/** POST /api/auth/subscription/billing-portal for an organization reference. */
export function openOrganizationBillingPortal(
  origin: string,
  opts: { referenceId: string; returnUrl: string },
): Promise<SubscriptionActionResult> {
  return postSubscriptionAction(origin, "/api/auth/subscription/billing-portal", {
    referenceId: opts.referenceId,
    customerType: "organization",
    returnUrl: opts.returnUrl,
  });
}

/** One OAuth grant on `/account/connected-apps`. */
export type { ConnectedAppGrant } from "@uploads/auth/connected-apps-wire";

function isConnectedAppGrant(value: unknown): value is ConnectedAppGrant {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  const stringOrNull = (v: unknown) => typeof v === "string" || v === null;
  // Scopes may be a JSON-array string or space-delimited; normalize so a bad
  // payload can't drop the grant.
  r.scopes = normalizeConsentScopes(r.scopes);
  return (
    typeof r.id === "string" &&
    typeof r.clientId === "string" &&
    Array.isArray(r.scopes) &&
    r.scopes.every((s) => typeof s === "string") &&
    stringOrNull(r.clientName) &&
    stringOrNull(r.clientIcon) &&
    stringOrNull(r.clientUri) &&
    stringOrNull(r.referenceId) &&
    typeof r.activeTokenCount === "number" &&
    stringOrNull(r.createdAt) &&
    stringOrNull(r.updatedAt)
  );
}

/**
 * GET /api/auth/oauth2/connected-apps — the user's grants, newest first.
 * Null on any failure. `opts.cookie` as in getSession.
 */
export async function listConnectedApps(
  origin: string,
  opts?: { cookie?: string; fetchImpl?: typeof fetch },
): Promise<ConnectedAppGrant[] | null> {
  const result = await fetchWithTimeout(
    `${authOrigin(origin)}/api/auth/oauth2/connected-apps`,
    {
      credentials: "include",
      cache: "no-store",
      ...(opts?.cookie ? { headers: { cookie: opts.cookie } } : {}),
    },
    { fetchImpl: opts?.fetchImpl },
  );
  if (result.kind === "unavailable" || !result.response.ok) return null;
  const body = (await result.response.json().catch(() => undefined)) as
    | { grants?: unknown }
    | undefined;
  if (!Array.isArray(body?.grants)) return null;
  return body.grants.filter(isConnectedAppGrant);
}

/**
 * POST /api/auth/oauth2/connected-apps/revoke — delete the consent and revoke
 * its tokens. False on failure.
 */
export async function revokeConnectedApp(origin: string, id: string): Promise<boolean> {
  const result = await fetchWithTimeout(
    `${authOrigin(origin)}/api/auth/oauth2/connected-apps/revoke`,
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    },
  );
  return result.kind !== "unavailable" && result.response.ok;
}

/**
 * Public-client fields the `/oauth/consent` page reads. `client_uri` and
 * `logo_uri` are attacker-controlled: scheme-check before rendering.
 * `official` comes from the operator flag, the only field a client can't set.
 */
export interface OAuthPublicClient {
  client_id: string;
  client_name?: string;
  client_uri?: string;
  logo_uri?: string;
  official?: boolean;
}

/**
 * GET /api/auth/oauth2/public-client?client_id=. Null on any failure; the
 * page then shows the raw client_id.
 */
export async function getOAuthPublicClient(
  origin: string,
  clientId: string,
): Promise<OAuthPublicClient | null> {
  try {
    const res = await fetch(
      `${authOrigin(origin)}/api/auth/oauth2/public-client?client_id=${encodeURIComponent(clientId)}`,
      { credentials: "include", cache: "no-store" },
    );
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as OAuthPublicClient | null;
    return body && typeof body.client_id === "string" ? body : null;
  } catch {
    return null;
  }
}

/**
 * GET /api/auth/oauth2/workspace-choice — the AS's resolved workspace (stored
 * choice if still valid, else oldest membership). The picker defaults to it
 * so an untouched Allow keeps the AS's answer. Null on failure.
 */
export async function getOAuthWorkspaceChoice(origin: string): Promise<string | null> {
  try {
    const res = await fetch(`${authOrigin(origin)}/api/auth/oauth2/workspace-choice`, {
      credentials: "include",
      cache: "no-store",
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { workspace?: unknown } | null;
    return typeof body?.workspace === "string" ? body.workspace : null;
  } catch {
    return null;
  }
}

/**
 * POST /api/auth/oauth2/workspace-choice: which membership the token gets.
 * Call before `submitOAuthConsent` when the picker is shown. False on any
 * failure, so the page doesn't submit consent for the wrong workspace.
 */
export async function setOAuthWorkspaceChoice(origin: string, workspace: string): Promise<boolean> {
  try {
    const res = await fetch(`${authOrigin(origin)}/api/auth/oauth2/workspace-choice`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * location.search → `oauth_query`, repairing a known corruption: magic-link
 * verify decodes its callbackURL once too often, collapsing `%2B` in `sig` to
 * `+`, which parses as a space and fails `invalid_signature`. `sig` can never
 * contain a literal `+`, so re-encoding is a no-op for clean queries.
 */
export function repairOAuthQuery(search: string): string {
  return search
    .replace(/^\?/, "")
    .replace(
      /(^|&)(sig=)([^&]*)/,
      (_m, sep: string, key: string, value: string) => `${sep}${key}${value.replace(/\+/g, "%2B")}`,
    );
}

export type OAuthConsentResult =
  | { ok: true; redirectUri: string }
  | {
      ok: false;
      error: string;
      /** Retrying can never succeed; disable Allow/Deny. */
      permanent: boolean;
    };

/**
 * Copy for a signed query that no longer verifies. A bad signature and an
 * elapsed `exp` both surface as `invalid_signature`. Clicking again can't
 * fix it; only the client app can restart the flow.
 */
export const OAUTH_QUERY_EXPIRED_MESSAGE =
  "This authorization request has expired. Return to the app you were connecting and start the connection again.";
const OAUTH_CONSENT_PERMANENT_ERRORS: Record<string, string> = {
  invalid_signature: OAUTH_QUERY_EXPIRED_MESSAGE,
};

/** True when the signed query's `exp` has elapsed, so the page can show the expired state up front. */
export function isOAuthQueryExpired(search: string, now: number = Date.now()): boolean {
  const exp = Number(new URLSearchParams(search.replace(/^\?/, "")).get("exp"));
  return Number.isFinite(exp) && exp > 0 && exp * 1000 <= now;
}

/**
 * POST /api/auth/oauth2/consent. `oauthQuery` is the signed query without
 * "?". `scope` is the granted scopes; omit on deny. Errors are often a bare
 * `{"error": "<code>"}`: `error_description`/`message` win, then known codes
 * map to copy, then the generic fallback.
 */
export async function submitOAuthConsent(
  origin: string,
  opts: { accept: boolean; scope?: string; oauthQuery: string },
): Promise<OAuthConsentResult> {
  try {
    const res = await fetch(`${authOrigin(origin)}/api/auth/oauth2/consent`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accept: opts.accept,
        ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
        oauth_query: opts.oauthQuery,
      }),
    });
    const body = (await res.json().catch(() => null)) as {
      redirect_uri?: string;
      url?: string;
      error_description?: string;
      message?: string;
      error?: string;
    } | null;
    if (!res.ok) {
      const mapped = body?.error ? OAUTH_CONSENT_PERMANENT_ERRORS[body.error] : undefined;
      return {
        ok: false,
        error:
          body?.error_description ?? body?.message ?? mapped ?? "Something went wrong. Try again.",
        permanent: mapped !== undefined,
      };
    }
    // `url` today; `redirect_uri` in older plugin builds.
    const redirectUri = body?.url ?? body?.redirect_uri;
    if (!redirectUri) {
      return {
        ok: false,
        error: "The authorization server didn't return a redirect.",
        permanent: false,
      };
    }
    return { ok: true, redirectUri };
  } catch {
    return {
      ok: false,
      error: "Couldn't reach the authorization server. Try again.",
      permanent: false,
    };
  }
}
