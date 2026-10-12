/**
 * Wire types for GET/POST /api/auth/digest-preferences. Env-free so apps/web
 * can import the parser without pulling in the auth worker's bindings.
 */

export interface DigestWorkspacePreference {
  organizationId: string;
  slug: string;
  name: string;
  role: string;
  /** True when this membership can receive the admin pulse. */
  admin: boolean;
  notifyWeeklyDigest: boolean;
  notifyWeeklyWorkspaceDigest: boolean;
}

export interface DigestPreferencesResponse {
  workspaces: DigestWorkspacePreference[];
}

export function isDigestAdminRole(role: string): boolean {
  return role.split(",").some((part) => {
    const trimmed = part.trim();
    return trimmed === "admin" || trimmed === "owner";
  });
}

export function digestPreferencesResponse(
  workspaces: DigestWorkspacePreference[],
): DigestPreferencesResponse {
  return { workspaces };
}

function isPreference(value: unknown): value is DigestWorkspacePreference {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.organizationId === "string" &&
    row.organizationId.length > 0 &&
    typeof row.slug === "string" &&
    typeof row.name === "string" &&
    typeof row.role === "string" &&
    typeof row.admin === "boolean" &&
    typeof row.notifyWeeklyDigest === "boolean" &&
    typeof row.notifyWeeklyWorkspaceDigest === "boolean"
  );
}

/** Null when the body is not the preferences document. */
export function parseDigestPreferences(body: unknown): DigestWorkspacePreference[] | null {
  if (!body || typeof body !== "object") return null;
  const workspaces = (body as { workspaces?: unknown }).workspaces;
  if (!Array.isArray(workspaces) || !workspaces.every(isPreference)) return null;
  return workspaces;
}
