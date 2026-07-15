/**
 * Explicit diagnostic reports → D1 `uploads_cli_reports` (+ optional R2 log).
 * Never automatic — requires `uploads report` / MCP `report`.
 */
import { PayloadTooLargeError, RateLimitedError, ValidationError } from "@uploads/errors";
import { Hono } from "hono";
import {
  MAX_ANON_ID,
  MAX_ATTACHMENT_BYTES,
  MAX_COMMAND,
  MAX_STRING,
  MAX_VERSION,
  envFlagOn,
  newId,
  pickClientKind,
  pickErrorCode,
  pickReportType,
  pickSurface,
  safeFilename,
  sanitizeString,
  stripControl,
} from "../cli-intake";
import type { WorkspaceVars } from "../workspace";

export { MAX_ATTACHMENT_BYTES };

export const reports = new Hono<WorkspaceVars>();

reports.post("/", async (c) => {
  if (envFlagOn(c.env.REPORTS_DISABLED)) {
    throw new ValidationError("report intake is disabled", { code: "reports_disabled" });
  }

  const limiter = c.env.INVITE_LIMITER;
  if (limiter) {
    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
    const { success } = await limiter.limit({ key: `cli-report:${ip}` });
    if (!success) {
      c.header("Retry-After", "60");
      throw new RateLimitedError("too many reports; retry shortly");
    }
  }

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    throw new ValidationError("invalid JSON body");
  }

  const rawMessage = sanitizeString(body.message, 4000);
  const message = rawMessage ? stripControl(rawMessage).trim() : null;
  if (!message || message.length < 5) {
    throw new ValidationError("message must be 5–4000 characters", { code: "bad_request" });
  }

  const type = pickReportType(body.type);
  const contactRaw = sanitizeString(body.contact, 200);
  const contact = contactRaw ? stripControl(contactRaw).trim() || null : null;
  const surface = pickSurface(body.surface);
  const clientKind = pickClientKind(body.clientKind);
  const id = newId("rpt");

  let attachmentKey: string | null = null;
  let attachmentFilename: string | null = null;
  let attachmentBytes: number | null = null;

  if (body.attachment != null) {
    if (typeof body.attachment !== "object" || Array.isArray(body.attachment)) {
      throw new ValidationError("attachment must be an object", { code: "bad_request" });
    }
    const att = body.attachment as Record<string, unknown>;
    if (typeof att.body !== "string" || !att.body) {
      throw new ValidationError("attachment.body is required", { code: "bad_request" });
    }
    const bytes = new TextEncoder().encode(att.body);
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new PayloadTooLargeError(`attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes`, {
        code: "attachment_too_large",
      });
    }
    const contentType = sanitizeString(att.contentType, 100) ?? "text/plain; charset=utf-8";
    if (
      !contentType.startsWith("text/") &&
      contentType !== "application/json" &&
      contentType !== "application/x-ndjson" &&
      !contentType.startsWith("application/json")
    ) {
      throw new ValidationError("attachment content type must be text or json", {
        code: "unsupported_attachment_type",
      });
    }
    const r2 = c.env.UPLOADS_DEFAULT;
    if (!r2) {
      throw new ValidationError("report attachments unavailable (no R2 binding)", {
        code: "attachment_unavailable",
      });
    }
    const filename = safeFilename(sanitizeString(att.filename, 120));
    attachmentKey = `_internal/uploads-cli-reports/${id}/${filename}`;
    attachmentFilename = filename;
    attachmentBytes = bytes.byteLength;
    await r2.put(attachmentKey, bytes, {
      httpMetadata: { contentType },
      customMetadata: { reportId: id, surface, type },
    });
  }

  if (c.env.DB) {
    try {
      await c.env.DB.prepare(
        `INSERT INTO uploads_cli_reports (
          id, message, type, contact, surface, client_kind, anon_id,
          cli_version, os, arch, runtime, command, error_code,
          attachment_key, attachment_filename, attachment_bytes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          id,
          message,
          type,
          contact,
          surface,
          clientKind,
          sanitizeString(body.anonId, MAX_ANON_ID),
          sanitizeString(body.cliVersion, MAX_VERSION),
          sanitizeString(body.os, MAX_STRING),
          sanitizeString(body.arch, MAX_STRING),
          sanitizeString(body.runtime, MAX_STRING),
          sanitizeString(body.command, MAX_COMMAND),
          pickErrorCode(body.errorCode),
          attachmentKey,
          attachmentFilename,
          attachmentBytes,
        )
        .run();
    } catch (err) {
      console.error(
        JSON.stringify({
          message: "uploads_cli_reports insert failed",
          error: err instanceof Error ? err.message : String(err),
          id,
        }),
      );
    }
  }

  return c.json({ ok: true, id, hasAttachment: Boolean(attachmentKey) }, 202);
});
