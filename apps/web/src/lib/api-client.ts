/**
 * Session-cookie-authenticated wrappers for apps/api's `/me/*` surface
 * (issue #107). Same conventions as `src/lib/auth-client.ts`'s wrappers:
 * `credentials: "include"` so the cross-subdomain session cookie rides
 * along. The account workspace list preserves unavailable/auth failure states
 * rather than rendering an outage as an empty account; less central detail
 * helpers retain their defensive null/[] fallbacks.
 */
import { fetchWithTimeout, type RequestFailure } from "./request";

function trimOrigin(origin: string): string {
  return origin.replace(/\/$/, "");
}

export interface MyWorkspace {
  workspace: string;
  organization: { id: string; slug: string; name: string };
  role: string;
  /** True for the communal, world-readable workspace (no personal browser). */
  communal: boolean;
  /**
   * True when the workspace has a stable public custom domain configured.
   * Lets the account file browser (issue #123) decide whether to open a
   * selected file via the public `/f/` page or resolve it through the
   * signed-URL-capable `/me/.../file-url` endpoint instead.
   */
  hasPublicUrl: boolean;
}

// `communal` and `hasPublicUrl` are intentionally NOT required here: web and
// api deploy independently, so an older api may omit them. We accept the
// entry and coerce a missing/other value to `false` in the mapper below.
function isMyWorkspaceCore(
  value: unknown,
): value is Omit<MyWorkspace, "communal" | "hasPublicUrl"> {
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

export type WorkspacesResult =
  | { kind: "success"; workspaces: MyWorkspace[] }
  | { kind: "unavailable"; reason: RequestFailure | "server" | "malformed" };

/** GET /me/workspaces, preserving an outage rather than rendering it as an empty account. */
export async function getMyWorkspaces(apiOrigin: string): Promise<WorkspacesResult> {
  const result = await fetchWithTimeout(`${trimOrigin(apiOrigin)}/me/workspaces`, {
    credentials: "include",
    cache: "no-store",
  });
  if (result.kind === "unavailable") return result;
  const { response } = result;
  if (!response.ok) return { kind: "unavailable", reason: "server" };
  const body = (await response.json().catch(() => undefined)) as
    | { workspaces?: unknown[] }
    | undefined;
  if (!body || !Array.isArray(body.workspaces)) return { kind: "unavailable", reason: "malformed" };
  return {
    kind: "success",
    workspaces: body.workspaces.filter(isMyWorkspaceCore).map(
      (ws): MyWorkspace => ({
        workspace: ws.workspace,
        organization: ws.organization,
        role: ws.role,
        communal: (ws as { communal?: unknown }).communal === true,
        hasPublicUrl: (ws as { hasPublicUrl?: unknown }).hasPublicUrl === true,
      }),
    ),
  };
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
  const result = await fetchWithTimeout(
    `${trimOrigin(apiOrigin)}/me/workspaces/${encodeURIComponent(name)}/usage`,
    { credentials: "include", cache: "no-store" },
  );
  if (result.kind === "unavailable" || !result.response.ok) return null;
  const body = (await result.response.json().catch(() => null)) as WorkspaceUsage | null;
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
  const result = await fetchWithTimeout(
    `${trimOrigin(apiOrigin)}/me/workspaces/${encodeURIComponent(name)}/${segment}`,
    { credentials: "include", cache: "no-store" },
  );
  if (result.kind === "unavailable" || !result.response.ok) return [];
  const body = (await result.response.json().catch(() => null)) as Record<string, unknown> | null;
  const list = body?.[key];
  return Array.isArray(list) ? list.filter(isValid) : [];
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
