/**
 * Local-stack-only Better Auth endpoint. It exists solely when `localDemoEnabled`
 * is true (see auth.ts), which requires the stack runner's explicit ephemeral
 * flag plus the exact loopback origins below. The endpoint seeds a normal user,
 * organization membership, and Better Auth session; downstream API routes still
 * authenticate that cookie and enforce their normal membership checks.
 */
import { createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import type { AuthEnv } from "./auth";
import * as schema from "./schema";

export const LOCAL_STACK_AUTH_ORIGIN = "http://127.0.0.1:8788";
export const LOCAL_STACK_WEB_ORIGIN = "http://127.0.0.1:4321";

/**
 * Portless dev origins (see the `portless` skill): the stack runs at
 * https://auth.<name>.localhost / https://<name>.localhost (optionally
 * worktree-prefixed, optionally on the sudo-less proxy port, e.g.
 * http://uploads.localhost:1355). Accept the pair only when the auth host has
 * a shareable `.<name>.localhost` parent and the web host lives under that
 * same parent — the exact property the shared session cookie depends on.
 * `.localhost` names resolve to loopback by spec, so this stays as local-only
 * as the IP-literal pair above.
 */
function portlessLocalStackOrigins(authUrl: string | undefined, webOrigin: string | undefined) {
  if (!authUrl || !webOrigin) return false;
  let auth: URL;
  let web: URL;
  try {
    auth = new URL(authUrl);
    web = new URL(webOrigin);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(auth.protocol) || !/^https?:$/.test(web.protocol)) return false;
  const parts = auth.hostname.split(".");
  if (parts.length < 3 || parts.at(-1) !== "localhost") return false;
  const base = parts.slice(-2).join(".");
  return web.hostname === base || web.hostname.endsWith("." + base);
}

const DEMO_USER = {
  id: "local-dev-demo-user",
  email: "dev-demo@uploads.local",
  name: "Local demo",
} as const;
const DEMO_ORGANIZATION = { id: "local-dev-demo-org", slug: "dev-demo", name: "Dev demo" } as const;

/**
 * The route is deliberately unavailable unless the lifecycle runner explicitly
 * opts in. Loopback-only origin shapes (exact IP-literal pair, or a matched
 * portless `*.localhost` pair) avoid accidentally enabling an identity bypass
 * on a public preview, a real-TLD alias, or a partially configured environment.
 */
export function localDemoEnabled(env: AuthEnv): boolean {
  if (env.LOCAL_STACK !== "true" || env.ENVIRONMENT !== "development") return false;
  if (
    env.BETTER_AUTH_URL === LOCAL_STACK_AUTH_ORIGIN &&
    env.WEB_ORIGIN === LOCAL_STACK_WEB_ORIGIN
  ) {
    return true;
  }
  return portlessLocalStackOrigins(env.BETTER_AUTH_URL, env.WEB_ORIGIN);
}

async function ensureDemoIdentity(env: AuthEnv) {
  const db = drizzle(env.DB, { schema });
  const now = new Date();

  let [user] = await db.select().from(schema.user).where(eq(schema.user.id, DEMO_USER.id)).limit(1);
  if (!user) {
    await db.insert(schema.user).values({
      ...DEMO_USER,
      emailVerified: true,
      role: "user",
      createdAt: now,
      updatedAt: now,
    });
    [user] = await db.select().from(schema.user).where(eq(schema.user.id, DEMO_USER.id)).limit(1);
  }

  let [organization] = await db
    .select()
    .from(schema.organization)
    .where(eq(schema.organization.slug, DEMO_ORGANIZATION.slug))
    .limit(1);
  if (!organization) {
    await db.insert(schema.organization).values({ ...DEMO_ORGANIZATION, createdAt: now });
    [organization] = await db
      .select()
      .from(schema.organization)
      .where(eq(schema.organization.slug, DEMO_ORGANIZATION.slug))
      .limit(1);
  }

  if (!organization) throw new Error("local demo organization could not be created");

  const [membership] = await db
    .select({ id: schema.member.id })
    .from(schema.member)
    .where(
      and(
        eq(schema.member.organizationId, organization.id),
        eq(schema.member.userId, DEMO_USER.id),
      ),
    )
    .limit(1);
  if (!membership) {
    await db.insert(schema.member).values({
      id: crypto.randomUUID(),
      organizationId: organization.id,
      userId: DEMO_USER.id,
      role: "member",
      createdAt: now,
    });
  }

  // The record is just created or read above. This guard keeps TypeScript and
  // the endpoint's normal failure path honest if a backing store misbehaves.
  if (!user) throw new Error("local demo user could not be created");
  return user;
}

/** Better Auth plugin so cookie signing/session creation stays canonical. */
export function localDemoPlugin(env: AuthEnv) {
  return {
    id: "uploads-local-demo",
    endpoints: {
      localDemoSession: createAuthEndpoint(
        "/dev-session",
        { method: "POST", requireHeaders: true },
        async (ctx) => {
          // Keep a wrong/missing browser origin indistinguishable from an
          // absent route. The plugin is itself omitted outside localDemoEnabled,
          // which has already vetted WEB_ORIGIN as a loopback-only shape.
          if (ctx.headers?.get("origin") !== env.WEB_ORIGIN) {
            return new Response("Not Found", { status: 404 });
          }
          const user = await ensureDemoIdentity(env);
          const session = await ctx.context.internalAdapter.createSession(user.id);
          if (!session) throw new Error("local demo session could not be created");
          await setSessionCookie(ctx, { session, user });
          return ctx.json({ user: { id: user.id, email: user.email, name: user.name } });
        },
      ),
    },
  };
}
