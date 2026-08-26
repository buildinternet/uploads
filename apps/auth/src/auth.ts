/**
 * Better Auth instance factory (see plan D1/D3). `createAuth(env)` builds a
 * fresh `betterAuth()` config and is memoized per isolate, keyed on every
 * auth-relevant env field so a config change (e.g. GitHub creds resolving
 * after a redeploy, or a different D1 binding under `wrangler dev -c`) never
 * serves a stale instance.
 */
import { cimd } from "@better-auth/cimd";
import { dash } from "@better-auth/infra";
import { oauthProvider } from "@better-auth/oauth-provider";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
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
import { fetchClientMetadataResource, rewriteClientMetadataGrantTypes } from "./cimd-transport";
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
import { createDurableRateLimitStorage, type RateLimitNamespaceLike } from "./rate-limit";
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
 * RFC 8628 device-flow client gate (issue #251). The CLI's client id
 * (`uploads-cli`, seeded by migration 20260719000000 as a managed official
 * oauth_client row) is no longer a string allowlist: any registered, enabled
 * client whose grant_types include the device-code grant may start a device
 * flow. Fail-closed — a missing row, a disabled toggle (admin panel
 * /admin/oauth), or an absent grant type all reject. Exported for direct unit
 * testing (device.test.ts).
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
 * OAuth 2.1 authorization server scopes (issue #224, Lane A). Duplicated
 * literally rather than imported from `@uploads/api` — this worker has no
 * dependency on that package. Keep in lockstep with `FILE_SCOPES` in
 * `apps/api/src/auth-db.ts`.
 */
export const OAUTH_SCOPES = ["files:read", "files:write", "files:delete"] as const;

/** Default scopes granted to a dynamically registered client that requests none. */
const OAUTH_CLIENT_REGISTRATION_DEFAULT_SCOPES = ["files:read", "files:write"] as const;

/**
 * Extra scopes a CIMD/DCR client may request (consent still required). Better
 * Auth 1.7 persists self-registered clients as default ∪ allowed.
 */
const OAUTH_CLIENT_REGISTRATION_ALLOWED_SCOPES = ["files:delete"] as const;

/**
 * Fallback when the oauth_client row is missing (CIMD first-use: persist
 * can run after hooks.before). Matches what Better Auth writes on the row.
 * Do not expand this to a future elevated scope that should stay off CIMD.
 */
const OAUTH_SELF_REGISTERED_SCOPES = [
  ...OAUTH_CLIENT_REGISTRATION_DEFAULT_SCOPES,
  ...OAUTH_CLIENT_REGISTRATION_ALLOWED_SCOPES,
] as const;

/**
 * Canonical MCP resource identifiers (`origin/mcp`). RFC 9728 metadata on
 * the MCP worker advertises this form; generic clients often copy the
 * origin instead. {@link oauthResources} adds both. Mirrored into
 * apps/mcp's JWT verification config (`OAUTH_AUDIENCES`) — keep both in
 * lockstep.
 */
const MCP_RESOURCE_IDENTIFIERS = [
  "https://agents.uploads.sh/mcp",
  "https://mcp.uploads.sh/mcp",
] as const;

/**
 * `/mcp` identifier plus its RFC 9728 origin form. Non-`/mcp` URLs stay
 * unchanged. Generic clients (MCPJam) copy the origin into authorize
 * `resource=`; the MCP worker already needs to accept both as JWT `aud`.
 */
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
 * Protected resources this AS issues access tokens for (Better Auth 1.7's
 * first-class `resources` model, which replaced the 1.6 `validAudiences`
 * list). Each identifier becomes an `oauth_resource` row (seeded at boot,
 * `resourceSeedMode: "insertOnly"`) and is the RFC 8707 `resource` value a
 * client requests; the minted token's `aud` is bound to it.
 */
export function oauthResources(): string[] {
  return [...new Set(MCP_RESOURCE_IDENTIFIERS.flatMap(mcpResourceAndOrigin))];
}

/**
 * Workspace claims embedded in every OAuth access-token JWT
 * (`customAccessTokenClaims` below): the oldest org membership's slug as the
 * primary `workspace`, plus every slug the user belongs to. Queries the same
 * D1 the rest of this worker uses (member ⋈ organization). Defensive:
 * missing user or zero memberships still returns a shape MCP can consume
 * (`workspace: null`) rather than throwing — a token must always issue.
 *
 * Exported for direct unit testing (see auth.test.ts) since driving the full
 * authorize→consent→token flow through the plugin is comparatively heavy.
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

/**
 * Global `user.role` value granted by the `admin()` plugin's `adminRoles`
 * option below. Kept as a literal (not read back from plugin options) since
 * the plugin config is fixed at a single role and this helper needs it before
 * `buildAuth` runs.
 */
const ADMIN_ROLE = "admin";

/**
 * Audit guard (accidental-deletion class, see ad736b9's official-client
 * guard): the stock `admin()` plugin's `/admin/remove-user` and
 * `/admin/ban-user` REST endpoints already refuse self-targeting (better-auth
 * 1.6.23's own `YOU_CANNOT_REMOVE_YOURSELF`/`YOU_CANNOT_BAN_YOURSELF` checks),
 * but have no protection against removing/banning the LAST remaining admin —
 * doing so locks every operator out of the admin UI with no recovery path
 * short of a direct DB edit. `user.role` can hold a comma-separated role list
 * (mirrors the plugin's own `role.split(",")` parsing in its `setRole`
 * route), so this checks for the admin token anywhere in that list.
 *
 * Exported for direct unit testing — driving the plugin's endpoints
 * end-to-end through the fake-D1 harness is comparatively heavy (see
 * auth.test.ts).
 */
export function hasAdminRole(role: string | null | undefined): boolean {
  if (!role) return false;
  return role
    .split(",")
    .map((r) => r.trim())
    .includes(ADMIN_ROLE);
}

/**
 * Same admin-role check as `hasAdminRole`, but for the raw `role` value the
 * admin() plugin's `/admin/set-role` and `/admin/update-user` request bodies
 * accept — a single string OR an array of strings (see better-auth 1.6.23's
 * `setRoleBodySchema`/`adminUpdateUserBodySchema` in
 * `plugins/admin/routes.mjs`, which itself normalizes via `Array.isArray(...)
 * ? roles.join(",") : roles`).
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
  // Fetch-and-filter in JS rather than a `LIKE`/split in SQL: the role column
  // is a free-form comma-separated string (see hasAdminRole above), and the
  // admin user population is small enough that this isn't a real query cost.
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
    const next = body ? rewriteClientMetadataGrantTypes(body) : undefined;
    if (next) return { context: { body: next } };
    return;
  }
  if (ctx.path === "/oauth2/authorize") {
    const query = ctx.query;
    const allowedScopes = await registeredScopesForClientId(oauthClientIdFromQuery(query));
    const nextQuery = restrictOAuthQueryScopes(query, allowedScopes);
    if (nextQuery) return { context: { query: nextQuery } };
    return;
  }
  if (ctx.path === "/oauth2/consent") {
    const body = ctx.body as Record<string, unknown> | undefined;
    const allowedScopes = await registeredScopesForClientId(oauthClientIdFromConsentBody(body));
    const nextBody = restrictOAuthConsentBody(body, allowedScopes);
    if (nextBody) return { context: { body: nextBody } };
  }
}

function authBeforeHook(
  db: ReturnType<typeof drizzle<typeof schema>>,
  registeredScopesForClientId: (clientId: string | undefined) => Promise<readonly string[]>,
) {
  return createAuthMiddleware(async (ctx) => {
    const oauthOverride = await applyOAuthClientInterop(ctx, registeredScopesForClientId);
    if (oauthOverride) return oauthOverride;
    await enforceLastAdminGuard(ctx, db);
  });
}

/**
 * Last-admin check for the `admin()` plugin's remove-user/ban-user/
 * set-role/update-user endpoints (fail-closed, see `countActiveAdmins`
 * above). Called from `authBeforeHook` after the OAuth interop rewrite.
 * No-ops for any path other than the ones it guards.
 *
 * - `/admin/remove-user`, `/admin/ban-user`: self-removal and self-ban are
 *   already rejected by the plugin itself; this only adds the last-admin
 *   check.
 * - `/admin/set-role` (body `{ userId, role }`) and `/admin/update-user`
 *   (body `{ userId, data }`, where `data` may carry `role` and/or `banned`)
 *   have NO built-in last-admin protection at all — `update-user`'s only
 *   built-in guard blocks self-ban, and neither route stops a caller
 *   (including the target themselves) from stripping the last admin's role
 *   or banning them via `data.banned`. Verified against better-auth 1.6.23's
 *   `plugins/admin/routes.mjs` (`setRole`, `adminUpdateUser`).
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
    // A banned target doesn't count toward `countActiveAdmins`, so it
    // can't be "the last admin" being demoted — and if the incoming role
    // still includes admin, nothing about admin-ness is changing.
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
  DashApiKeyEnv & {
    DB: D1Database;
    EMAIL?: import("./email").EmailBinding;
    BETTER_AUTH_URL?: string;
    BETTER_AUTH_SECRET?: string;
    WEB_ORIGIN?: string;
    /** The auth worker's own direct origin (e.g. https://auth.uploads.sh),
     * used to advertise the OAuth form-POST endpoints off the same-origin
     * `/api` proxy so Astro's checkOrigin can't 403 them (see #749, and the
     * discovery-metadata rewrite in src/index.ts). Unset in dev/preview. */
    AUTH_DIRECT_ORIGIN?: string;
    ENVIRONMENT?: string;
    BETTER_AUTH_TRUSTED_ORIGINS?: string;
    AUTH_RATE_LIMIT_DISABLED?: string;
    /**
     * Durable Object namespace backing Better Auth's rate limiter (see the
     * `rateLimit` block below and src/rate-limit-do.ts). Optional: tests and
     * bare local envs construct auth without it and fall back to Better
     * Auth's in-process memory storage.
     */
    RATE_LIMIT?: RateLimitNamespaceLike;
    /** Ephemeral flag passed only by `pnpm dev:stack`; never configure in prod. */
    LOCAL_STACK?: string;
    /** Stripe phase 2 (task 5): gates stripePluginOrNone (src/stripe-plugin.ts)
     * and feeds this file's memoization key so a rotated secret or a newly
     * configured price id doesn't keep serving a stale (unmounted/mounted)
     * instance. See env.d.ts for the ambient Env declarations these mirror. */
    STRIPE_SECRET_KEY?: string;
    STRIPE_WEBHOOK_SECRET?: string;
    STRIPE_PRO_PRICE_ID?: string;
  };

export type BetterAuthInstance = ReturnType<typeof buildAuth>;

/**
 * Pick the Better Auth rate-limit storage for this env: the Durable-Object
 * customStorage when RATE_LIMIT is bound, Better Auth's in-process memory Map
 * otherwise (unit tests, bare local envs). See the long comment on the
 * `rateLimit` block in buildAuth for why D1 is no longer an option.
 *
 * Both branches return the same (partially-optional) shape so the resulting
 * `auth.options.rateLimit` isn't a discriminated union that callers — and
 * tests — have to narrow.
 */
function rateLimitStorage(env: AuthEnv): {
  customStorage?: ReturnType<typeof createDurableRateLimitStorage>;
  storage?: "memory";
} {
  if (env.RATE_LIMIT) return { customStorage: createDurableRateLimitStorage(env.RATE_LIMIT) };
  return { storage: "memory" };
}

/**
 * Issue #580: capture the GitHub login at OAuth-link time. Called from the
 * github social provider's `mapProfileToUser` (below) — the only point in
 * Better Auth's OAuth flow that sees the raw GitHub profile (`login`), and
 * one that runs on every completed callback (first link AND every
 * re-authentication of an already-linked account), not just account
 * creation. See src/schema.ts's `githubIdentity` doc comment for why this
 * lands in a companion table keyed by the numeric GitHub account id rather
 * than a column on `account` itself. Last-write-wins by design (a GitHub
 * rename should overwrite the stored login); never throws — a failure here
 * must not block sign-in.
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
    console.error(
      JSON.stringify({
        message: "github login capture failed",
        githubAccountId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

function buildAuth(
  env: AuthEnv,
  signingSecret: string,
  github: { clientId: string; clientSecret: string } | null,
  dashApiKey: string | null,
) {
  const db = drizzle(env.DB, { schema });
  const betterAuthUrl = env.BETTER_AUTH_URL || "https://auth.uploads.sh";
  const webOrigin = env.WEB_ORIGIN || "https://uploads.sh";
  const isProduction = env.ENVIRONMENT === "production";
  /**
   * Registered `oauth_client.scopes`, or {@link OAUTH_SELF_REGISTERED_SCOPES}
   * when the row is missing (CIMD first-use: persist can run after this
   * hook). Never the empty list: authorize still has to downscope extras
   * such as `openid` on the first request.
   */
  const registeredScopesForClientId = async (
    clientId: string | undefined,
  ): Promise<readonly string[]> => {
    if (!clientId) return OAUTH_SELF_REGISTERED_SCOPES;
    try {
      const rows = await db
        .select({ scopes: schema.oauthClient.scopes })
        .from(schema.oauthClient)
        .where(eq(schema.oauthClient.clientId, clientId))
        .limit(1);
      return Array.isArray(rows[0]?.scopes) ? rows[0].scopes : OAUTH_SELF_REGISTERED_SCOPES;
    } catch {
      return OAUTH_SELF_REGISTERED_SCOPES;
    }
  };

  return betterAuth({
    appName: "uploads.sh",
    baseURL: betterAuthUrl,
    basePath: "/api/auth",
    secret: signingSecret,
    // `schema` (the whole module) is passed through as before — the adapter
    // discovers tables by matching each export's camelCase name to the
    // plugin's model name, so adding `jwks`/`oauthClient`/`oauthAccessToken`/
    // `oauthRefreshToken`/`oauthConsent` exports to schema.ts (issue #224,
    // Lane A) is sufficient; no explicit map needed here.
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema,
    }),
    // D3: gate GitHub on both id+secret resolving; adding a provider later is
    // just another resolved secret pair, no code change here.
    //
    // Issue #580: `mapProfileToUser` is intended for mapping the raw provider
    // profile onto `user.additionalFields`, but it's also the only Better
    // Auth hook that sees the raw GitHub profile (`profile.login`) — so it
    // doubles as the write path for `upsertGithubLogin` above, keyed off
    // `profile.id` (the numeric GitHub account id). It returns `{}`: no
    // fields are actually mapped onto `user`, since the login lives in
    // `githubIdentity` instead.
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
    // Magic-link first, then Connect GitHub on /account/profile (link-social).
    // Issue #233: a GitHub sign-in (or explicit /account/profile "Connect")
    // whose GitHub-reported email is verified attaches to an existing user
    // with that email — including one that only ever signed in via magic
    // link — instead of silently minting a second, org-less user. Completing
    // a magic-link sign-in is itself proof of email ownership (see
    // magicLink's `emailVerified: true` on verify), so that side needs no
    // extra flag here.
    //
    // `enabled: true` is the default; stated explicitly since this policy is
    // the point of the config. `allowDifferentEmails: true` covers the
    // common case where the GitHub email differs from the magic-link
    // address (both the implicit sign-in link and the explicit
    // /account/profile "Connect" flow go through the same check).
    //
    // Deliberately NOT setting `trustedProviders: ["github"]`: verified
    // against better-auth 1.6.23's actual implementation
    // (oauth2/link-account.mjs `handleOAuthUserInfo` and
    // api/routes/account.mjs `linkSocialAccount`), `trustedProviders`
    // bypasses the provider-email-verified check entirely — an
    // unverified-GitHub-email sign-in would still auto-link if github were
    // listed there. That's exactly the account-takeover vector the issue
    // calls out, so github is left off this list; the real (unverified vs.
    // verified) `emailVerified` flag GitHub returns per-address is what
    // gates linking instead. `requireLocalEmailVerified` (default true)
    // additionally requires the existing local user's email is already
    // verified before an implicit sign-in can attach to it.
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
      // D3/D9: global user.role gate for the admin UI + internal promote route.
      // No org-scoped access-control roles configured — that's the separate
      // `organization` plugin's `member.role`, out of scope until Phase 3.
      admin({
        defaultRole: "user",
        adminRoles: ["admin"],
        // Shown when a banned account tries to open a new session (magic link,
        // GitHub, device flow). Operators set bans from /admin/users.
        bannedUserMessage:
          "This account has been deactivated. Contact support if you believe this is a mistake.",
      }),
      // D3/D4 (Phase 3): orgs, membership, invitations. No `team` support.
      // No org auto-provisioning hook — workspaces (and their 1:1 orgs) are
      // admin-provisioned only, via /internal/orgs or the backfill script;
      // do NOT add a `organizationCreation`/session hook here (see D4).
      organization({
        membershipLimit: 100,
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
          // Member cap (issue #450). This endpoint —
          // POST /api/auth/organization/invite-member — is publicly reachable
          // with a session cookie, so enforcing only on apps/api's invite
          // routes would leave the cap trivially bypassable. `inviter.role`
          // is the global (admin plugin) role, not the org role: site
          // operators bypass, org owners/admins don't.
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
      // Stripe phase 2 (task 5): dormant unless both STRIPE_SECRET_KEY and
      // STRIPE_WEBHOOK_SECRET resolve — see src/stripe-plugin.ts. Ordered
      // right after organization() since it depends on org membership for
      // authorizeReference and on the org as the billing entity.
      ...stripePluginOrNone(env, db),
      // Issue #224, Lane A: signs the OAuth provider's access tokens as JWTs
      // and serves JWKS at /api/auth/jwks. MUST precede oauthProvider() below
      // — the plugin looks up the jwt() config at registration time.
      jwt(),
      // Issue #224, Lane A: OAuth 2.1 authorization server for
      // agents.uploads.sh/mcp (see docs/superpowers/specs/2026-07-17-oauth-authorization-server-design.md).
      // loginPage/consentPage MUST be absolute URLs on the WEB origin — same
      // rule as deviceAuthorization's verificationUri above; the /login and
      // /oauth/consent pages are served by apps/web, not this worker.
      // DCR is on and unauthenticated (agent/MCP clients self-register before
      // any user has logged in); the stale-client reaper (oauth-client-reaper.ts)
      // sweeps abandoned anonymous registrations from the cron below.
      oauthProvider({
        loginPage: `${webOrigin}/login`,
        consentPage: `${webOrigin}/oauth/consent`,
        scopes: [...OAUTH_SCOPES],
        clientRegistrationDefaultScopes: [...OAUTH_CLIENT_REGISTRATION_DEFAULT_SCOPES],
        // Better Auth 1.7 persists every self-registered client (DCR and
        // CIMD alike) with scope = defaultScopes ∪ allowedScopes, DISCARDING
        // any `scope` the registration or metadata document declares — so
        // without this line the defaults above are a hard cap and no
        // self-registered client can ever request files:delete (authorize
        // 400s with invalid_scope; found by the #556 MCP Inspector run,
        // which requests every scope the resource advertises). Listing
        // files:delete here lets self-registered clients REQUEST it; every
        // grant still goes through the user's consent screen, and device-flow
        // workspace tokens already get files:delete by default.
        // Generic clients also copy extras (openid, admin) that are not in
        // this product's scope list; hooks.before downscopes those rather
        // than expanding this allowlist further.
        clientRegistrationAllowedScopes: [...OAUTH_CLIENT_REGISTRATION_ALLOWED_SCOPES],
        // Better Auth 1.7: `validAudiences` → the persisted `resources` model.
        // String form (plugin-level defaults) preserves the 1.6 accepted-audience
        // behavior; `resourceSeedMode` defaults to the safe "insertOnly".
        // (`silenceWarnings` was removed in 1.7 — the well-known warnings it
        // suppressed are gone; root /.well-known aliases are still served by
        // src/index.ts.)
        resources: oauthResources(),
        // `enforcePerClientResources` defaults to `true` in 1.7 (RFC 8707 §3):
        // /oauth2/authorize + /oauth2/token then require the client to be linked
        // to every requested resource via `oauth_client_resource`, else they
        // return `invalid_target`. Standard MCP clients request `resource` at
        // authorize/token time (not as a DCR field), so they never get linked
        // and would be rejected. We have no mechanism to link third-party
        // clients, and in 1.6 (`validAudiences`) any client could target these
        // audiences. `false` restores that — all *enabled* resources are
        // requestable by any client — while tokens stay aud-bound to the
        // requested resource. (Per-client enforcement would need an admin flow
        // to link clients to resources, which we don't have.)
        enforcePerClientResources: false,
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        // Explicit abuse ceiling on the public /oauth2/register endpoint —
        // pinned here rather than the plugin's library default so it's
        // auditable and can't silently drift. Enforced only when Better
        // Auth's core rate limiter is on (see rateLimit below).
        rateLimit: { register: { window: 60, max: 5 } },
        // Issue #231 (auth side): lets a multi-workspace user's consent (and
        // the resulting tokens) be scoped to a specific workspace instead of
        // always the oldest membership. The plugin recomputes this at
        // authorize-time and filters its `oauth_consent` lookup by the
        // returned string — a changed choice naturally re-triggers consent.
        // `undefined` for 0/1-membership users preserves today's
        // null-referenceId behavior (see src/workspace-choice.ts).
        postLogin: {
          // Never used: `shouldRedirect` below always returns false, so
          // `/oauth2/authorize` never redirects here. The workspace picker
          // itself lives on /oauth/consent (issue #231's web-side half);
          // this is just the required sibling field the plugin's types
          // demand alongside `consentReferenceId`.
          page: `${webOrigin}/oauth/consent`,
          consentReferenceId: ({ user }) => resolveWorkspaceChoiceReferenceId(db, user?.id),
          shouldRedirect: () => false,
        },
        // member ⋈ organization, oldest membership wins for `workspace`; all
        // slugs ride along in `workspaces`. Issue #231 (auth side): when
        // `referenceId` is one of ours (`ws:<slug>`, see
        // postLogin.consentReferenceId above) and `<slug>` is still one of
        // the user's workspaces, it overrides the oldest-membership default
        // — the user's per-grant choice wins. Zero memberships still issues
        // a token (workspace: null) — the MCP worker is responsible for the
        // 403.
        customAccessTokenClaims: async ({ user, referenceId }) =>
          applyWorkspaceChoice(await resolveWorkspaceClaims(db, user?.id), referenceId),
      }),
      // Issue #556: Client ID Metadata Documents (CIMD). MCP spec 2026-07-28
      // deprecates DCR in favour of an HTTPS-URL `client_id` that points at a
      // metadata document; this plugin contributes that discovery to the
      // oauthProvider() above (order is irrelevant — it registers via
      // `extendOAuthProvider` at init) and advertises
      // `client_id_metadata_document_supported: true` in the AS metadata.
      // DCR stays enabled alongside for backward compatibility. Discovery-
      // resolved clients are persisted as ordinary oauth_client rows tagged
      // `client_discovery_id = 'cimd'` and are refreshed from their metadata
      // URL on later resolutions, so the stale-client reaper may sweep them
      // like any other anonymous row (see oauth-client-reaper.ts).
      // The MCP profile pins the draft-00 requirements that spec revision
      // mandates (client_name + redirect_uris required).
      cimd({
        fetchClientMetadataResource,
        metadataProfile: "mcp-2026-07-28",
      }),
      // D5/Phase 4: bearer() lets the CLI present the device-flow session token
      // as `Authorization: Bearer <token>` so apps/api's session verification
      // (GET /api/auth/get-session over the AUTH binding) honors it instead of
      // only the cookie. It MUST ride alongside deviceAuthorization(): the
      // device/token endpoint returns that session token, and POST /v1/tokens
      // then presents it as a bearer to mint the workspace token.
      bearer(),
      // D5/Phase 4: RFC 8628 device flow for `uploads login`.
      //
      // verificationUri MUST be an ABSOLUTE URL on the WEB origin — the /device
      // approval page is served by apps/web (uploads.sh), and since #731 auth
      // is reached same-origin through web's `/api/auth` proxy. The plugin only
      // prefixes baseURL when the value is relative, so a bare "/device" would
      // resolve under the auth baseURL and 404. The session cookie is host-only
      // on the web origin (crossSubDomainCookies disabled below); the /device
      // page and the auth endpoints share that one origin, so it rides along.
      //
      // validateClient is fail-closed against the oauth_client table: the id
      // must be registered, enabled, and carry the device-code grant type
      // (issue #251 — the CLI's `uploads-cli` id is a seeded managed row, so
      // the admin panel's disable toggle now actually gates the device flow).
      // Without validateClient the plugin accepts ANY client_id.
      //
      // No `schema: {}` workaround needed: better-auth 1.6.23 declares the
      // plugin's `schema` option as `.optional()`, which zod 4.4.3 accepts when
      // omitted (verified — the releases repo's workaround targeted an older
      // build whose `schema` field lacked `.optional()`).
      deviceAuthorization({
        verificationUri: `${webOrigin}/device`,
        validateClient: (clientId) => isDeviceFlowClientAllowed(db, clientId),
      }),
      // Issue #231 (auth side): POST /oauth2/workspace-choice, letting a
      // signed-in multi-workspace user record which workspace an OAuth grant
      // should operate on (read back by postLogin.consentReferenceId above).
      workspaceChoicePlugin(db),
      // Issue #362: GET/POST /device/workspace, letting the /device approval
      // page resolve and rewrite the workspace a device login mints for
      // before it approves.
      deviceWorkspacePlugin(db),
      // Hosted dashboard (`@better-auth/infra`). Omit when the API key is unset.
      ...(dashApiKey ? [dash({ apiKey: dashApiKey })] : []),
      // This endpoint is omitted entirely unless the lifecycle runner supplies
      // an exact, development-only loopback configuration. It still creates a
      // standard Better Auth cookie and leaves membership checks to apps/api.
      ...(localDemoEnabled(env) ? [localDemoPlugin(env)] : []),
    ],
    // Sticky "completed uploads login once" for account overview UX.
    user: {
      additionalFields: {
        cliOnboardedAt: { type: "date", required: false, input: false },
      },
    },
    session: {
      // /list-sessions uses freshSessionMiddleware (default 24h → SESSION_NOT_FRESH).
      // We only use it for account UX, not high-sensitivity actions — disable.
      freshAge: 0,
      // 15 min (was 5): during the 2026-08-23 D1 stall incident, every
      // cookie-cache expiry forced a D1 session read that could land in a
      // stall window and surface as a fast "auth unavailable" 503. A longer
      // cache means signed-in users touch D1 a third as often, at the cost
      // of session revocation (sign-out elsewhere, ban) taking up to 15 min
      // to propagate to cached readers — acceptable for this product's
      // threat model; high-sensitivity actions re-verify server-side.
      cookieCache: { enabled: true, maxAge: 15 * 60 },
      // CLI package version — set/refreshed via POST /update-session (not core
      // userAgent, which Better Auth freezes after create). See account Sessions.
      additionalFields: {
        cliVersion: { type: "string", required: false },
      },
    },
    databaseHooks: {
      session: {
        create: {
          after: async (session) => {
            const userId = session?.userId;
            if (!userId || !isCliSessionUserAgent(session.userAgent)) return;
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
    // CIMD/DCR grant_types + authorize/consent scope rewrite, then the
    // fail-closed last-admin guard. One `hooks.before`: Better Auth takes a
    // single middleware here.
    hooks: {
      before: authBeforeHook(db, registeredScopesForClientId),
    },
    // Fail-closed in production, decoupled from secret resolution (D3/D7):
    // rate limiting is on whenever ENVIRONMENT === "production", regardless
    // of whether GitHub/signing secrets happen to be configured, unless the
    // explicit dev opt-out is set.
    //
    // Storage (2026-08-23, post-incident): Cloudflare D1 stalled 5-25s in
    // production, and every /api/auth/* request — including get-session,
    // which the api worker calls over the service binding on every signed-in
    // request — paid a rate-limit read+write against D1 before the handler
    // even ran, so the D1 stall hung the whole site. D1 is now out of the
    // rate-limit path entirely (the `rate_limit` table is retained unused; see
    // schema.ts).
    //
    // Two changes came out of that. First, /get-session is exempt from the
    // limiter altogether (see customRules below), so the hottest path has no
    // rate-limit storage dependency of any kind. Second, what remains — the
    // mutation-ish, low-frequency endpoints (sign-in, sign-up, magic-link,
    // change-password, …) — is backed by Durable Objects: one
    // `RateLimitCounter` object per rate-limit key (src/rate-limit-do.ts,
    // bound as RATE_LIMIT). `idFromName(key)` is deterministic, so the whole
    // fleet shares ONE exact fixed-window counter per key instead of the
    // per-isolate approximation a memory Map gives — which is precisely what
    // you want on the endpoints where the limit is load-bearing. The DO is
    // single-threaded, so its read-decide-write needs no locking; the decision
    // itself mirrors Better Auth's own `decideConsume` (src/rate-limit.ts).
    // With /get-session out of the picture, a DO round trip on a sign-in
    // attempt is a rounding error against the password/OAuth work that
    // follows it.
    //
    // Two properties keep this from ever repeating the incident anyway: the
    // wrapper is FAIL-OPEN (any throw → allowed) and TIME-BOUNDED (the DO call
    // is raced against a ~1.5s timer → allowed), so no storage dependency can
    // stall a request. Rate limiting is abuse-shaping, not a security
    // boundary; taking the site down to enforce it is the wrong trade.
    //
    // When the binding is absent (unit tests, bare local envs) we fall back to
    // Better Auth's in-process memory Map. Alternatives rejected: KV (1
    // write/sec/key is too coarse for a shared counter) and D1 (the incident).
    rateLimit: {
      enabled: isProduction && env.AUTH_RATE_LIMIT_DISABLED !== "true",
      ...rateLimitStorage(env),
      customRules: {
        // `false` disables the limiter for this path outright — Better Auth
        // 1.7.1 honors it in resolveRateLimitConfig
        // (better-auth/dist/api/rate-limiter/index.mjs:274, `if (resolved ===
        // false) return null`), which makes onRequestRateLimit return before
        // it ever touches storage.
        //
        // get-session is a cheap read the api worker's sessionAuth middleware
        // calls over a TRUSTED service binding on every signed-in request. Its
        // old 600/min budget was really defending us against our own client
        // fan-out bugs (fixed in #797), and on the single hottest path in the
        // product any shared-store dependency costs more than the limit is
        // worth. Browser-originated abuse of /api/auth/* belongs to the WAF at
        // the edge (a per-IP rate-limiting rule), not to the app.
        "/get-session": false,
      },
    },
    trustedOrigins: (request) => {
      const origin = request?.headers.get("origin");
      if (!origin) return authTrustedOrigins(env);
      return isTrustedOrigin(origin, env) ? [origin] : [];
    },
    advanced: {
      // Better Auth 1.7 promoted database joins out of `experimental` into the
      // stable `advanced.database.joins`. Fetches related rows in one query
      // (session→user, org→members, …); requires drizzle `relations()` on the
      // schema object — see schema.ts.
      database: { joins: true },
      useSecureCookies: isProduction,
      ipAddress: {
        ipAddressHeaders: ["cf-connecting-ip", "x-forwarded-for"],
      },
      // #731: the session cookie is host-only on the web origin (uploads.sh)
      // in every environment — auth is always served same-origin through web's
      // `/api/auth` proxy, so it never needs a shared parent domain.
      crossSubDomainCookies: { enabled: false },
    },
  });
}

/**
 * ⚠ footgun (plan D1): this cache key must hand-enumerate EVERY env field
 * that feeds `buildAuth` (directly or via secret resolution) — anything
 * missed here means an isolate can keep serving a stale config (e.g. a
 * rotated GitHub secret, a changed WEB_ORIGIN) until it happens to be evicted.
 * Keep this in lockstep with `AuthEnv` above and with what `buildAuth` reads.
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
    // Presence flips the limiter between DO-backed customStorage and Better
    // Auth's memory fallback, so it has to be part of the key.
    hasRateLimitDO: Boolean(env.RATE_LIMIT),
  });
}

let cachedKey: string | undefined;
let cachedInstance: BetterAuthInstance | undefined;
// Identity of the bindings the cached instance was built with — a stringly
// equal cacheKey can still hide a *different* DB/EMAIL binding object (e.g.
// `wrangler dev -c` swapping which D1/email binding is wired up), which would
// otherwise serve stale binding references from the cached instance.
let cachedDB: D1Database | undefined;
let cachedEmail: AuthEnv["EMAIL"] | undefined;

// Secrets Store `.get()` is I/O on every request; secrets rotate rarely and
// an isolate restart naturally picks up changes, so memoize the *resolved*
// values per isolate instead of re-fetching on every createAuth() call. Only
// successful resolutions are cached — an unresolved/failed lookup is retried
// on the next call rather than getting stuck 503ing for the isolate's whole
// lifetime on a transient Secrets Store hiccup.
let cachedSigningSecret: string | undefined;
let cachedGithub: { clientId: string; clientSecret: string } | null | undefined;
let cachedDashApiKey: string | null | undefined;

/**
 * Build (or reuse) the Better Auth instance for this isolate. Returns null
 * when the signing secret is unresolvable — callers MUST answer 503 for
 * `/api/auth/*` in that case rather than falling back to an ephemeral secret
 * (see src/index.ts).
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
