/**
 * Better Auth instance factory (see plan D1/D3). `createAuth(env)` builds a
 * fresh `betterAuth()` config and is memoized per isolate, keyed on every
 * auth-relevant env field so a config change (e.g. GitHub creds resolving
 * after a redeploy, or a different D1 binding under `wrangler dev -c`) never
 * serves a stale instance.
 */
import { dash } from "@better-auth/infra";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { betterAuth } from "better-auth";
import { drizzle } from "drizzle-orm/d1";
import { admin, bearer, deviceAuthorization, magicLink, organization } from "better-auth/plugins";
import { sendAuthEmail } from "./email";
import * as schema from "./schema";
import { authTrustedOrigins, isTrustedOrigin } from "./trusted-origins";
import {
  resolveDashApiKey,
  resolveGitHubCredentials,
  resolveSigningSecret,
  type DashApiKeyEnv,
  type GitHubCredentialsEnv,
} from "./secrets";

/**
 * Static OAuth client id for the CLI's device flow (plan D5/Phase 4). The
 * `deviceAuthorization` plugin accepts ANY `client_id` unless `validateClient`
 * is supplied, so this is the sole allowlisted id — the CLI
 * (`@buildinternet/uploads`) sends the same literal when starting a device
 * flow. The full `oauthProvider` plugin (dynamic third-party clients) is out
 * of scope for v1 (D3); when it lands, this stays the CLI's reserved id.
 */
export const UPLOADS_CLI_CLIENT_ID = "uploads-cli";

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
  if (host === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.endsWith(".localhost")) {
    return undefined;
  }
  const parts = host.split(".");
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
      // validateClient is a fail-closed allowlist: only the static CLI client
      // id may start a device flow or exchange a code. Without it the plugin
      // accepts ANY client_id — an unknown id could never obtain a token
      // (approval is interactive) but the allowlist is defense in depth.
      //
      // No `schema: {}` workaround needed: better-auth 1.6.23 declares the
      // plugin's `schema` option as `.optional()`, which zod 4.4.3 accepts when
      // omitted (verified — the releases repo's workaround targeted an older
      // build whose `schema` field lacked `.optional()`).
      deviceAuthorization({
        verificationUri: `${webOrigin}/device`,
        validateClient: (clientId) => clientId === UPLOADS_CLI_CLIENT_ID,
      }),
      // Hosted dashboard (`@better-auth/infra`). Omit when the API key is unset.
      ...(dashApiKey ? [dash({ apiKey: dashApiKey })] : []),
    ],
    session: {
      cookieCache: {
        enabled: true,
        maxAge: 5 * 60,
      },
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
