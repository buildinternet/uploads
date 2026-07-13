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
  /** True for the communal, world-readable workspace (no personal browser). */
  communal: boolean;
}

// `communal` is intentionally NOT required here: web and api deploy
// independently, so an older api may omit it. We accept the entry and coerce a
// missing/other value to `false` in the mapper below.
function isMyWorkspaceCore(value: unknown): value is Omit<MyWorkspace, "communal"> {
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
    return body.workspaces.filter(isMyWorkspaceCore).map(
      (ws): MyWorkspace => ({
        workspace: ws.workspace,
        organization: ws.organization,
        role: ws.role,
        communal: (ws as { communal?: unknown }).communal === true,
      }),
    );
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

/**
 * Shared GET for the array-returning `/me/workspaces/:name/<segment>` endpoints
 * (galleries, files). Reads `body[key]`, drops malformed entries via `isValid`,
 * and returns [] on any non-2xx, malformed body, or communal workspace (which
 * the API returns with an empty list).
 */
async function fetchWorkspaceList<T>(
  apiOrigin: string,
  name: string,
  segment: string,
  key: string,
  isValid: (value: unknown) => value is T,
): Promise<T[]> {
  try {
    const res = await fetch(
      `${trimOrigin(apiOrigin)}/me/workspaces/${encodeURIComponent(name)}/${segment}`,
      { credentials: "include", cache: "no-store" },
    );
    if (!res.ok) return [];
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const list = body?.[key];
    if (!Array.isArray(list)) return [];
    return list.filter(isValid);
  } catch {
    return [];
  }
}

export interface GallerySummary {
  id: string;
  url: string;
  title: string;
  description: string | null;
  coverItemId: string | null;
  createdAt: string;
  updatedAt: string;
}

function isGallerySummary(value: unknown): value is GallerySummary {
  if (!value || typeof value !== "object") return false;
  const g = value as Record<string, unknown>;
  return typeof g.id === "string" && typeof g.url === "string" && typeof g.title === "string";
}

/** GET /me/workspaces/:name/galleries. See {@link fetchWorkspaceList}. */
export function getMyWorkspaceGalleries(
  apiOrigin: string,
  name: string,
): Promise<GallerySummary[]> {
  return fetchWorkspaceList(apiOrigin, name, "galleries", "galleries", isGallerySummary);
}

export interface WorkspaceFile {
  key: string;
  url: string | null;
  size?: number;
  contentType?: string;
  uploaded?: string;
}

function isWorkspaceFile(value: unknown): value is WorkspaceFile {
  if (!value || typeof value !== "object") return false;
  const f = value as Record<string, unknown>;
  return typeof f.key === "string" && (f.url === null || typeof f.url === "string");
}

/** GET /me/workspaces/:name/files. See {@link fetchWorkspaceList}. */
export function getMyWorkspaceFiles(apiOrigin: string, name: string): Promise<WorkspaceFile[]> {
  return fetchWorkspaceList(apiOrigin, name, "files", "files", isWorkspaceFile);
}
