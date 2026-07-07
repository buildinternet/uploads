import type { MiddlewareHandler } from "hono";
import { sha256Hex } from "./workspace";

/**
 * Gates /admin/* on the ADMIN_TOKEN secret. Fails closed: if the secret is
 * unset/empty, every request is 401. Compares SHA-256 digests in constant time.
 */
export const adminAuth: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const secret = c.env.ADMIN_TOKEN ?? "";
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";

  const providedHash = await sha256Hex(token);
  const expectedHash = secret ? await sha256Hex(secret) : providedHash.replace(/./g, "0");
  const bytes = (hex: string) => {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
  };
  const ok =
    secret.length > 0 &&
    token.length > 0 &&
    crypto.subtle.timingSafeEqual(bytes(providedHash), bytes(expectedHash));

  if (!ok) return c.json({ error: "unauthorized" }, 401);
  await next();
};
