/**
 * Wire types for the `/oauth2/connected-apps` endpoints (issue #896 pattern).
 * Split out of connected-apps.ts so apps/web can `import type` the response
 * shape via `@uploads/auth/connected-apps-wire` without typechecking that
 * module's better-auth/drizzle plumbing — and, like every shared module, this
 * file must never reference the ambient `Env` global (each worker declares
 * its own; the importer's wins and typecheck breaks).
 */

/** One OAuth grant: an `oauth_consent` row joined to its `oauth_client`. */
export interface ConnectedAppGrant {
  id: string;
  clientId: string;
  clientName: string | null;
  clientIcon: string | null;
  clientUri: string | null;
  scopes: string[];
  referenceId: string | null;
  activeTokenCount: number;
  createdAt: string | null;
  updatedAt: string | null;
}

/**
 * Coerce `oauth_consent.scopes` to `string[]` without throwing.
 *
 * Better Auth stringifies the grant list and Drizzle `mode: "json"`
 * stringifies again, so a read with one `JSON.parse` yields the *string*
 * `["files:read","offline_access"]` rather than a `string[]`. Connected
 * apps then filtered those rows out. Accept the shapes we actually see:
 * an array (keep string entries), a JSON-array string (parse once more),
 * or a space-delimited string (OAuth `scope=` form).
 */
export function normalizeConsentScopes(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.filter((entry): entry is string => typeof entry === "string");
      }
    } catch {
      // Fall through to whitespace split — never throw on a bad payload.
    }
  }
  return trimmed.split(/\s+/).filter(Boolean);
}

/**
 * Unix ms crosses 1e12 in 2001; `oauth_consent.created_at` / `updated_at`
 * are drizzle `integer(..., { mode: "timestamp" })` epoch **seconds**
 * (prod sample `1789501808` ≈ Sep 2026 only when ×1000). Treat smaller
 * numbers as seconds so a raw integer cannot render as 1970.
 */
const UNIX_MS_THRESHOLD = 1e12;

function toDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = Math.abs(value) < UNIX_MS_THRESHOLD ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return toDate(Number(trimmed));
    const d = new Date(trimmed);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** Normalize a DB timestamp (Date | string | number) to ISO, or null. */
export function toIso(value: unknown): string | null {
  const d = toDate(value);
  return d ? d.toISOString() : null;
}
