/**
 * Session-cookie-authenticated wrappers for apps/api's `/me/*` surface
 * (issue #107). Same conventions as `src/lib/auth-client.ts`'s wrappers:
 * `credentials: "include"` so the cross-subdomain session cookie rides
 * along. The account workspace list preserves unavailable/auth failure states
 * rather than rendering an outage as an empty account; less central detail
 * helpers retain their defensive null/[] fallbacks.
 */
import { fetchWithTimeout, type RequestFailure } from "./request";
import { buildSearchQuery, type MetaFilter } from "./workspace-search-url";

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
  /** Present (== "private") only when the file was marked private (issue #139). */
  visibility?: "private";
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

export type FileVisibility = "public" | "private";

export type SetFileVisibilityResult =
  | { kind: "success"; visibility: FileVisibility }
  | { kind: "unavailable"; reason: RequestFailure | "server" | "malformed" };

/**
 * PATCH /me/workspaces/:name/files/visibility — toggles a file's private flag
 * (issue #139). Key travels as a query param, matching `file-url`'s
 * convention, since embedding an arbitrary (possibly `/`-containing) key in
 * the path segment fights routing.
 */
export async function setFileVisibility(
  apiOrigin: string,
  name: string,
  key: string,
  visibility: FileVisibility,
): Promise<SetFileVisibilityResult> {
  const result = await fetchWithTimeout(
    `${trimOrigin(apiOrigin)}/me/workspaces/${encodeURIComponent(name)}/files/visibility?key=${encodeURIComponent(key)}`,
    {
      method: "PATCH",
      credentials: "include",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visibility }),
    },
  );
  if (result.kind === "unavailable") return result;
  const { response } = result;
  if (!response.ok) return { kind: "unavailable", reason: "server" };
  const body = (await response.json().catch(() => undefined)) as
    | { visibility?: unknown }
    | undefined;
  if (body?.visibility !== "public" && body?.visibility !== "private") {
    return { kind: "unavailable", reason: "malformed" };
  }
  return { kind: "success", visibility: body.visibility };
}

export type InviteResult =
  | { kind: "ok"; invitationId?: string; status?: string; acceptUrl?: string }
  | { kind: "unavailable"; reason: RequestFailure | "server" | "forbidden" | "invalid" };

/**
 * POST /me/workspaces/:name/invites — workspace admin|owner invites an email.
 * Always prefer showing `acceptUrl` (works without outbound email).
 */
export async function inviteToWorkspace(
  apiOrigin: string,
  name: string,
  email: string,
): Promise<InviteResult> {
  const result = await fetchWithTimeout(
    `${trimOrigin(apiOrigin)}/me/workspaces/${encodeURIComponent(name)}/invites`,
    {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, role: "member" }),
    },
  );
  if (result.kind === "unavailable") return result;
  const { response } = result;
  if (response.status === 403) return { kind: "unavailable", reason: "forbidden" };
  if (response.status === 400) return { kind: "unavailable", reason: "invalid" };
  if (!response.ok) return { kind: "unavailable", reason: "server" };
  const body = (await response.json().catch(() => null)) as {
    invitation?: { id?: string; status?: string };
    acceptUrl?: string;
  } | null;
  return {
    kind: "ok",
    invitationId: body?.invitation?.id,
    status: body?.invitation?.status,
    acceptUrl: typeof body?.acceptUrl === "string" ? body.acceptUrl : undefined,
  };
}

export interface SearchFileItem {
  key: string;
  url: string | null;
  embedUrl: string | null;
  metadata: Record<string, string>;
}

export type SearchFilesResult =
  | { kind: "ok"; items: SearchFileItem[]; truncated: boolean }
  | { kind: "unavailable"; reason: "server" | "malformed" };

function isSearchFileItem(value: unknown): value is SearchFileItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.key === "string" &&
    (item.url === null || typeof item.url === "string") &&
    (item.embedUrl === null || typeof item.embedUrl === "string") &&
    typeof item.metadata === "object" &&
    item.metadata !== null
  );
}

/** GET /me/workspaces/:name/files/search — session-authed metadata search. */
export async function searchWorkspaceFiles(
  apiOrigin: string,
  name: string,
  filters: MetaFilter[],
): Promise<SearchFilesResult> {
  const query = buildSearchQuery(filters);
  const url = `${trimOrigin(apiOrigin)}/me/workspaces/${encodeURIComponent(name)}/files/search?${query}`;
  let response: Response;
  try {
    response = await fetch(url, { credentials: "include", cache: "no-store" });
  } catch {
    return { kind: "unavailable", reason: "server" };
  }
  if (!response.ok) return { kind: "unavailable", reason: "server" };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: "unavailable", reason: "malformed" };
  }
  const b = body as { items?: unknown; truncated?: unknown };
  if (
    !Array.isArray(b.items) ||
    typeof b.truncated !== "boolean" ||
    !b.items.every(isSearchFileItem)
  ) {
    return { kind: "unavailable", reason: "malformed" };
  }
  return { kind: "ok", items: b.items, truncated: b.truncated };
}
