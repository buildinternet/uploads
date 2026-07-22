/**
 * Open POST /v1/abuse — content reports from the public file page.
 * Body cap + per-IP rate limit + D1 row + best-effort email (releases feedback shape).
 */
import {
  InternalError,
  RateLimitedError,
  ServiceUnavailableError,
  ValidationError,
} from "@uploads/errors";
import { Hono } from "hono";
import { notifyAbuseReport } from "../abuse-email";
import { envFlagOn, newId, readJsonObjectBody, sanitizeString, stripControl } from "../cli-intake";
import type { WorkspaceVars } from "../workspace";

export const ABUSE_REASONS = ["abuse", "copyright", "spam", "privacy", "other"] as const;

const MAX_MESSAGE = 2000;
const MAX_CONTACT = 200;
const MAX_PAGE_URL = 2000;
const MAX_BODY_BYTES = 16 * 1024;

export const abuse = new Hono<WorkspaceVars>();

function pickReason(value: unknown): (typeof ABUSE_REASONS)[number] {
  const raw = sanitizeString(value, 32)?.toLowerCase();
  return raw && (ABUSE_REASONS as readonly string[]).includes(raw)
    ? (raw as (typeof ABUSE_REASONS)[number])
    : "abuse";
}

function sanitizePageUrl(value: unknown): string | null {
  const raw = sanitizeString(value, MAX_PAGE_URL);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString().slice(0, MAX_PAGE_URL);
  } catch {
    return null;
  }
}

abuse.post("/", async (c) => {
  if (envFlagOn(c.env.ABUSE_DISABLED)) {
    throw new ValidationError("abuse report intake is disabled", { code: "abuse_disabled" });
  }

  const limiter = c.env.INVITE_LIMITER;
  if (limiter) {
    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
    const { success } = await limiter.limit({ key: `abuse-report:${ip}` });
    if (!success) {
      c.header("Retry-After", "60");
      throw new RateLimitedError("too many reports; retry shortly");
    }
  }

  if (!c.env.DB) {
    throw new ServiceUnavailableError("report storage unavailable");
  }

  const body = await readJsonObjectBody(c.req.raw, MAX_BODY_BYTES);
  const pageUrl = sanitizePageUrl(body.pageUrl ?? body.url);
  if (!pageUrl) {
    throw new ValidationError("pageUrl must be an http(s) URL", { code: "bad_request" });
  }

  const reason = pickReason(body.reason);
  const message = (() => {
    const raw = sanitizeString(body.message, MAX_MESSAGE);
    return raw ? stripControl(raw).trim() || null : null;
  })();
  if (reason === "other" && (!message || message.length < 5)) {
    throw new ValidationError("message must be at least 5 characters when reason is other", {
      code: "bad_request",
    });
  }

  const contactRaw = sanitizeString(body.contact, MAX_CONTACT);
  const contact = contactRaw ? stripControl(contactRaw).trim() || null : null;
  const workspace = sanitizeString(body.workspace, 64);
  const objectKey = sanitizeString(body.key ?? body.objectKey, 1024);
  const surface = sanitizeString(body.surface, 32)?.toLowerCase() || "web";
  const id = newId("ab");
  const createdAt = new Date().toISOString();

  try {
    await c.env.DB.prepare(
      `INSERT INTO abuse_reports (
        id, created_at, reason, message, contact, page_url, workspace, object_key, surface
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, createdAt, reason, message, contact, pageUrl, workspace, objectKey, surface)
      .run();
  } catch (err) {
    console.error(
      JSON.stringify({
        message: "abuse_reports insert failed",
        error: err instanceof Error ? err.message : String(err),
        id,
      }),
    );
    throw new InternalError("failed to persist abuse report");
  }

  const notify = notifyAbuseReport(c.env, {
    id,
    reason,
    message,
    contact,
    pageUrl,
    workspace,
    objectKey,
    surface,
    createdAt,
  });
  // Workers have executionCtx; vitest app.request often does not.
  try {
    c.executionCtx.waitUntil(notify);
  } catch {
    await notify;
  }

  return c.json({ ok: true, id }, 202);
});
