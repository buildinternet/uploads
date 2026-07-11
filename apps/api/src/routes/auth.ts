import { ValidationError } from "@uploads/errors";
import { Hono } from "hono";
import { exchangeEnrollment } from "../auth-db";

const INVALID_ENROLLMENT = () =>
  new ValidationError("invalid or expired enrollment code", { code: "invalid_enrollment" });
const MAX_EXCHANGE_BODY_BYTES = 1024;

export const auth = new Hono<{ Bindings: Env }>().post("/enrollments/exchange", async (c) => {
  c.header("Cache-Control", "no-store");
  const contentLength = Number(c.req.header("Content-Length") ?? 0);
  if (contentLength > MAX_EXCHANGE_BODY_BYTES) throw INVALID_ENROLLMENT();
  const body = await c.req
    .json<Record<string, unknown>>()
    .catch(() => ({}) as Record<string, unknown>);
  if (Object.keys(body).length !== 1 || typeof body.code !== "string") {
    throw INVALID_ENROLLMENT();
  }
  const code = body.code?.trim() ?? "";
  if (!/^upe_[A-Za-z0-9_-]{20,}$/.test(code)) throw INVALID_ENROLLMENT();
  const result = await exchangeEnrollment(c.env.DB, code);
  if (!result) throw INVALID_ENROLLMENT();
  return c.json(result, 201);
});
