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

/**
 * The raw (non-portless) local stack's pinned loopback web origin
 * (scripts/dev-stack.mjs, `PORTLESS=0`). #731 phase C: the auth worker's own
 * `LOCAL_STACK_AUTH_ORIGIN` (http://127.0.0.1:8788) constant is gone — the
 * stack now runs the auth worker's `BETTER_AUTH_URL` as this same web
 * origin (same-origin mode), even though the worker process itself still
 * listens on its own pinned port. See `isLocalStackWebOrigin` below.
 */
export const LOCAL_STACK_WEB_ORIGIN = "http://127.0.0.1:4321";

/**
 * Default portless hostname (TLD `dev` + name `uploads.local.buildinternet`).
 * Keep in sync with `portless.json`, `PORTLESS_BASE` in
 * `scripts/dev-stack-common.mjs`, and `isLocalDemoStack` in the web app.
 */
export const LOCAL_STACK_DEV_HOST = "uploads.local.buildinternet.dev";

/**
 * True for a local-stack WEB origin shape: the raw stack's pinned loopback
 * port, a leftover portless `*.localhost` origin (optionally worktree-
 * prefixed, optionally on the sudo-less proxy port), or the owned
 * `uploads.local.buildinternet.dev` zone (same sibling convention as Either;
 * worktree prefix `fix-ui.uploads.local.buildinternet.dev`). Bare
 * `uploads.dev` is not local — that is the collision you get if the app name
 * stays `uploads` under `--tld dev`.
 */
export function isLocalStackWebOrigin(webOrigin: string | undefined): boolean {
  if (!webOrigin) return false;
  if (webOrigin === LOCAL_STACK_WEB_ORIGIN) return true;
  let web: URL;
  try {
    web = new URL(webOrigin);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(web.protocol)) return false;
  const host = web.hostname;
  if (host === LOCAL_STACK_DEV_HOST || host.endsWith(`.${LOCAL_STACK_DEV_HOST}`)) return true;
  const parts = host.split(".");
  return parts.length >= 2 && parts.at(-1) === "localhost";
}

const DEMO_USER = {
  id: "local-dev-demo-user",
  email: "dev-demo@uploads.local",
  name: "Local demo",
} as const;
const DEMO_ORGANIZATION = { id: "local-dev-demo-org", slug: "dev-demo", name: "Dev demo" } as const;

/**
 * The route is deliberately unavailable unless the lifecycle runner explicitly
 * opts in. #731 phase C: the dev stack now always runs the auth worker in
 * same-origin mode (`BETTER_AUTH_URL === WEB_ORIGIN`, mirroring production —
 * see scripts/dev-stack.mjs), so this requires that equality PLUS a
 * recognized local-stack web-origin shape (the raw stack's pinned loopback
 * port, a leftover `*.localhost` origin, or the owned
 * `uploads.local.buildinternet.dev` zone). Unrelated real TLDs never enable
 * the bypass, even if they happen to be same-origin.
 */
export function localDemoEnabled(env: AuthEnv): boolean {
  if (env.LOCAL_STACK !== "true" || env.ENVIRONMENT !== "development") return false;
  if (!env.BETTER_AUTH_URL || env.BETTER_AUTH_URL !== env.WEB_ORIGIN) return false;
  return isLocalStackWebOrigin(env.WEB_ORIGIN);
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
