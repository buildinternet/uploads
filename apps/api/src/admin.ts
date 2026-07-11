import { UnauthorizedError } from "@uploads/errors";
import type { MiddlewareHandler } from "hono";
import { hexToBytes, sha256Hex } from "./workspace";

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
  const ok =
    secret.length > 0 &&
    token.length > 0 &&
    crypto.subtle.timingSafeEqual(hexToBytes(providedHash), hexToBytes(expectedHash));

  if (!ok) throw new UnauthorizedError();
  await next();
};
