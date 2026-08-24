import { RateLimitedError, ValidationError } from "@uploads/errors";
import { Hono } from "hono";
import { exchangeEnrollment, findEnrollmentPage } from "../auth-db";
import { dbFor } from "../db-session";

const INVALID_ENROLLMENT = () =>
  new ValidationError("invalid or expired enrollment code", { code: "invalid_enrollment" });
const MAX_EXCHANGE_BODY_BYTES = 1024;

export const auth = new Hono<{ Bindings: Env }>()
  .use("/enrollments/*", async (c, next) => {
    const limiter = c.env.INVITE_LIMITER;
    if (limiter) {
      const address = c.req.header("CF-Connecting-IP") ?? "unknown";
      const operation = c.req.path.endsWith("/exchange") ? "exchange" : "lookup";
      const { success } = await limiter.limit({ key: `invite:${operation}:${address}` });
      if (!success) {
        throw new RateLimitedError("invitation rate limit exceeded", { retryAfterSeconds: 60 });
      }
    }
    await next();
  })
  .get("/enrollments/:pageId", async (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Access-Control-Allow-Origin", "https://uploads.sh");
    const result = await findEnrollmentPage(dbFor(c.env), c.req.param("pageId"));
    if (!result) throw INVALID_ENROLLMENT();
    return c.json(result);
  })
  .post("/enrollments/exchange", async (c) => {
    c.header("Cache-Control", "no-store");
    const contentLength = Number(c.req.header("Content-Length") ?? 0);
    if (contentLength > MAX_EXCHANGE_BODY_BYTES) throw INVALID_ENROLLMENT();
    const bytes = await c.req.arrayBuffer();
    if (bytes.byteLength > MAX_EXCHANGE_BODY_BYTES) throw INVALID_ENROLLMENT();
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw INVALID_ENROLLMENT();
    }
    if (
      parsed === null ||
      Array.isArray(parsed) ||
      typeof parsed !== "object" ||
      !("code" in parsed) ||
      Object.keys(parsed).length !== 1 ||
      typeof parsed.code !== "string"
    ) {
      throw INVALID_ENROLLMENT();
    }
    const code = parsed.code.trim();
    if (!/^upe_[A-Za-z0-9_-]{20,}$/.test(code)) throw INVALID_ENROLLMENT();
    const result = await exchangeEnrollment(dbFor(c.env), code);
    if (!result) throw INVALID_ENROLLMENT();
    return c.json(result, 201);
  });
