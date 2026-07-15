/**
 * Shared helpers for CLI/MCP intake routes (`/v1/telemetry`, `/v1/reports`).
 * Keep field allowlists and sanitizers in one place.
 */

export const MAX_STRING = 200;
export const MAX_COMMAND = 120;
export const MAX_VERSION = 32;
export const MAX_ANON_ID = 64;
export const MAX_ERROR_CODE = 64;
export const MAX_ATTACHMENT_BYTES = 256 * 1024;

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

export function sanitizeInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return null;
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

export function newId(prefix: "tel" | "rpt"): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}
