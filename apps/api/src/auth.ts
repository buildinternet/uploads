import type { MiddlewareHandler } from "hono";

async function sha256(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
}

/**
 * Bearer-token auth against the AUTH_TOKEN secret. Tokens are hashed before
 * comparison so timingSafeEqual gets equal-length buffers.
 */
export const bearerAuth: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const expected = c.env.AUTH_TOKEN;
  if (!expected) {
    return c.json({ error: "server is missing AUTH_TOKEN" }, 500);
  }
  const header = c.req.header("Authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  const [a, b] = await Promise.all([sha256(provided), sha256(expected)]);
  if (!crypto.subtle.timingSafeEqual(a, b)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
};
