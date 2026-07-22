/**
 * Shared helpers for CLI/MCP intake routes (`/v1/telemetry`, `/v1/reports`).
 * Keep field allowlists and sanitizers in one place.
 */
import { PayloadTooLargeError, ValidationError } from "@uploads/errors";

export const MAX_STRING = 200;
export const MAX_COMMAND = 120;
export const MAX_VERSION = 32;
export const MAX_ANON_ID = 64;
export const MAX_ERROR_CODE = 64;
export const MAX_ATTACHMENT_BYTES = 256 * 1024;
/** Telemetry JSON is tiny (no free text). */
export const MAX_TELEMETRY_BODY_BYTES = 8 * 1024;
/** Report JSON = short message + optional 256 KiB text attachment. */
export const MAX_REPORT_BODY_BYTES = MAX_ATTACHMENT_BYTES + 8 * 1024;

export const SURFACES = new Set(["cli", "mcp"]);
export const CLIENT_KINDS = new Set(["external", "ci", "agent"]);
export const REPORT_TYPES = new Set(["bug", "error", "idea", "other"]);

/** Allowlisted CLI error codes. Unknown values are dropped (never free-form). */
export const ERROR_CODES = new Set([
  "MISSING_TOKEN",
  "NO_PUBLIC_URL",
  "FILE_NOT_FOUND",
  "NOT_FOUND",
  "UNAUTHORIZED",
  "INVALID_KEY",
  "KEY_POLICY",
  "STORAGE_QUOTA",
  "UPLOAD_BUDGET",
  "GITHUB_REQUIRED",
  "API_ERROR",
  "NETWORK",
  "USAGE",
]);

export function sanitizeString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

/**
 * Parse a finite integer within JavaScript's safe integer range.
 * Returns null for invalid / non-safe values (callers apply field ranges).
 */
export function sanitizeInt(value: unknown): number | null {
  let n: number | null = null;
  if (typeof value === "number" && Number.isFinite(value)) n = Math.trunc(value);
  else if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) n = Math.trunc(parsed);
  }
  if (n === null || !Number.isSafeInteger(n)) return null;
  return n;
}

/** Keep only when in [min, max] inclusive. */
export function clampInt(value: number | null, min: number, max: number): number | null {
  if (value === null || value < min || value > max) return null;
  return value;
}

/**
 * Read and parse a JSON object body with Content-Length + buffer size caps.
 * Rejects null, arrays, and non-objects.
 */
export async function readJsonObjectBody(
  req: Request,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  const declared = Number(req.headers.get("Content-Length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new PayloadTooLargeError(`request body exceeds ${maxBytes} bytes`);
  }
  const bytes = await req.arrayBuffer();
  if (bytes.byteLength > maxBytes) {
    throw new PayloadTooLargeError(`request body exceeds ${maxBytes} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ValidationError("invalid JSON body");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ValidationError("invalid JSON body");
  }
  return parsed as Record<string, unknown>;
}

/** Drop C0 controls except tab/LF/CR (terminal-safe stored text). */
export function stripControl(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)) out += ch;
  }
  return out;
}

export function pickSurface(value: unknown, fallback = "cli"): string {
  const s = sanitizeString(value, 16) ?? fallback;
  return SURFACES.has(s) ? s : fallback;
}

export function pickClientKind(value: unknown): string {
  const s = sanitizeString(value, 32) ?? "external";
  return CLIENT_KINDS.has(s) ? s : "external";
}

export function pickErrorCode(value: unknown): string | null {
  const raw = sanitizeString(value, MAX_ERROR_CODE);
  return raw && ERROR_CODES.has(raw) ? raw : null;
}

export function pickReportType(value: unknown): string {
  const raw = sanitizeString(value, 32) ?? "other";
  return REPORT_TYPES.has(raw) ? raw : "other";
}

export function safeFilename(raw: string | null): string {
  const base = (raw ?? "attachment.txt")
    .replace(/\\/g, "/")
    .split("/")
    .pop()!
    .replace(/[^\w.\-+=@]+/g, "_")
    .slice(0, 120);
  return base.length > 0 ? base : "attachment.txt";
}

export function envFlagOn(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

export function newId(prefix: "tel" | "rpt" | "ab"): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}
