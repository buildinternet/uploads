/**
 * Session-cookie-authenticated wrappers for apps/api's `/me/*` surface
 * (issue #107). Same conventions as `src/lib/auth-client.ts`'s wrappers:
 * `credentials: "include"` so the cross-subdomain session cookie rides
 * along, and defensive null/[] returns on any failure rather than throwing
 * — the /account page treats "no data" and "couldn't load" the same way.
 */

function trimOrigin(origin: string): string {
  return origin.replace(/\/$/, "");
}

export interface MyWorkspace {
  workspace: string;
  organization: { id: string; slug: string; name: string };
  role: string;
}

function isMyWorkspace(value: unknown): value is MyWorkspace {
  if (!value || typeof value !== "object") return false;
  const ws = value as Record<string, unknown>;
  const org = ws.organization as Record<string, unknown> | null | undefined;
  return (
    typeof ws.workspace === "string" &&
    typeof ws.role === "string" &&
    !!org &&
    typeof org === "object" &&
    typeof org.name === "string" &&
    typeof org.slug === "string"
  );
}

/** GET /me/workspaces. Returns [] on any non-2xx or malformed body; drops malformed entries. */
export async function getMyWorkspaces(apiOrigin: string): Promise<MyWorkspace[]> {
  try {
    const res = await fetch(`${trimOrigin(apiOrigin)}/me/workspaces`, {
      credentials: "include",
      cache: "no-store",
    });
    if (!res.ok) return [];
    const body = (await res.json().catch(() => null)) as { workspaces?: unknown[] } | null;
    if (!Array.isArray(body?.workspaces)) return [];
    return body.workspaces.filter(isMyWorkspace);
  } catch {
    return [];
  }
}

export interface WorkspaceUsage {
  workspace: string;
  bytes: number;
  objects: number;
  uploadsInPeriod: number;
  periodStart: string;
  updatedAt: string;
  maxStorageBytes?: number;
  storageRemainingBytes?: number;
  maxUploadsPerPeriod?: number;
  uploadsRemaining?: number;
}

/** GET /me/workspaces/:name/usage. Returns null on any non-2xx or malformed body. */
export async function getMyWorkspaceUsage(
  apiOrigin: string,
  name: string,
): Promise<WorkspaceUsage | null> {
  try {
    const res = await fetch(
      `${trimOrigin(apiOrigin)}/me/workspaces/${encodeURIComponent(name)}/usage`,
      { credentials: "include", cache: "no-store" },
    );
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as WorkspaceUsage | null;
    if (
      !body ||
      typeof body !== "object" ||
      typeof body.bytes !== "number" ||
      typeof body.objects !== "number" ||
      typeof body.uploadsInPeriod !== "number"
    ) {
      return null;
    }
    return body;
  } catch {
    return null;
  }
}
