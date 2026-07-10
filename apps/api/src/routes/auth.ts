import { Hono } from "hono";
import { exchangeEnrollment } from "../auth-db";

const INVALID_ENROLLMENT = { error: "invalid or expired enrollment code" } as const;
const MAX_EXCHANGE_BODY_BYTES = 1024;

export const auth = new Hono<{ Bindings: Env }>().post("/enrollments/exchange", async (c) => {
  c.header("Cache-Control", "no-store");
  const contentLength = Number(c.req.header("Content-Length") ?? 0);
  if (contentLength > MAX_EXCHANGE_BODY_BYTES) return c.json(INVALID_ENROLLMENT, 400);
  const body = await c.req
    .json<Record<string, unknown>>()
    .catch(() => ({}) as Record<string, unknown>);
  if (Object.keys(body).length !== 1 || typeof body.code !== "string") {
    return c.json(INVALID_ENROLLMENT, 400);
  }
  const code = body.code?.trim() ?? "";
  if (!/^upe_[A-Za-z0-9_-]{20,}$/.test(code)) return c.json(INVALID_ENROLLMENT, 400);
  const result = await exchangeEnrollment(c.env.DB, code);
  if (!result) return c.json(INVALID_ENROLLMENT, 400);
  return c.json(result, 201);
});
