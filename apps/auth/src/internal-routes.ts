/**
 * `/internal/*` API (plan D1/D9) — reachable only via the `AUTH` service
 * binding from apps/api (see src/internal.ts's isInternalRequest guard,
 * applied in src/index.ts before this router is even reached).
 */
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AuthEnv } from "./auth";
import * as schema from "./schema";

function errorJson(code: string, message: string) {
  return { error: { code, message } } as const;
}

export const internal = new Hono<{ Bindings: AuthEnv }>()
  // D9 fallback: ADMIN_TOKEN-gated promote endpoint on apps/api proxies here.
  // Looked up by email since that's the only identifier ops/CI reliably has;
  // 404s (rather than a generic 400) if no such user has ever signed in.
  .post("/promote-admin", async (c) => {
    const body = await c.req.json<{ email?: unknown }>().catch(() => ({}) as { email?: unknown });
    const email = typeof body.email === "string" ? body.email.trim() : "";
    if (!email) {
      return c.json(errorJson("invalid_email", "email is required"), 400);
    }

    const db = drizzle(c.env.DB, { schema });
    const [existing] = await db
      .select()
      .from(schema.user)
      .where(eq(schema.user.email, email))
      .limit(1);
    if (!existing) {
      return c.json(errorJson("user_not_found", "no user with that email"), 404);
    }

    await db.update(schema.user).set({ role: "admin" }).where(eq(schema.user.id, existing.id));
    const [updated] = await db
      .select()
      .from(schema.user)
      .where(eq(schema.user.id, existing.id))
      .limit(1);

    return c.json({
      ok: true,
      user: { id: updated.id, email: updated.email, role: updated.role },
    });
  });
