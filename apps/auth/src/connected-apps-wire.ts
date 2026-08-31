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

/** Normalize a DB timestamp (Date | string | number) to ISO, or null. */
export function toIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" || typeof value === "number") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}
