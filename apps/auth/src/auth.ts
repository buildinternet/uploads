/**
 * Better Auth instance factory (see plan D1/D3). `createAuth(env)` builds a
 * fresh `betterAuth()` config and is memoized per isolate, keyed on every
 * auth-relevant env field so a config change (e.g. GitHub creds resolving
 * after a redeploy, or a different D1 binding under `wrangler dev -c`) never
 * serves a stale instance.
 */
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
import { deviceWorkspacePlugin } from "./device-workspace";
import { sendAuthEmail } from "./email";
import { localDemoEnabled, localDemoPlugin } from "./local-demo";
import * as schema from "./schema";
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
 * Resource servers that accept this AS's JWT access tokens (design doc:
 * "Accepted audiences"). Mirrored into apps/mcp's JWT verification config —
 * keep both in lockstep.
 */
const OAUTH_VALID_AUDIENCES = ["https://agents.uploads.sh/mcp", "https://mcp.uploads.sh/mcp"];

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

/**
 * `hooks.before` handler for the `admin()` plugin's remove-user/ban-user/
 * set-role/update-user endpoints (fail-closed guard, see `countActiveAdmins`
 * above). Runs on every request — it's the only per-request hook Better Auth
 * exposes at this level — so it no-ops for any path other than the ones it
 * guards.
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
function lastAdminGuardHook(db: ReturnType<typeof drizzle<typeof schema>>) {
  return createAuthMiddleware(async (ctx) => {
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
  });
}

export type AuthEnv = GitHubCredentialsEnv &
  DashApiKeyEnv & {
    DB: D1Database;
    EMAIL?: import("./email").EmailBinding;
    BETTER_AUTH_URL?: string;
    BETTER_AUTH_SECRET_DEV?: string;
    UPL_BETTER_AUTH_SECRET?: import("./secrets").SecretLike;
    WEB_ORIGIN?: string;
    ENVIRONMENT?: string;
    BETTER_AUTH_TRUSTED_ORIGINS?: string;
    AUTH_RATE_LIMIT_DISABLED?: string;
    /** Ephemeral flag passed only by `pnpm dev:stack`; never configure in prod. */
    LOCAL_STACK?: string;
  };

export type BetterAuthInstance = ReturnType<typeof buildAuth>;

/**
 * Derive the cookie domain for `advanced.crossSubDomainCookies` from
 * BETTER_AUTH_URL: `https://auth.uploads.sh` -> `.uploads.sh`, so a session
 * cookie set on the auth worker is visible on `uploads.sh` and
 * `api.uploads.sh` (D1's cross-subdomain requirement). Falls back to
 * `undefined` (cross-subdomain cookies disabled) for bare hosts/IPs/localhost
 * where there is no parent domain to share.
 *
 * A 2-label apex host (e.g. `uploads.sh`) shares the whole host instead of
 * stripping the first label — stripping would yield a bare public suffix
 * (`.sh`), which browsers reject as a cookie domain.
 */
export function deriveCookieDomain(betterAuthUrl: string | undefined): string | undefined {
  if (!betterAuthUrl) return undefined;
  let host: string;
  try {
    host = new URL(betterAuthUrl).hostname;
  } catch {
    return undefined;
  }
  if (host === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return undefined;
  }
  if (host.endsWith(".localhost")) {
    // Portless dev (see the `portless` skill): auth.uploads.localhost shares a
    // session cookie with uploads.localhost via the `.<name>.localhost` parent.
    // Always anchor on the last two labels so worktree-prefixed hosts
    // (fix-ui.auth.uploads.localhost) land on the same parent as the web app.
    // A bare `<name>.localhost` has no shareable parent — host-only cookie.
    const parts = host.split(".");
    return parts.length >= 3 ? "." + parts.slice(-2).join(".") : undefined;
  }
  const parts = host.split(".");
  // Real-TLD portless zone (see trusted-origins.ts): anchor on
  // `.uploads.local.buildinternet.dev` so worktree-prefixed hosts
  // (fix-ui.auth.uploads.local.buildinternet.dev) share the same parent as
  // the web app, mirroring the `.localhost` rule above.
  if (host.endsWith(".uploads.local.buildinternet.dev")) {
    return "." + parts.slice(-4).join(".");
  }
  if (parts.length < 2) return undefined;
  if (parts.length === 2) return "." + host;
  return "." + parts.slice(1).join(".");
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
  const cookieDomain = deriveCookieDomain(betterAuthUrl);
  const isProduction = env.ENVIRONMENT === "production";

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
    // Fetch related rows in one query (session→user, org→members, …). Requires
    // drizzle `relations()` on the schema object — see schema.ts.
    experimental: { joins: true },
    // D3: gate GitHub on both id+secret resolving; adding a provider later is
    // just another resolved secret pair, no code change here.
    socialProviders: github ? { github } : {},
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
          // Notify inviter; sendAuthEmail never throws so accept can't roll back.
          afterAcceptInvitation: async ({ invitation, user, organization: org }) => {
            if (!invitation.inviterId) return;
            const [inviter] = await db
              .select({ email: schema.user.email })
              .from(schema.user)
              .where(eq(schema.user.id, invitation.inviterId))
              .limit(1);
            if (!inviter?.email || inviter.email.toLowerCase() === user.email.toLowerCase()) return;
            await sendAuthEmail(env, {
              to: inviter.email,
              template: "member-joined",
              context: { organizationName: org.name, memberEmail: user.email },
            });
          },
        },
      }),
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
        validAudiences: OAUTH_VALID_AUDIENCES,
        // Root /.well-known aliases are served by src/index.ts.
        silenceWarnings: { oauthAuthServerConfig: true, openidConfig: true },
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
      // approval page is served by apps/web (uploads.sh), not this worker
      // (auth.uploads.sh). The plugin only prefixes baseURL when the value is
      // relative, so a bare "/device" would resolve to
      // https://auth.uploads.sh/device and 404. The session cookie is
      // `.uploads.sh`-scoped (crossSubDomainCookies below) so it rides across
      // the two subdomains.
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
      cookieCache: { enabled: true, maxAge: 5 * 60 },
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
    },
    // Fail-closed last-admin guard for the admin() plugin's remove-user/
    // ban-user endpoints — see lastAdminGuardHook above.
    hooks: {
      before: lastAdminGuardHook(db),
    },
    // Fail-closed in production, decoupled from secret resolution (D3/D7):
    // rate limiting is on whenever ENVIRONMENT === "production", regardless
    // of whether GitHub/signing secrets happen to be configured, unless the
    // explicit dev opt-out is set.
    rateLimit: {
      enabled: isProduction && env.AUTH_RATE_LIMIT_DISABLED !== "true",
      storage: "database",
    },
    trustedOrigins: (request) => {
      const origin = request?.headers.get("origin");
      if (!origin) return authTrustedOrigins(env);
      return isTrustedOrigin(origin, env) ? [origin] : [];
    },
    advanced: {
      useSecureCookies: isProduction,
      ipAddress: {
        ipAddressHeaders: ["cf-connecting-ip", "x-forwarded-for"],
      },
      crossSubDomainCookies: cookieDomain
        ? { enabled: true, domain: cookieDomain }
        : { enabled: false },
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
    signingSecret,
    githubClientId: github?.clientId ?? null,
    githubClientSecret: github?.clientSecret ?? null,
    dashApiKey,
    hasEmail: Boolean(env.EMAIL),
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
