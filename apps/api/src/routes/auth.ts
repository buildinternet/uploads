import { RateLimitedError, ValidationError } from "@uploads/errors";
import { Hono, type Context } from "hono";
import { exchangeEnrollment, findEnrollmentPage } from "../auth-db";
import { dbFor } from "../db-session";
import { resolveSessionUserId } from "../dual-workspace-auth";
import { throwForInviteError } from "../invite-error";
import { sha256Hex } from "../workspace";
import type { SessionVars } from "../session-auth";

const INVALID_ENROLLMENT = () =>
  new ValidationError("invalid or expired enrollment code", { code: "invalid_enrollment" });
const MAX_EXCHANGE_BODY_BYTES = 1024;

/**
 * Parses and validates the `{ code }` body shared by `/exchange` and
 * `/join`: ≤1KB, single-key object, `code` a string matching the enrollment
 * code shape. Throws the uniform `INVALID_ENROLLMENT` on any deviation —
 * same hygiene, same non-distinguishing failure, for both endpoints.
 */
async function readEnrollmentCode(c: {
  req: { header: (name: string) => string | undefined; arrayBuffer: () => Promise<ArrayBuffer> };
}): Promise<string> {
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
  return code;
}

export const auth = new Hono<{ Bindings: Env } & SessionVars>()
  .use("/enrollments/*", async (c, next) => {
    const limiter = c.env.INVITE_LIMITER;
    if (limiter) {
      const address = c.req.header("CF-Connecting-IP") ?? "unknown";
      const operation = c.req.path.endsWith("/exchange")
        ? "exchange"
        : c.req.path.endsWith("/join")
          ? "join"
          : "lookup";
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
    const code = await readEnrollmentCode(c);
    const result = await exchangeEnrollment(dbFor(c.env), code);
    if (!result) throw INVALID_ENROLLMENT();
    return c.json(result, 201);
  })
  // Issue #869 phase B: redeems a workspace-admin `kind: 'member'` join link
  // as membership (not a CLI token — that's `/exchange` above, `kind:
  // 'token'` only). Session-authed: the redeemer must be signed in (any
  // signed-in user with a valid code may join — this is not admin-gated),
  // 401 via `resolveSessionUserId` when they aren't.
  .post("/enrollments/join", async (c) => {
    c.header("Cache-Control", "no-store");
    const code = await readEnrollmentCode(c);
    // Resolve the session BEFORE touching D1: an unauthenticated caller gets
    // a plain 401, not a code-shape-dependent response, so this endpoint
    // can't be used to probe code validity while signed out.
    const userId = await resolveSessionUserId(c as unknown as Context<SessionVars>);

    const db = dbFor(c.env);
    const now = new Date();
    const nowIso = now.toISOString();
    const codeHash = await sha256Hex(code);

    const enrollment = await db
      .prepare(
        `SELECT id, workspace FROM auth_enrollments
         WHERE code_hash = ? AND used_at IS NULL AND expires_at > ? AND kind = 'member'
         LIMIT 1`,
      )
      .bind(codeHash, nowIso)
      .first<{ id: string; workspace: string }>();
    if (!enrollment) throw INVALID_ENROLLMENT();

    // Claim the link first (single-use, race-safe: a conditional UPDATE that
    // only the first concurrent redeemer wins), THEN add the member. A lost
    // race here is indistinguishable from any other invalid code.
    const claim = await db
      .prepare(
        `UPDATE auth_enrollments SET used_at = ?
         WHERE id = ? AND code_hash = ? AND used_at IS NULL AND expires_at > ? AND kind = 'member'`,
      )
      .bind(nowIso, enrollment.id, codeHash, nowIso)
      .run();
    if ((claim.meta?.changes ?? 0) !== 1) throw INVALID_ENROLLMENT();

    const response = await c.env.AUTH.fetch("https://auth.internal/internal/join", {
      method: "POST",
      headers: { "content-type": "application/json", "x-uploads-internal": "1" },
      body: JSON.stringify({ organizationSlug: enrollment.workspace, userId }),
    });
    if (!response.ok) {
      // The member add failed (cap denial, or a transient auth-worker
      // error) — restore the link so a redemption that didn't actually
      // happen doesn't permanently burn it.
      await db
        .prepare(`UPDATE auth_enrollments SET used_at = NULL WHERE id = ? AND code_hash = ?`)
        .bind(enrollment.id, codeHash)
        .run();
      const payload = (await response.json().catch(() => null)) as {
        error?: { code?: unknown; message?: unknown };
      } | null;
      if (response.status === 403 && payload?.error?.code === "member_cap_reached") {
        throwForInviteError(response.status, payload);
      }
      throw INVALID_ENROLLMENT();
    }
    const payload = (await response.json().catch(() => null)) as { alreadyMember?: unknown } | null;
    return c.json(
      { workspace: enrollment.workspace, alreadyMember: payload?.alreadyMember === true },
      200,
    );
  });
