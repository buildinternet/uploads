/**
 * Explicit, permissioned diagnostic report submission.
 *
 * Unlike automatic telemetry, nothing is sent unless the user (or an agent
 * they instructed) runs `uploads report` / the MCP `report` tool.
 *
 * Optional log/trace attachments are text-only, capped, and stored server-side
 * in R2 under an unguessable key. Never auto-attaches files from disk.
 */
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { DEFAULT_API_URL } from "./config.js";
import { packageVersion } from "./package-version.js";
import {
  detectClientKind,
  detectRuntime,
  getOrCreateAnonId,
  isTelemetryEnabled,
} from "./telemetry.js";

export const REPORT_TYPES = ["bug", "error", "idea", "other"] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

export const MIN_REPORT_MESSAGE = 5;
export const MAX_REPORT_MESSAGE = 4000;
export const MAX_REPORT_ATTACHMENT_BYTES = 256 * 1024;
const POST_TIMEOUT_MS = 15_000;
const ISSUES_URL = "https://github.com/buildinternet/uploads/issues";

export interface ReportAttachment {
  filename: string;
  contentType: string;
  body: string;
}

export interface ReportPayload {
  message: string;
  type: ReportType;
  contact?: string;
  surface: "cli" | "mcp";
  cliVersion: string;
  clientKind: string;
  agentName?: string;
  anonId?: string;
  os: string;
  arch: string;
  runtime: string;
  command?: string;
  errorCode?: string;
  attachment?: ReportAttachment;
}

export interface SubmitReportOptions {
  apiUrl?: string;
  fetchImpl?: typeof fetch;
  version?: string;
  dataDir?: string;
  /** Include anonId only when telemetry is enabled (default). */
  includeAnonId?: boolean;
}

export type ValidateMessageResult = { ok: true; message: string } | { ok: false; error: string };

export function validateReportMessage(raw: string): ValidateMessageResult {
  const message = raw.trim();
  if (message.length < MIN_REPORT_MESSAGE) {
    return { ok: false, error: "message is too short — add a sentence or two" };
  }
  if (message.length > MAX_REPORT_MESSAGE) {
    return {
      ok: false,
      error: `message is too long (max ${MAX_REPORT_MESSAGE} chars)`,
    };
  }
  return { ok: true, message };
}

export function parseReportType(raw: string | undefined): ReportType | undefined {
  if (!raw) return undefined;
  return (REPORT_TYPES as readonly string[]).includes(raw) ? (raw as ReportType) : undefined;
}

/**
 * Load a local text file as an attachment. Rejects oversized / missing files.
 * Callers must have obtained the path from explicit user input (`--file`).
 */
export function loadReportAttachment(path: string): ReportAttachment {
  let size: number;
  try {
    size = statSync(path).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new Error(`file not found: ${path}`, { cause: err });
    }
    throw err;
  }
  if (size > MAX_REPORT_ATTACHMENT_BYTES) {
    throw new Error(`attachment exceeds ${MAX_REPORT_ATTACHMENT_BYTES} bytes (got ${size})`);
  }
  const body = readFileSync(path, "utf8");
  // Re-check UTF-8 byte length (stat is filesystem size).
  const bytes = new TextEncoder().encode(body).byteLength;
  if (bytes > MAX_REPORT_ATTACHMENT_BYTES) {
    throw new Error(`attachment exceeds ${MAX_REPORT_ATTACHMENT_BYTES} bytes after read`);
  }
  const filename = basename(path) || "attachment.txt";
  const lower = filename.toLowerCase();
  const contentType =
    lower.endsWith(".json") || lower.endsWith(".jsonl") || lower.endsWith(".ndjson")
      ? "application/json"
      : "text/plain; charset=utf-8";
  return { filename, contentType, body };
}

/** Build attachment from an in-memory string (MCP / piped text). */
export function attachmentFromText(
  body: string,
  filename = "trace.txt",
  contentType = "text/plain; charset=utf-8",
): ReportAttachment {
  const bytes = new TextEncoder().encode(body).byteLength;
  if (bytes > MAX_REPORT_ATTACHMENT_BYTES) {
    throw new Error(`attachment exceeds ${MAX_REPORT_ATTACHMENT_BYTES} bytes`);
  }
  if (!body.trim()) throw new Error("attachment is empty");
  return {
    filename: basename(filename) || "trace.txt",
    contentType,
    body,
  };
}

export function buildReportPayload(
  message: string,
  opts: {
    type?: ReportType;
    contact?: string;
    surface?: "cli" | "mcp";
    command?: string;
    errorCode?: string;
    attachment?: ReportAttachment;
  } = {},
  deps: {
    version?: string;
    dataDir?: string;
    includeAnonId?: boolean;
  } = {},
): ReportPayload {
  const ctx = detectClientKind();
  const includeAnon = deps.includeAnonId ?? isTelemetryEnabled(deps.dataDir);
  return {
    message,
    type: opts.type ?? "other",
    contact: opts.contact?.trim() || undefined,
    surface: opts.surface ?? "cli",
    cliVersion: deps.version ?? packageVersion(),
    clientKind: ctx.kind,
    agentName: ctx.agentName,
    anonId: includeAnon ? getOrCreateAnonId(deps.dataDir) : undefined,
    os: process.platform,
    arch: process.arch,
    runtime: detectRuntime(),
    command: opts.command?.trim().slice(0, 120) || undefined,
    errorCode: opts.errorCode?.trim().slice(0, 64) || undefined,
    attachment: opts.attachment,
  };
}

export type SubmitReportResult =
  | { ok: true; id: string; hasAttachment: boolean }
  | { ok: false; error: string };

export async function submitReport(
  payload: ReportPayload,
  opts: SubmitReportOptions = {},
): Promise<SubmitReportResult> {
  const base = (opts.apiUrl ?? process.env.UPLOADS_API_URL ?? DEFAULT_API_URL).replace(/\/$/, "");
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(`${base}/v1/reports`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": `uploads-cli/${payload.cliVersion}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      let detail = `server returned ${res.status}`;
      try {
        const errBody = (await res.json()) as { error?: { message?: string } };
        if (errBody?.error?.message) detail = errBody.error.message;
      } catch {
        // ignore
      }
      return { ok: false, error: detail };
    }
    const json = (await res.json()) as {
      ok?: boolean;
      id?: string;
      hasAttachment?: boolean;
    };
    if (!json.ok || !json.id) return { ok: false, error: "unexpected response" };
    return {
      ok: true,
      id: json.id,
      hasAttachment: Boolean(json.hasAttachment),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("abort")) return { ok: false, error: "request timed out" };
    return { ok: false, error: msg };
  } finally {
    clearTimeout(t);
  }
}

export function reportFallbackHint(): string {
  return `You can open an issue instead: ${ISSUES_URL}`;
}
