/**
 * Explicit diagnostic reports → D1 `uploads_cli_reports` (+ optional R2 log).
 * Never automatic — requires `uploads report` / MCP `report`.
 */
import {
  InternalError,
  PayloadTooLargeError,
  RateLimitedError,
  ServiceUnavailableError,
  ValidationError,
} from "@uploads/errors";
import { Hono } from "hono";
import {
  MAX_ANON_ID,
  MAX_ATTACHMENT_BYTES,
  MAX_COMMAND,
  MAX_REPORT_BODY_BYTES,
  MAX_STRING,
  MAX_VERSION,
  envFlagOn,
  newId,
  pickClientKind,
  pickErrorCode,
  pickReportType,
  pickSurface,
  readJsonObjectBody,
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

  if (!c.env.DB) {
    throw new ServiceUnavailableError("report storage unavailable");
  }

  const body = await readJsonObjectBody(c.req.raw, MAX_REPORT_BODY_BYTES);

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

  let attachmentBytesPayload: Uint8Array | null = null;
  let attachmentFilename: string | null = null;
  let attachmentContentType: string | null = null;
  let attachmentKey: string | null = null;
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
    if (!c.env.UPLOADS_DEFAULT) {
      throw new ValidationError("report attachments unavailable (no R2 binding)", {
        code: "attachment_unavailable",
      });
    }
    const filename = safeFilename(sanitizeString(att.filename, 120));
    attachmentKey = `_internal/uploads-cli-reports/${id}/${filename}`;
    attachmentFilename = filename;
    attachmentContentType = contentType;
    attachmentBytes = bytes.byteLength;
    attachmentBytesPayload = bytes;
  }

  // Persist metadata first so a successful response always has a D1 row.
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
    throw new InternalError("failed to persist report");
  }

  // Attachment after D1 so failures don't orphan objects without a row.
  // If R2 fails, delete the D1 row so we never report success without a complete write.
  if (attachmentBytesPayload && attachmentKey && c.env.UPLOADS_DEFAULT) {
    try {
      await c.env.UPLOADS_DEFAULT.put(attachmentKey, attachmentBytesPayload, {
        httpMetadata: { contentType: attachmentContentType ?? "text/plain; charset=utf-8" },
        customMetadata: { reportId: id, surface, type },
      });
    } catch (err) {
      console.error(
        JSON.stringify({
          message: "report attachment put failed",
          error: err instanceof Error ? err.message : String(err),
          id,
        }),
      );
      try {
        await c.env.DB.prepare("DELETE FROM uploads_cli_reports WHERE id = ?").bind(id).run();
      } catch {
        // best-effort cleanup
      }
      throw new InternalError("failed to store report attachment");
    }
  }

  return c.json({ ok: true, id, hasAttachment: Boolean(attachmentKey) }, 202);
});
