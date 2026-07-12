/**
 * Better Auth instance factory (see plan D1/D3). `createAuth(env)` builds a
 * fresh `betterAuth()` config and is memoized per isolate, keyed on every
 * auth-relevant env field so a config change (e.g. GitHub creds resolving
 * after a redeploy, or a different D1 binding under `wrangler dev -c`) never
 * serves a stale instance.
 */
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { betterAuth } from "better-auth";
import { drizzle } from "drizzle-orm/d1";
import { magicLink } from "better-auth/plugins";
import { sendAuthEmail } from "./email";
import * as schema from "./schema";
import { authTrustedOrigins, isTrustedOrigin } from "./trusted-origins";
import {
  resolveGitHubCredentials,
  resolveSigningSecret,
  type GitHubCredentialsEnv,
} from "./secrets";

export type AuthEnv = GitHubCredentialsEnv & {
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
  return "." + parts.slice(1).join(".");
}

function buildAuth(
  env: AuthEnv,
  signingSecret: string,
  github: { clientId: string; clientSecret: string } | null,
) {
  const db = drizzle(env.DB, { schema });
  const betterAuthUrl = env.BETTER_AUTH_URL || "https://auth.uploads.sh";
  const cookieDomain = deriveCookieDomain(betterAuthUrl);
  const isProduction = env.ENVIRONMENT === "production";

  return betterAuth({
    baseURL: betterAuthUrl,
    basePath: "/api/auth",
    secret: signingSecret,
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema,
    }),
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
    hasEmail: Boolean(env.EMAIL),
  });
}

let cachedKey: string | undefined;
let cachedInstance: BetterAuthInstance | undefined;

/**
 * Build (or reuse) the Better Auth instance for this isolate. Returns null
 * when the signing secret is unresolvable — callers MUST answer 503 for
 * `/api/auth/*` in that case rather than falling back to an ephemeral secret
 * (see src/index.ts).
 */
export async function createAuth(env: AuthEnv): Promise<BetterAuthInstance | null> {
  const signingSecret = await resolveSigningSecret(env);
  if (!signingSecret) return null;

  const github = await resolveGitHubCredentials(env);
  const key = cacheKey(env, signingSecret, github);

  if (cachedInstance && cachedKey === key) return cachedInstance;

  cachedInstance = buildAuth(env, signingSecret, github);
  cachedKey = key;
  return cachedInstance;
}
