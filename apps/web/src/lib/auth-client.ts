/**
 * Auth client for apps/web (plan D6, Phase 2).
 *
 * Decision: plain `fetch()` wrappers against the auth worker's REST
 * endpoints, NOT the `better-auth/client` bundle. apps/web ships zero
 * client-side npm dependencies today — `invite.astro` and `console.astro`
 * are plain inline `<script>` tags with no component-island framework (no
 * React in this repo) and a deliberately strict CSP. Pulling in
 * `better-auth/client` would be this app's first client-bundle dependency,
 * for a page surface (`/login`, console, `/admin`, `/account/profile`) that
 * needs session, magic-link, sign-out, GitHub sign-in, and link-social — not a
 * full client SDK. The plan explicitly sanctions this fallback when the
 * client-bundle approach is awkward for the inline-script model (see plan D6).
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
  /** Set when Better Auth's admin plugin has banned the account. */
  banned?: boolean | null;
  /** First CLI device-flow session (sticky); de-emphasizes account setup. */
  cliOnboardedAt?: string | Date | null;
}

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
  // Ban clears sessions; if a banned flag still appears, treat as signed out
  // so shells never paint account chrome for a deactivated user.
  if (body.user.banned === true) return { kind: "signed_out" };
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
 * Better Auth social/link endpoints return `{ url }` instead of 302ing.
 * Navigate when present; return false if the worker rejects or GitHub is
 * unconfigured (D3's gate).
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
 * Link GitHub to the current session (POST /link-social). Profile page uses
 * this so magic-link users can add GitHub without signing out. Failures return
 * to `callbackURL` with `?error=` (also used as errorCallbackURL).
 */
export async function linkGitHub(origin: string, callbackURL: string): Promise<boolean> {
  return redirectToGitHubOAuth(origin, "/api/auth/link-social", {
    provider: "github",
    callbackURL,
    errorCallbackURL: callbackURL,
  });
}

/**
 * OAuth AS resume support (issue #224, Lane B). When the AS sends an
 * unauthenticated user to `/login?<signed authorize query>`, the server only
 * resumes the authorize flow if the sign-in POST body carries `oauth_query` =
 * `location.search` with the leading "?" stripped. Mirrors the official
 * oauth-provider client plugin's fetch hook, which injects this whenever
 * `location.search` contains `sig=` — that param only appears on a signed
 * query, so its presence is the trigger.
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

export interface DeviceWorkspaceLookup {
  requested: string | null;
  create: boolean;
  workspaces: { slug: string; name: string }[];
}

/**
 * GET /api/auth/device/workspace — what the terminal asked for plus the
 * workspaces this account can pick (issue #362). Returns `{ ok: false }` for
 * an unusable code or an outage so the caller can fall back to approving
 * without a workspace decision.
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
 * GET /api/auth/organization/list — the signed-in user's organizations
 * (Better Auth organization plugin). Returns null when the list couldn't be
 * loaded (outage, network) so callers can tell "no orgs" from "don't know" —
 * the consent page routes genuinely org-less users into workspace creation
 * and must not misroute users on a transient failure.
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

/**
 * OAuth AS client metadata (issue #224, Lane B): fields the `/oauth/consent`
 * page reads off `@better-auth/oauth-provider`'s public-client response.
 * `client_uri`/`logo_uri` are attacker-controlled (any registered DCR
 * client) — callers must scheme-check before rendering them as links/images.
 */
export interface OAuthPublicClient {
  client_id: string;
  client_name?: string;
  client_uri?: string;
  logo_uri?: string;
}

/**
 * GET /api/auth/oauth2/public-client?client_id=. Session-gated (credentialed
 * fetch). Returns null on any failure, malformed body, or missing session —
 * the consent page falls back to displaying the raw client_id.
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
 * POST /api/auth/oauth2/workspace-choice (issue #231). Multi-workspace users
 * pick which membership gets baked into the access token; call this before
 * `submitOAuthConsent` on accept when the consent page shows a workspace
 * picker. `workspace` is the org slug. Returns false on any non-2xx or thrown
 * fetch — matching this file's other never-throw wrappers — so the caller can
 * keep the user on the consent panel and show an error rather than submit
 * consent for the wrong (or no) workspace.
 */
/**
 * GET /api/auth/oauth2/workspace-choice — the AS's server-resolved effective
 * workspace (stored choice if still a live membership, else oldest
 * membership). The consent picker defaults to this so an untouched Allow
 * round-trips the AS's own resolution instead of a client-side guess (org
 * `createdAt` order is only a display order, not membership age). Null on
 * any failure — callers fall back to the first listed org.
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
 * location.search → the `oauth_query` string the AS's consent endpoint
 * expects, repairing a specific corruption: better-auth 1.6.23's magic-link
 * verify decodes its callbackURL one time too many, so a signed OAuth query
 * that round-tripped through a sign-in email lands with the sig param's
 * base64 `%2B` collapsed to a literal `+` — which query parsing then folds
 * into a space, and the AS rejects the whole request with
 * `invalid_signature`. A literal `+` can never legitimately appear in `sig`
 * (base64 has no spaces to encode), so re-encoding it is a no-op for clean
 * queries and repairs corrupted ones regardless of which hop dropped the
 * encoding. The double-decode is lossless for sig's other specials (`%2F`→
 * `/`, `%3D`→`=` survive parsing) and for the remaining signed params, whose
 * values (URLs, base64url state/code_challenge) contain no encoded `+`.
 */
export function repairOAuthQuery(search: string): string {
  return search
    .replace(/^\?/, "")
    .replace(
      /(^|&)(sig=)([^&]*)/,
      (_m, sep: string, key: string, value: string) => `${sep}${key}${value.replace(/\+/g, "%2B")}`,
    );
}

export type OAuthConsentResult = { ok: true; redirectUri: string } | { ok: false; error: string };

/**
 * POST /api/auth/oauth2/consent. `oauthQuery` is `location.search` with the
 * leading "?" stripped (the signed consent query the AS handed the browser) —
 * required so the AS can resolve which pending authorize request this is.
 * `scope` is the space-delimited set of scopes the user is granting; omit on
 * deny. Response carries the redirect target (`url` on better-auth 1.6.23,
 * `redirect_uri` in older builds) on success, `error_description` /
 * `message` on rejection (expired/invalid signed query, unknown client, …).
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
    } | null;
    if (!res.ok) {
      return {
        ok: false,
        error: body?.error_description ?? body?.message ?? "Something went wrong. Try again.",
      };
    }
    // better-auth 1.6.23 responds `{ redirect: true, url }` (prod-verified);
    // `redirect_uri` is the shape older plugin builds documented. Accept both.
    const redirectUri = body?.url ?? body?.redirect_uri;
    if (!redirectUri) {
      return { ok: false, error: "The authorization server didn't return a redirect." };
    }
    return { ok: true, redirectUri };
  } catch {
    return { ok: false, error: "Couldn't reach the authorization server. Try again." };
  }
}
