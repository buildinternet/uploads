/**
 * Better Auth instance factory. `createAuth(env)` is memoized per isolate,
 * keyed on every auth-relevant env field so a config change never serves a
 * stale instance.
 */
import { cimd } from "@better-auth/cimd";
import { dash } from "@better-auth/infra";
import { oauthProvider } from "@better-auth/oauth-provider";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware, isAPIError } from "better-auth/api";
import { and, asc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  admin,
  bearer,
  deviceAuthorization,
  jwt,
  magicLink,
  organization,
} from "better-auth/plugins";
import {
  coerceExplicitWebToNativeForPrivateUseScheme,
  defaultRegistrationApplicationType,
  fetchClientMetadataResource,
  rewriteClientMetadataGrantTypes,
} from "./cimd-transport";
import { connectedAppsPlugin } from "./connected-apps";
import { digestPreferencesPlugin } from "./digest-preferences";
import { deviceWorkspacePlugin } from "./device-workspace";
import {
  oauthClientIdFromAuthorizationCode,
  oauthClientIdFromConsentBody,
  oauthClientIdFromQuery,
  restrictAuthorizationCodeValue,
  restrictOAuthConsentBody,
  restrictOAuthQueryScopes,
} from "./oauth-grant-scopes";
import { sendAuthEmail } from "./email";
import { localDemoEnabled, localDemoPlugin } from "./local-demo";
import { memberCapDenial } from "./member-cap";
import {
  isWorkspaceManagerRole,
  revokeAllTokensForMintingUser,
  revokeMemberWorkspaceGovernanceTokens,
  revokeMemberWorkspaceTokens,
} from "./member-tokens";
import { notifyAdminsOfMemberJoin } from "./notify-member-join";
import {
  clampDcrRegistrationResult,
  dcrClientRowPatch,
  cimdClientRowFixups,
  dcrRegistrationRejection,
  sanitizeDcrRegistrationBody,
} from "./oauth-dcr";
import { annotatePublicClientOfficial, PUBLIC_CLIENT_PATHS } from "./oauth-public-client";
import { hasProductUpdatesOptOut } from "./product-updates";
import { reportHandledError } from "@uploads/observability";
import { setIssueContext } from "@uploads/observability/issues";
import { buildTokenGrantAfterHandler, captureRefreshTokenPriorState } from "./oauth-observability";
import {
  createBindingRateLimitStorage,
  rateLimitTiers,
  type RateLimitBindings,
} from "./rate-limit";
import * as schema from "./schema";
import { stripePluginOrNone } from "./stripe-plugin";
import { authTrustedOrigins, isTrustedOrigin } from "./trusted-origins";
import {
  applyWorkspaceChoice,
  resolveWorkspaceChoiceReferenceId,
  workspaceChoicePlugin,
} from "./workspace-choice";
import {
  resolveDashApiKey,
  resolveGitHubCredentials,
  resolveSigningSecret,
  type DashApiKeyEnv,
  type GitHubCredentialsEnv,
} from "./secrets";

/**
 * RFC 8628 device-flow client gate. Any registered, enabled client whose
 * grant_types include the device-code grant may start a device flow (the
 * CLI's `uploads-cli` is a seeded row). Fail-closed: a missing row, a
 * disabled toggle, or no grant type all reject.
 */
export const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
export async function isDeviceFlowClientAllowed(
  db: ReturnType<typeof drizzle<typeof schema>>,
  clientId: string,
): Promise<boolean> {
  const [row] = await db
    .select({
      disabled: schema.oauthClient.disabled,
      grantTypes: schema.oauthClient.grantTypes,
    })
    .from(schema.oauthClient)
    .where(eq(schema.oauthClient.clientId, clientId))
    .limit(1);
  if (!row || row.disabled) return false;
  return Array.isArray(row.grantTypes) && row.grantTypes.includes(DEVICE_CODE_GRANT);
}

/** CLI device-flow User-Agent — keep in sync with apps/web `CLI_USER_AGENT_RE`. */
export function isCliSessionUserAgent(ua?: string | null): boolean {
  return Boolean(ua && /@buildinternet\/uploads(?:\/[\w.-]+)?/i.test(ua));
}

/**
 * OAuth scopes. Duplicated rather than imported (this worker doesn't depend
 * on `@uploads/api`); keep in lockstep with `FILE_SCOPES` in
 * `apps/api/src/auth-db.ts`.
 */
export const OAUTH_SCOPES = ["files:read", "files:write", "files:delete"] as const;

/** Optional OIDC identity claims, separate from workspace file permissions. */
const OAUTH_IDENTITY_SCOPES = ["openid", "email"] as const;

/**
 * The oauth-provider plugin only issues a refresh token when the grant
 * includes `offline_access`. Registered by default on self-registered
 * clients and unioned into authorize requests by oauth-grant-scopes.ts,
 * since clients copy `scope` from resource metadata that lists only files:*.
 */
export const OAUTH_OFFLINE_ACCESS_SCOPE = "offline_access";

/** Default scopes granted to a dynamically registered client that requests none. */
const OAUTH_CLIENT_REGISTRATION_DEFAULT_SCOPES = [
  "files:read",
  "files:write",
  OAUTH_OFFLINE_ACCESS_SCOPE,
] as const;

/**
 * Extra scopes a CIMD/DCR client may request (consent still required). Better
 * Auth 1.7 persists self-registered clients as default ∪ allowed.
 */
const OAUTH_CLIENT_REGISTRATION_ALLOWED_SCOPES = [
  "files:delete",
  ...OAUTH_IDENTITY_SCOPES,
] as const;

/**
 * Fallback when the oauth_client row is missing (CIMD first-use: persist
 * can run after hooks.before). Matches what Better Auth writes on the row.
 * Do not expand this to a future elevated scope that should stay off CIMD.
 */
const OAUTH_SELF_REGISTERED_SCOPES = [
  ...OAUTH_CLIENT_REGISTRATION_DEFAULT_SCOPES,
  ...OAUTH_CLIENT_REGISTRATION_ALLOWED_SCOPES,
] as const;

type AuthAdapterUpdate = Parameters<ReturnType<ReturnType<typeof drizzleAdapter>>["update"]>[0];

function preserveScopeCeiling(params: AuthAdapterUpdate) {
  // Only the SDK's CIMD metadata refresh includes both this discovery
  // marker and ownership predicate. Ordinary client edits keep scopes.
  if (
    params.model === "oauthClient" &&
    params.update.clientDiscoveryId === "cimd" &&
    params.where.some((clause) => clause.field === "clientDiscoveryId" && clause.value === "cimd")
  ) {
    const { scopes: _scopes, ...update } = params.update;
    return { ...params, update };
  }
  return params;
}

/**
 * Canonical MCP resource identifiers (`origin/mcp`). Generic clients often
 * copy the origin instead; {@link oauthResources} adds both. Keep in lockstep
 * with apps/mcp's `OAUTH_AUDIENCES`.
 */
const MCP_RESOURCE_IDENTIFIERS = [
  "https://agents.uploads.sh/mcp",
  "https://mcp.uploads.sh/mcp",
] as const;

/** `/mcp` identifier plus its origin form; other URLs pass through. */
export function mcpResourceAndOrigin(resource: string): string[] {
  try {
    const url = new URL(resource);
    if (url.pathname === "/mcp" || url.pathname === "/mcp/") {
      return [resource, url.origin];
    }
  } catch {
    // Non-URL env values stay as configured.
  }
  return [resource];
}

/**
 * Protected resources this AS issues tokens for. Each becomes an
 * `oauth_resource` row and an RFC 8707 `resource` value; the token's `aud`
 * is bound to it.
 */
export function oauthResources(): string[] {
  return [...new Set(MCP_RESOURCE_IDENTIFIERS.flatMap(mcpResourceAndOrigin))];
}

/**
 * Workspace claims for every OAuth access token: the oldest membership's
 * slug as `workspace`, plus every slug. Zero memberships still returns
 * `workspace: null`; a token must always issue.
 */
export async function resolveWorkspaceClaims(
  db: ReturnType<typeof drizzle<typeof schema>>,
  userId: string | undefined,
): Promise<{ workspace: string | null; workspaces: string[] }> {
  if (!userId) return { workspace: null, workspaces: [] };
  const rows = await db
    .select({ slug: schema.organization.slug })
    .from(schema.member)
    .innerJoin(schema.organization, eq(schema.member.organizationId, schema.organization.id))
    .where(eq(schema.member.userId, userId))
    // Secondary sort on id: memberships created in the same millisecond must
    // still yield the same primary workspace on every token issuance.
    .orderBy(asc(schema.member.createdAt), asc(schema.member.id));
  const workspaces = rows.map((r) => r.slug);
  return { workspace: workspaces[0] ?? null, workspaces };
}

/** The global `user.role` the `admin()` plugin treats as admin. */
const ADMIN_ROLE = "admin";

/**
 * Last-admin guard. The `admin()` plugin refuses self-removal and self-ban
 * but not removing or banning the last admin, which locks every operator out
 * with no recovery short of a DB edit. `user.role` can be a comma-separated
 * list, so this checks for the admin token anywhere in it.
 */
export function hasAdminRole(role: string | null | undefined): boolean {
  if (!role) return false;
  return role
    .split(",")
    .map((r) => r.trim())
    .includes(ADMIN_ROLE);
}

/**
 * `hasAdminRole` for the raw `role` the set-role and update-user bodies
 * accept: a string or an array of strings.
 */
function hasAdminRoleInput(role: unknown): boolean {
  if (typeof role === "string") return hasAdminRole(role);
  if (Array.isArray(role)) return hasAdminRole(role.join(","));
  return false;
}

/** Count of non-banned users currently holding the admin role. */
export async function countActiveAdmins(
  db: ReturnType<typeof drizzle<typeof schema>>,
): Promise<number> {
  const rows = await db
    .select({ role: schema.user.role, banned: schema.user.banned })
    .from(schema.user);
  // Filter in JS: the role column is free-form comma-separated and the admin
  // population is small.
  return rows.filter((r) => hasAdminRole(r.role) && !r.banned).length;
}

/** Role (+ banned) of a single user, for the last-admin guard below. */
async function getUserRoleState(
  db: ReturnType<typeof drizzle<typeof schema>>,
  userId: string,
): Promise<{ role: string | null; banned: boolean | null } | undefined> {
  const [row] = await db
    .select({ role: schema.user.role, banned: schema.user.banned })
    .from(schema.user)
    .where(eq(schema.user.id, userId))
    .limit(1);
  return row;
}

type AuthBeforeCtx = {
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
};

async function applyOAuthClientInterop(
  ctx: AuthBeforeCtx,
  registeredScopesForClientId: (clientId: string | undefined) => Promise<readonly string[]>,
): Promise<{
  context: { body?: Record<string, unknown>; query?: Record<string, unknown> };
} | void> {
  if (ctx.path === "/oauth2/register") {
    const body = ctx.body as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) return;
    // Discovery lists private_key_jwt for CIMD only; DCR refuses it rather
    // than downgrading a key-holding client to `none` (see oauth-dcr.ts).
    const rejection = dcrRegistrationRejection(body);
    if (rejection) {
      throw new APIError("BAD_REQUEST", {
        error: "invalid_client_metadata",
        error_description: rejection,
      });
    }
    const withGrantTypes = rewriteClientMetadataGrantTypes(body) ?? body;
    const withDefaultType = defaultRegistrationApplicationType(withGrantTypes) ?? withGrantTypes;
    const afterAppType =
      coerceExplicitWebToNativeForPrivateUseScheme(withDefaultType) ?? withDefaultType;
    const sanitized = sanitizeDcrRegistrationBody(afterAppType);
    const next = sanitized ?? afterAppType;
    if (next !== body) return { context: { body: next } };
    return;
  }
  if (ctx.path === "/oauth2/authorize") {
    const query = ctx.query;
    const allowedScopes = await registeredScopesForClientId(oauthClientIdFromQuery(query));
    // Omitted scope keeps the previous file-only default. Enabling optional
    // OIDC scopes must not make the SDK's all-supported-scopes default add identity.
    const requestedQuery =
      query && query.scope === undefined ? { ...query, scope: OAUTH_SCOPES.join(" ") } : query;
    const nextQuery =
      restrictOAuthQueryScopes(requestedQuery, allowedScopes) ??
      (requestedQuery !== query ? requestedQuery : undefined);
    if (nextQuery?.scope === "") {
      throw new APIError("BAD_REQUEST", {
        error: "invalid_scope",
        error_description: "No requested scopes can be granted",
      });
    }
    if (nextQuery) return { context: { query: nextQuery } };
    return;
  }
  if (ctx.path === "/oauth2/consent") {
    const body = ctx.body as Record<string, unknown> | undefined;
    const allowedScopes = await registeredScopesForClientId(oauthClientIdFromConsentBody(body));
    const nextBody = restrictOAuthConsentBody(body, allowedScopes);
    if (nextBody) return { context: { body: nextBody } };
  }
  if (ctx.path === "/oauth2/token") {
    const body = ctx.body as Record<string, unknown> | undefined;
    if (body?.grant_type === "refresh_token" && typeof body.scope === "string") {
      const scopes = body.scope.split(/\s+/);
      if (scopes.includes("email") && !scopes.includes("openid")) {
        throw new APIError("BAD_REQUEST", {
          error: "invalid_scope",
          error_description: "The email scope requires openid",
        });
      }
    }
  }
}

function authBeforeHook(
  db: ReturnType<typeof drizzle<typeof schema>>,
  registeredScopesForClientId: (clientId: string | undefined) => Promise<readonly string[]>,
) {
  return createAuthMiddleware(async (ctx) => {
    const oauthOverride = await applyOAuthClientInterop(ctx, registeredScopesForClientId);
    if (oauthOverride) return oauthOverride;
    // Snapshot the presented refresh token's rotation state before the
    // plugin's /oauth2/token handler runs (see oauth-observability.ts).
    await captureRefreshTokenPriorState(db, ctx);
    await enforceLastAdminGuard(ctx, db);
  });
}

/**
 * After a successful `/oauth2/register`, persist the public-PKCE posture on
 * the new row and rewrite the 201 JSON so it cannot return a `client_secret`
 * or skip_consent/trusted. Best-effort: the before-hook and plugin options
 * are the primary gate. Does not rewrite scopes.
 */
async function clampRegisteredDcrClient(
  db: ReturnType<typeof drizzle<typeof schema>>,
  returned: unknown,
): Promise<void> {
  const clientId = clampDcrRegistrationResult(returned);
  if (!clientId) return;
  try {
    await db
      .update(schema.oauthClient)
      .set(dcrClientRowPatch())
      .where(eq(schema.oauthClient.clientId, clientId));
  } catch (err) {
    reportHandledError(new Error("DCR client row clamp failed after register", { cause: err }));
  }
}

/**
 * Best-effort row fix-up after the cimd plugin persists a client (see
 * `cimdClientRowFixups`). The plugin logs and ignores a thrown hook, and the
 * in-request client already behaves the same (null requirePKCE reads as
 * required; a stale jwksUri is unused without private_key_jwt).
 */
async function applyCimdClientRowFixups(
  db: ReturnType<typeof drizzle<typeof schema>>,
  client: Parameters<typeof cimdClientRowFixups>[0] & { clientId: string },
): Promise<void> {
  const patch = cimdClientRowFixups(client);
  if (!patch) return;
  try {
    await db
      .update(schema.oauthClient)
      .set(patch)
      .where(
        and(
          eq(schema.oauthClient.clientId, client.clientId),
          eq(schema.oauthClient.clientDiscoveryId, "cimd"),
        ),
      );
  } catch (err) {
    reportHandledError(new Error("CIMD client row fix-up failed", { cause: err }));
  }
}

/**
 * `ctx.context.session` is `{ user, session }` once Better Auth has resolved
 * a session. Only the row ids are attributes — `session.token` is the cookie.
 */
function issueContextFromAuthSession(session: unknown): void {
  if (!session || typeof session !== "object") return;
  const bag = session as {
    id?: unknown;
    user?: { id?: unknown };
    session?: { id?: unknown };
  };
  const userId = typeof bag.user?.id === "string" ? bag.user.id : undefined;
  const nestedSessionId = typeof bag.session?.id === "string" ? bag.session.id : undefined;
  const ownId = typeof bag.id === "string" ? bag.id : undefined;
  setIssueContext({
    userId,
    sessionId: nestedSessionId ?? (ownId !== userId ? ownId : undefined),
  });
}

function authAfterHook(
  env: { AUTH_EVENTS?: AnalyticsEngineDataset; DB: D1Database },
  db: ReturnType<typeof drizzle<typeof schema>>,
) {
  const tokenAfter = buildTokenGrantAfterHandler(env, isAPIError);
  return createAuthMiddleware(async (ctx) => {
    issueContextFromAuthSession(ctx.context.session);
    if (ctx.path === "/oauth2/register") {
      await clampRegisteredDcrClient(db, ctx.context.returned);
    }
    if (PUBLIC_CLIENT_PATHS.has(ctx.path)) {
      await annotatePublicClientOfficial(db, ctx.context.returned);
    }
    if (ctx.path === "/organization/leave") {
      await revokeTokensAfterLeave(env.DB, db, ctx.context.returned);
    }
    if (ctx.path === "/admin/remove-user") {
      await revokeTokensAfterUserRemoval(env.DB, ctx.body, ctx.context.returned);
    }
    await tokenAfter(ctx);
  });
}

/**
 * `/admin/remove-user` drops every membership via the `member.user_id`
 * cascade without firing `organizationHooks`, so tokens are revoked here.
 * Runs after the handler so the plugin's admin check has passed. Revoke
 * failures are logged, not rethrown: the membership is already gone. The
 * `/organization/leave` path below works the same way.
 */
async function revokeTokensAfterUserRemoval(
  d1: D1Database,
  body: unknown,
  returned: unknown,
): Promise<void> {
  if (isAPIError(returned) || !returned || typeof returned !== "object") return;
  if ((returned as { success?: unknown }).success !== true) return;
  const userId = (body as { userId?: unknown } | undefined)?.userId;
  if (typeof userId !== "string" || !userId) return;
  try {
    await revokeAllTokensForMintingUser(d1, userId);
  } catch (err) {
    reportHandledError(new Error("user_removal_token_revoke_failed", { cause: err }));
  }
}

async function revokeTokensAfterLeave(
  d1: D1Database,
  db: ReturnType<typeof drizzle<typeof schema>>,
  returned: unknown,
): Promise<void> {
  if (isAPIError(returned) || !returned || typeof returned !== "object") return;
  const { organizationId, userId } = returned as { organizationId?: unknown; userId?: unknown };
  if (typeof organizationId !== "string" || typeof userId !== "string") return;
  try {
    const [org] = await db
      .select({ slug: schema.organization.slug })
      .from(schema.organization)
      .where(eq(schema.organization.id, organizationId))
      .limit(1);
    if (org) await revokeMemberWorkspaceTokens(d1, org.slug, userId);
  } catch (err) {
    reportHandledError(new Error("member_leave_token_revoke_failed", { cause: err }));
  }
}

/**
 * Last-admin check for the `admin()` plugin's remove-user, ban-user,
 * set-role and update-user endpoints. The plugin blocks only self-removal
 * and self-ban; set-role and update-user (`data.role`, `data.banned`) have
 * no last-admin protection of their own.
 */
async function enforceLastAdminGuard(
  ctx: AuthBeforeCtx,
  db: ReturnType<typeof drizzle<typeof schema>>,
): Promise<void> {
  if (ctx.path === "/admin/remove-user" || ctx.path === "/admin/ban-user") {
    const userId = (ctx.body as { userId?: unknown } | undefined)?.userId;
    if (typeof userId !== "string" || !userId) return;

    const target = await getUserRoleState(db, userId);
    if (!target || !hasAdminRole(target.role)) return;
    // A banned admin is not an active admin: removing or re-banning them
    // cannot reduce the active-admin count, so the guard stays out of it.
    if (target.banned) return;

    const activeAdmins = await countActiveAdmins(db);
    if (activeAdmins <= 1) {
      throw new APIError("BAD_REQUEST", {
        message:
          ctx.path === "/admin/remove-user"
            ? "cannot remove the last admin"
            : "cannot ban the last admin",
      });
    }
    return;
  }

  if (ctx.path === "/admin/set-role") {
    const body = ctx.body as { userId?: unknown; role?: unknown } | undefined;
    const userId = body?.userId;
    if (typeof userId !== "string" || !userId) return;

    const target = await getUserRoleState(db, userId);
    // A banned target isn't an active admin, and a role that keeps admin
    // changes nothing.
    if (!target || target.banned || !hasAdminRole(target.role)) return;
    if (hasAdminRoleInput(body?.role)) return;

    const activeAdmins = await countActiveAdmins(db);
    if (activeAdmins <= 1) {
      throw new APIError("BAD_REQUEST", {
        message: "cannot remove the last admin's admin role",
      });
    }
    return;
  }

  if (ctx.path === "/admin/update-user") {
    const body = ctx.body as { userId?: unknown; data?: unknown } | undefined;
    const userId = body?.userId;
    if (typeof userId !== "string" || !userId) return;
    const data = (body?.data ?? {}) as { role?: unknown; banned?: unknown };

    const target = await getUserRoleState(db, userId);
    if (!target || target.banned || !hasAdminRole(target.role)) return;

    const willBan = data.banned === true;
    const rolesInBody = Object.prototype.hasOwnProperty.call(data, "role");
    const willStripAdmin = rolesInBody && !hasAdminRoleInput(data.role);
    if (!willBan && !willStripAdmin) return;

    const activeAdmins = await countActiveAdmins(db);
    if (activeAdmins <= 1) {
      throw new APIError("BAD_REQUEST", {
        message: willBan
          ? "cannot ban the last admin"
          : "cannot remove the last admin's admin role",
      });
    }
    return;
  }
}

export type AuthEnv = GitHubCredentialsEnv &
  DashApiKeyEnv &
  RateLimitBindings & {
    DB: D1Database;
    EMAIL?: import("./email").EmailBinding;
    BETTER_AUTH_URL?: string;
    BETTER_AUTH_SECRET?: string;
    WEB_ORIGIN?: string;
    /** The auth worker's direct origin (e.g. https://auth.uploads.sh), where
     * the OAuth form-POST endpoints are advertised so Astro's checkOrigin on
     * the `/api` proxy can't 403 them. Unset in dev/preview. */
    AUTH_DIRECT_ORIGIN?: string;
    ENVIRONMENT?: string;
    BETTER_AUTH_TRUSTED_ORIGINS?: string;
    AUTH_RATE_LIMIT_DISABLED?: string;
    /** Ephemeral flag passed only by `pnpm dev:stack`; never configure in prod. */
    LOCAL_STACK?: string;
    /** Gates stripePluginOrNone and feeds the memoization key. */
    STRIPE_SECRET_KEY?: string;
    STRIPE_WEBHOOK_SECRET?: string;
    STRIPE_PRO_PRICE_ID?: string;
    /**
     * Analytics Engine dataset for OAuth refresh signals
     * (oauth-observability.ts). Absent in tests and dev; writers no-op.
     */
    AUTH_EVENTS?: AnalyticsEngineDataset;
  };

export type BetterAuthInstance = ReturnType<typeof buildAuth>;

/**
 * Rate-limit storage: the Rate Limiting bindings when all are bound, Better
 * Auth's in-memory Map otherwise. Both branches return the same shape so
 * callers don't have to narrow a union.
 */
function rateLimitStorage(env: AuthEnv): {
  customStorage?: ReturnType<typeof createBindingRateLimitStorage>;
  storage?: "memory";
} {
  const tiers = rateLimitTiers(env);
  if (tiers) return { customStorage: createBindingRateLimitStorage(tiers) };
  return { storage: "memory" };
}

/**
 * Records the GitHub login on every completed GitHub OAuth callback (from
 * `mapProfileToUser`, the only hook that sees the raw profile).
 * Last-write-wins so renames update; never throws, so sign-in can't fail on it.
 */
export async function upsertGithubLogin(
  db: ReturnType<typeof drizzle<typeof schema>>,
  githubAccountId: string,
  login: string,
): Promise<void> {
  if (!githubAccountId || !login) return;
  try {
    await db
      .insert(schema.githubIdentity)
      .values({ accountId: githubAccountId, login, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: schema.githubIdentity.accountId,
        set: { login, updatedAt: new Date() },
      });
  } catch (err) {
    reportHandledError(new Error("github login capture failed", { cause: err }));
  }
}

/**
 * The issuer origin and the auth worker's direct origin when they differ
 * (prod: uploads.sh vs auth.uploads.sh). Undefined in dev/preview. Shared by
 * the discovery rewrite in `index.ts` and the assertion audiences below.
 */
export function directAuthOrigins(
  env: Pick<AuthEnv, "AUTH_DIRECT_ORIGIN" | "BETTER_AUTH_URL">,
): { issuerOrigin: string; directOrigin: string } | undefined {
  const authOrigin = env.AUTH_DIRECT_ORIGIN;
  if (!authOrigin) return undefined;
  try {
    const issuerOrigin = new URL(env.BETTER_AUTH_URL || "https://auth.uploads.sh").origin;
    const directOrigin = new URL(authOrigin).origin;
    if (issuerOrigin === directOrigin) return undefined;
    return { issuerOrigin, directOrigin };
  } catch {
    return undefined;
  }
}

/**
 * `clientAssertionAudienceOrigins`, added by our oauth-provider patch.
 * Discovery advertises the token endpoints on AUTH_DIRECT_ORIGIN, and RFC
 * 7523 clients (Vercel Connect) put that URL in `aud`, so it must verify
 * too. Spread in because the option isn't in the plugin's types.
 */
function clientAssertionAudienceOptions(env: AuthEnv): {
  clientAssertionAudienceOrigins?: string[];
} {
  const origins = directAuthOrigins(env);
  return origins ? { clientAssertionAudienceOrigins: [origins.directOrigin] } : {};
}

function buildAuth(
  env: AuthEnv,
  signingSecret: string,
  github: { clientId: string; clientSecret: string } | null,
  dashApiKey: string | null,
) {
  const db = drizzle(env.DB, { schema });
  const fixCimdClientRow = ({
    client,
  }: {
    client: Parameters<typeof applyCimdClientRowFixups>[1];
  }) => applyCimdClientRowFixups(db, client);
  const betterAuthUrl = env.BETTER_AUTH_URL || "https://auth.uploads.sh";
  const webOrigin = env.WEB_ORIGIN || "https://uploads.sh";
  const isProduction = env.ENVIRONMENT === "production";
  /**
   * Registered `oauth_client.scopes`, or {@link OAUTH_SELF_REGISTERED_SCOPES}
   * when the row is missing (CIMD first-use: persist can run after this
   * hook). An existing row never inherits newly supported scopes.
   */
  const registeredScopesForClientId = async (
    clientId: string | undefined,
  ): Promise<readonly string[]> => {
    if (!clientId) return [];
    try {
      const rows = await db
        .select({ scopes: schema.oauthClient.scopes })
        .from(schema.oauthClient)
        .where(eq(schema.oauthClient.clientId, clientId))
        .limit(1);
      if (!rows[0]) return OAUTH_SELF_REGISTERED_SCOPES;
      // CIMD stores an encoded JSON array through Better Auth's adapter;
      // Drizzle decodes its outer JSON layer, leaving the encoded string.
      const scopes: unknown =
        typeof rows[0].scopes === "string" ? JSON.parse(rows[0].scopes) : rows[0].scopes;
      return Array.isArray(scopes) && scopes.every((scope) => typeof scope === "string")
        ? scopes
        : [];
    } catch {
      throw new APIError("SERVICE_UNAVAILABLE", {
        error: "temporarily_unavailable",
        error_description: "Unable to verify client permissions",
      });
    }
  };

  return betterAuth({
    appName: "uploads.sh",
    baseURL: betterAuthUrl,
    basePath: "/api/auth",
    secret: signingSecret,
    // OAuth callback failures redirect here instead of Better Auth's default
    // error page. A per-request errorCallbackURL still wins.
    onAPIError: {
      errorURL: `${webOrigin}/auth/error`,
    },
    // The adapter matches schema exports to plugin models by name.
    database: (options: Parameters<ReturnType<typeof drizzleAdapter>>[0]) => {
      const adapter = drizzleAdapter(db, { provider: "sqlite", schema })(options);

      return {
        ...adapter,
        update: (params: Parameters<typeof adapter.update>[0]) =>
          adapter.update(preserveScopeCeiling(params)),
        // The registration SDK enters a transaction even when the D1 adapter
        // implements it without a database transaction. Decorate that lane too.
        transaction: (callback: Parameters<typeof adapter.transaction>[0]) =>
          adapter.transaction((transaction) =>
            callback({
              ...transaction,
              update: (params) => transaction.update(preserveScopeCeiling(params)),
            }),
          ),
      };
    },
    // GitHub is enabled only when both id and secret resolve.
    // `mapProfileToUser` is the only hook that sees the raw GitHub profile, so
    // it records the login (`upsertGithubLogin`) and maps nothing onto `user`.
    socialProviders: github
      ? {
          github: {
            ...github,
            mapProfileToUser: async (profile: { id: number | string; login?: string }) => {
              if (typeof profile.login === "string" && profile.login) {
                await upsertGithubLogin(db, String(profile.id), profile.login);
              }
              return {};
            },
          },
        }
      : {},
    // A GitHub sign-in or Connect whose GitHub email is verified attaches to
    // an existing user with that email instead of minting a second, org-less
    // user. `allowDifferentEmails` covers a GitHub email that differs from the
    // magic-link address.
    //
    // Deliberately no `trustedProviders: ["github"]`: that bypasses the
    // provider-email-verified check, so an unverified GitHub email could take
    // over an account. GitHub's per-address `emailVerified` gates linking,
    // and `requireLocalEmailVerified` (default true) also requires the local
    // user's email to be verified.
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: [],
        allowDifferentEmails: true,
      },
    },
    plugins: [
      magicLink({
        expiresIn: 60 * 15,
        storeToken: "hashed",
        sendMagicLink: async ({ email, url }) => {
          await sendAuthEmail(env, { to: email, template: "magic-link", context: { url } });
        },
      }),
      // Global user.role gate for the admin UI and internal promote route.
      admin({
        defaultRole: "user",
        adminRoles: ["admin"],
        // Shown when a banned account tries to open a new session (magic link,
        // GitHub, device flow). Operators set bans from /admin/users.
        bannedUserMessage:
          "This account has been deactivated. Contact support if you believe this is a mistake.",
      }),
      // Orgs, membership, invitations. No teams.
      organization({
        membershipLimit: 100,
        // An org is a workspace's access list (org slug = workspace name).
        // Orgs are created only by /internal/orgs after apps/api's name,
        // ownership and cap checks, and deleted only through workspace
        // teardown, so the plugin's public create/delete endpoints stay off.
        // Slug changes are blocked in beforeUpdateOrganization.
        allowUserToCreateOrganization: false,
        disableOrganizationDeletion: true,
        sendInvitationEmail: async ({ id, email, organization: org, inviter }) => {
          const url = `${webOrigin}/accept-invitation/${id}`;
          await sendAuthEmail(env, {
            to: email,
            template: "invitation",
            context: {
              url,
              organizationName: org.name,
              inviterEmail: inviter.user.email,
            },
          });
        },
        organizationHooks: {
          // The slug is the workspace name (see above); display-name edits
          // are fine, re-pointing the org at another workspace name is not.
          beforeUpdateOrganization: async ({ organization: data, member }) => {
            if (typeof data.slug !== "string") return;
            const [current] = await db
              .select({ slug: schema.organization.slug })
              .from(schema.organization)
              .where(eq(schema.organization.id, member.organizationId))
              .limit(1);
            if (current && data.slug === current.slug) return;
            throw new APIError("BAD_REQUEST", {
              code: "ORGANIZATION_SLUG_IMMUTABLE",
              message: "an organization's slug is its workspace name and cannot be changed",
            });
          },
          // Revoke the member's tokens (member-tokens.ts). These endpoints
          // are public with a session, so the internal routes alone would
          // leave a bypass. A failure aborts the change.
          beforeRemoveMember: async ({ member, organization: org }) => {
            await revokeMemberWorkspaceTokens(env.DB, org.slug, member.userId);
          },
          beforeUpdateMemberRole: async ({ member, newRole, organization: org }) => {
            if (isWorkspaceManagerRole(newRole)) return;
            await revokeMemberWorkspaceGovernanceTokens(env.DB, org.slug, member.userId);
          },
          // Member cap. This endpoint is public with a session, so the cap
          // must be enforced here too. `inviter.role` is the global role:
          // site operators bypass, org owners/admins don't.
          beforeCreateInvitation: async ({ inviter, organization: org }) => {
            const denial = await memberCapDenial(env, db, {
              organizationId: org.id,
              organizationSlug: org.slug,
              inviterIsGlobalAdmin: (inviter as { role?: unknown }).role === "admin",
            });
            if (denial) {
              throw new APIError("FORBIDDEN", { code: denial.code, message: denial.message });
            }
          },
          // Inviter notify + first-membership welcome. sendAuthEmail never
          // throws so accept can't roll back on mail failure.
          afterAcceptInvitation: async ({ invitation, user, organization: org }) => {
            if (invitation.inviterId) {
              const [inviter] = await db
                .select({ email: schema.user.email })
                .from(schema.user)
                .where(eq(schema.user.id, invitation.inviterId))
                .limit(1);
              if (inviter?.email && inviter.email.toLowerCase() !== user.email.toLowerCase()) {
                await sendAuthEmail(env, {
                  to: inviter.email,
                  template: "member-joined",
                  context: { organizationName: org.name, memberEmail: user.email },
                });
              }
            }

            // The inviter already got `member-joined` above; don't double-send.
            await notifyAdminsOfMemberJoin(env, db, {
              organizationId: org.id,
              organizationName: org.name,
              organizationSlug: org.slug,
              joinerUserId: user.id,
              joinerEmail: user.email,
              excludeUserIds: invitation.inviterId ? [invitation.inviterId] : [],
            });

            // Welcome only on the invitee's first membership.
            if (!user.email) return;
            const memberships = await db
              .select({ id: schema.member.id })
              .from(schema.member)
              .where(eq(schema.member.userId, user.id))
              .limit(2);
            if (memberships.length !== 1) return;
            await sendAuthEmail(env, {
              to: user.email,
              template: "welcome",
              context: { workspaceName: org.name },
            });
          },
        },
      }),
      // Dormant unless both Stripe secrets resolve (src/stripe-plugin.ts).
      // After organization(): the org is the billing entity.
      ...stripePluginOrNone(env, db),
      // Signs OAuth access tokens as JWTs and serves JWKS. Must precede
      // oauthProvider(), which reads the jwt() config at registration.
      jwt(),
      // OAuth 2.1 authorization server for agents.uploads.sh/mcp.
      // loginPage/consentPage must be absolute URLs on the web origin, which
      // serves those pages. DCR is open (agents register before anyone logs
      // in); self-registered clients are forced to public PKCE with no
      // secret or skip_consent, and oauth-client-reaper.ts sweeps abandoned
      // ones.
      oauthProvider({
        loginPage: `${webOrigin}/login`,
        consentPage: `${webOrigin}/oauth/consent`,
        scopes: [...OAUTH_SCOPES, ...OAUTH_IDENTITY_SCOPES, OAUTH_OFFLINE_ACCESS_SCOPE],
        clientRegistrationDefaultScopes: [...OAUTH_CLIENT_REGISTRATION_DEFAULT_SCOPES],
        // Self-registered clients are persisted with defaultScopes ∪
        // allowedScopes, ignoring any declared `scope`, so files:delete must
        // be listed here to be requestable. Every grant still needs consent.
        // hooks.before downscopes unknown extras (profile, admin) instead.
        clientRegistrationAllowedScopes: [...OAUTH_CLIENT_REGISTRATION_ALLOWED_SCOPES],
        resources: oauthResources(),
        // Per-client enforcement would reject standard MCP clients, which
        // request `resource` at authorize time and are never linked to it.
        // Any client may target enabled resources; tokens stay aud-bound.
        enforcePerClientResources: false,
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        // Keep PKCE required for every DCR row. hooks.before still forces
        // token_endpoint_auth_method "none". A CIMD `private_key_jwt` row also
        // requires PKCE: its `require_pkce` is null, which reads as true for a
        // confidential client.
        clientRegistrationRequirePKCE: true,
        // CIMD `private_key_jwt` clients (Vercel Connect) sign assertions
        // with `aud` = the advertised token endpoint on AUTH_DIRECT_ORIGIN.
        ...clientAssertionAudienceOptions(env),
        // Refresh tokens rotate, and a second use of a just-rotated token
        // (a retried request, or several processes sharing one token) would
        // tear down the whole token family (RFC 9700 §4.14). Within this
        // window the plugin replays the rotation response instead. 60s is far
        // too short to matter for stolen-token replay.
        refreshTokenReuseInterval: 60,
        // Pinned abuse ceiling for the public /oauth2/register endpoint.
        rateLimit: { register: { window: 60, max: 5 } },
        // Lets a multi-workspace user scope a grant to a chosen workspace.
        // A changed choice re-triggers consent. Undefined for users with 0/1
        // memberships (src/workspace-choice.ts).
        postLogin: {
          // Never used (`shouldRedirect` is always false); required by the
          // plugin's types. The picker lives on /oauth/consent.
          page: `${webOrigin}/oauth/consent`,
          consentReferenceId: ({ user }) => resolveWorkspaceChoiceReferenceId(db, user?.id),
          shouldRedirect: () => false,
        },
        // A `ws:<slug>` referenceId the user still belongs to overrides the
        // oldest-membership default. Zero memberships still issue a token
        // (`workspace: null`); the MCP worker answers 403.
        customAccessTokenClaims: async ({ user, referenceId, scopes }) =>
          scopes.some((scope) => (OAUTH_SCOPES as readonly string[]).includes(scope))
            ? applyWorkspaceChoice(await resolveWorkspaceClaims(db, user?.id), referenceId)
            : {},
      }),
      // Client ID Metadata Documents: an HTTPS-URL `client_id` pointing at a
      // metadata document. DCR stays enabled alongside. Resolved clients are
      // ordinary oauth_client rows (`client_discovery_id = 'cimd'`), refreshed
      // on later resolutions and reaped like other anonymous rows.
      // sanitizeCimdMetadataDocument drops a jwks_uri off the client_id
      // origin to `none` on refresh; cimdClientRowFixups pins requirePKCE.
      cimd({
        fetchClientMetadataResource,
        metadataProfile: "mcp-2026-07-28",
        onClientCreated: fixCimdClientRow,
        onClientRefreshed: fixCimdClientRow,
      }),
      // Lets the CLI present the device-flow session token as a bearer, which
      // POST /v1/tokens uses to mint the workspace token. Required alongside
      // deviceAuthorization().
      bearer(),
      // RFC 8628 device flow for `uploads login`.
      //
      // verificationUri must be absolute on the web origin, which serves
      // /device; a relative value resolves under the auth baseURL and 404s.
      //
      // validateClient is fail-closed against oauth_client (registered,
      // enabled, device-code grant). Without it the plugin accepts any
      // client_id.
      deviceAuthorization({
        verificationUri: `${webOrigin}/device`,
        validateClient: (clientId) => isDeviceFlowClientAllowed(db, clientId),
      }),
      // POST /oauth2/workspace-choice: records which workspace an OAuth grant
      // operates on (read by postLogin.consentReferenceId).
      workspaceChoicePlugin(db),
      // GET/POST /device/workspace: the workspace a device login mints for.
      deviceWorkspacePlugin(db),
      // /oauth2/connected-apps (+ /revoke) for /account/connected-apps.
      // Revoking also marks the grant's token rows revoked, unlike the
      // plugin's delete-consent.
      connectedAppsPlugin(db),
      // Per-workspace weekly digest switches for Account → Profile.
      digestPreferencesPlugin(db),
      // Hosted dashboard (`@better-auth/infra`). Omit when the API key is unset.
      ...(dashApiKey ? [dash({ apiKey: dashApiKey })] : []),
      // Only with an exact, development-only loopback configuration.
      ...(localDemoEnabled(env) ? [localDemoPlugin(env)] : []),
    ],
    // Sticky "completed uploads login once" for account overview UX.
    user: {
      additionalFields: {
        cliOnboardedAt: { type: "date", required: false, input: false },
        notifyMemberJoin: {
          type: "boolean",
          required: false,
          input: true,
          defaultValue: true,
        },
        notifyUsageLimits: {
          type: "boolean",
          required: false,
          input: true,
          defaultValue: true,
        },
        notifySlackHolds: {
          type: "boolean",
          required: false,
          input: true,
          defaultValue: true,
        },
        notifyEmailHolds: {
          type: "boolean",
          required: false,
          input: true,
          defaultValue: false,
        },
        notifyProductUpdates: {
          type: "boolean",
          required: false,
          input: true,
          defaultValue: true,
        },
      },
    },
    session: {
      // /list-sessions needs a fresh session by default; only used for
      // account UX, so disable.
      freshAge: 0,
      // 15 min: each cache expiry is a D1 session read, and D1 can stall.
      // Revocation takes up to 15 min to reach cached readers, which is
      // acceptable here. Strategy stays "compact": the cookie is httpOnly and
      // switching would invalidate every cache at once.
      cookieCache: { enabled: true, maxAge: 15 * 60 },
      // CLI package version, set via POST /update-session (core userAgent is
      // frozen after create).
      additionalFields: {
        cliVersion: { type: "string", required: false },
      },
    },
    databaseHooks: {
      session: {
        create: {
          after: async (session, context) => {
            const userId = session?.userId;
            if (!userId) return;
            // Unticked "Email me product updates" on a sign-in page.
            if (hasProductUpdatesOptOut(context?.headers ?? context?.request?.headers)) {
              await db
                .update(schema.user)
                .set({ notifyProductUpdates: false, updatedAt: new Date() })
                .where(eq(schema.user.id, userId));
            }
            if (!isCliSessionUserAgent(session.userAgent)) return;
            await db
              .update(schema.user)
              .set({ cliOnboardedAt: new Date(), updatedAt: new Date() })
              .where(and(eq(schema.user.id, userId), isNull(schema.user.cliOnboardedAt)));
          },
        },
      },
      verification: {
        create: {
          before: async (data) => {
            const value = typeof data.value === "string" ? data.value : undefined;
            if (!value || !value.includes("authorization_code")) return;
            const allowedScopes = await registeredScopesForClientId(
              oauthClientIdFromAuthorizationCode(value),
            );
            const next = restrictAuthorizationCodeValue(value, allowedScopes);
            if (!next) return;
            return { data: { ...data, value: next } };
          },
        },
      },
    },
    // One `hooks.before` (Better Auth takes a single middleware): CIMD/DCR
    // grant_types, authorize/consent scope rewrite, then the last-admin guard.
    hooks: {
      before: authBeforeHook(db, registeredScopesForClientId),
      after: authAfterHook(env, db),
    },
    // On in production unless the explicit dev opt-out is set.
    //
    // D1 is kept out of the rate-limit path: a D1 stall once hung every
    // /api/auth/* request. /get-session is exempt entirely (customRules), and
    // the remaining endpoints use the per-colo Rate Limiting bindings
    // (src/rate-limit.ts). The wrapper fails open, since rate limiting is
    // abuse-shaping, not a security boundary.
    //
    // Without the bindings (tests, bare local envs) Better Auth's in-memory
    // Map is used.
    rateLimit: {
      enabled: isProduction && env.AUTH_RATE_LIMIT_DISABLED !== "true",
      ...rateLimitStorage(env),
      customRules: {
        // `false` skips the limiter (and its storage) for this path.
        // get-session is called over a trusted service binding on every
        // signed-in request; browser abuse belongs to the edge WAF.
        "/get-session": false,
        // Public, cacheable metadata. JWKS is fetched over the MCP worker's
        // service binding (no client IP), so limiting it only adds a DO
        // round trip to token verification.
        "/jwks": false,
        "/.well-known/*": false,
      },
    },
    trustedOrigins: (request) => {
      const origin = request?.headers.get("origin");
      if (!origin) return authTrustedOrigins(env);
      return isTrustedOrigin(origin, env) ? [origin] : [];
    },
    advanced: {
      // Related rows in one query; needs drizzle `relations()` in schema.ts.
      database: { joins: true },
      useSecureCookies: isProduction,
      ipAddress: {
        ipAddressHeaders: ["cf-connecting-ip", "x-forwarded-for"],
      },
      // The session cookie is host-only on the web origin; auth is always
      // served same-origin through web's `/api/auth` proxy.
      crossSubDomainCookies: { enabled: false },
    },
  });
}

/**
 * Must enumerate every env field that feeds `buildAuth`, or an isolate can
 * keep serving a stale config. Keep in lockstep with `AuthEnv`.
 */
function cacheKey(
  env: AuthEnv,
  signingSecret: string,
  github: { clientId: string; clientSecret: string } | null,
  dashApiKey: string | null,
): string {
  return JSON.stringify({
    betterAuthUrl: env.BETTER_AUTH_URL,
    webOrigin: env.WEB_ORIGIN,
    // Feeds oauthProvider's clientAssertionAudienceOrigins.
    authDirectOrigin: env.AUTH_DIRECT_ORIGIN,
    environment: env.ENVIRONMENT,
    trustedOriginsEnv: env.BETTER_AUTH_TRUSTED_ORIGINS,
    rateLimitDisabled: env.AUTH_RATE_LIMIT_DISABLED,
    localStack: env.LOCAL_STACK,
    stripeSecretKey: env.STRIPE_SECRET_KEY,
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,
    stripeProPriceId: env.STRIPE_PRO_PRICE_ID,
    signingSecret,
    githubClientId: github?.clientId ?? null,
    githubClientSecret: github?.clientSecret ?? null,
    dashApiKey,
    hasEmail: Boolean(env.EMAIL),
    // Presence flips the limiter between binding-backed customStorage and
    // Better Auth's memory fallback, so it has to be part of the key.
    hasRateLimiters: Boolean(rateLimitTiers(env)),
  });
}

let cachedKey: string | undefined;
let cachedInstance: BetterAuthInstance | undefined;
// A cacheKey match can still hide a different DB/EMAIL binding object (e.g.
// `wrangler dev -c`), so compare binding identity too.
let cachedDB: D1Database | undefined;
let cachedEmail: AuthEnv["EMAIL"] | undefined;

// Secrets Store `.get()` is I/O, so resolved values are memoized per isolate.
// Only successes are cached, so a transient failure is retried next call.
let cachedSigningSecret: string | undefined;
let cachedGithub: { clientId: string; clientSecret: string } | null | undefined;
let cachedDashApiKey: string | null | undefined;

/**
 * Build or reuse the instance. Returns null when the signing secret is
 * unresolvable; callers must answer 503 rather than use an ephemeral secret.
 */
export async function createAuth(env: AuthEnv): Promise<BetterAuthInstance | null> {
  if (cachedSigningSecret === undefined) {
    const resolved = await resolveSigningSecret(env);
    if (resolved) cachedSigningSecret = resolved;
  }
  const signingSecret = cachedSigningSecret;
  if (!signingSecret) return null;

  if (cachedGithub === undefined) {
    cachedGithub = await resolveGitHubCredentials(env);
  }
  if (cachedDashApiKey === undefined) {
    cachedDashApiKey = await resolveDashApiKey(env);
  }
  const github = cachedGithub;
  const dashApiKey = cachedDashApiKey;

  const key = cacheKey(env, signingSecret, github, dashApiKey);

  if (cachedInstance && cachedKey === key && cachedDB === env.DB && cachedEmail === env.EMAIL) {
    return cachedInstance;
  }

  cachedInstance = buildAuth(env, signingSecret, github, dashApiKey);
  cachedKey = key;
  cachedDB = env.DB;
  cachedEmail = env.EMAIL;
  return cachedInstance;
}
