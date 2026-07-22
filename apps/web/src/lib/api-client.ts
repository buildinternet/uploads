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
  /**
   * True when the workspace has a stable public custom domain configured.
   * Lets the account file browser (issue #123) decide whether to open a
   * selected file via the public `/f/` page or resolve it through the
   * signed-URL-capable `/me/.../file-url` endpoint instead.
   */
  hasPublicUrl: boolean;
  /** The public base URL itself (e.g. `https://storage.uploads.sh`), when configured. */
  publicBaseUrl?: string;
}

// `hasPublicUrl` is intentionally NOT required here: web and
// api deploy independently, so an older api may omit them. We accept the
// entry and coerce a missing/other value to `false` in the mapper below.
function isMyWorkspaceCore(value: unknown): value is Omit<MyWorkspace, "hasPublicUrl"> {
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

/** Coerce optional/legacy fields; shared by list + summary mappers. */
function mapMyWorkspace(ws: Omit<MyWorkspace, "hasPublicUrl">): MyWorkspace {
  const raw = ws as Omit<MyWorkspace, "hasPublicUrl"> & {
    hasPublicUrl?: unknown;
    publicBaseUrl?: unknown;
  };
  return {
    workspace: raw.workspace,
    organization: raw.organization,
    role: raw.role,
    hasPublicUrl: raw.hasPublicUrl === true,
    publicBaseUrl: typeof raw.publicBaseUrl === "string" ? raw.publicBaseUrl : undefined,
  };
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
    workspaces: body.workspaces.filter(isMyWorkspaceCore).map(mapMyWorkspace),
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

function parseWorkspaceUsage(body: unknown): WorkspaceUsage | null {
  if (
    !body ||
    typeof body !== "object" ||
    typeof (body as WorkspaceUsage).bytes !== "number" ||
    typeof (body as WorkspaceUsage).objects !== "number" ||
    typeof (body as WorkspaceUsage).uploadsInPeriod !== "number"
  ) {
    return null;
  }
  return body as WorkspaceUsage;
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
  return parseWorkspaceUsage(await result.response.json().catch(() => null));
}

export type WorkspaceSummaryResult =
  | {
      kind: "success";
      workspace: MyWorkspace;
      usage: WorkspaceUsage | null;
    }
  | { kind: "unavailable"; reason: RequestFailure | "server" | "malformed" | "not_found" };

/**
 * GET /me/workspaces/:name/summary — membership + public URL + usage for the
 * workspace shell/rail (one authz pass instead of full list + usage).
 */
export async function getWorkspaceSummary(
  apiOrigin: string,
  name: string,
): Promise<WorkspaceSummaryResult> {
  const result = await fetchWithTimeout(
    `${trimOrigin(apiOrigin)}/me/workspaces/${encodeURIComponent(name)}/summary`,
    { credentials: "include", cache: "no-store" },
  );
  if (result.kind === "unavailable") return result;
  const { response } = result;
  if (response.status === 404) return { kind: "unavailable", reason: "not_found" };
  if (!response.ok) return { kind: "unavailable", reason: "server" };
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || !isMyWorkspaceCore(body)) return { kind: "unavailable", reason: "malformed" };
  return {
    kind: "success",
    workspace: mapMyWorkspace(body),
    // `usage` is summary-only; not part of the workspace core shape.
    usage: parseWorkspaceUsage((body as Record<string, unknown>).usage),
  };
}

/**
 * Shared GET for the array-returning `/me/workspaces/:name/<segment>` endpoints
 * (galleries, files). Reads `body[key]`, drops malformed entries via `isValid`,
 * and returns [] on any non-2xx or malformed body.
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
  /** Public `/f/` file-page URL when the workspace has a public base (issue #308). */
  pageUrl?: string;
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
  | {
      kind: "ok";
      invitationId?: string;
      status?: string;
      acceptUrl?: string;
      /** Whether this install can send invite emails; undefined = older auth worker. */
      emailConfigured?: boolean;
    }
  | { kind: "unavailable"; reason: RequestFailure | "server" | "forbidden" | "invalid" };

export interface WorkspaceMember {
  id?: string;
  email: string;
  name: string;
  role: string;
  createdAt?: string;
}

export type WorkspaceMembersResult =
  | { kind: "ok"; members: WorkspaceMember[] }
  | { kind: "unavailable" };

function isMemberCandidate(
  value: unknown,
): value is { email: string; role: string } & Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.email === "string" && typeof row.role === "string";
}

function mapWorkspaceMembers(list: unknown[]): WorkspaceMember[] {
  return list.filter(isMemberCandidate).map((row) => ({
    id: typeof row.id === "string" ? row.id : undefined,
    email: row.email,
    name: typeof row.name === "string" ? row.name : "",
    role: row.role,
    createdAt: typeof row.createdAt === "string" ? row.createdAt : undefined,
  }));
}

/** GET /me/workspaces/:name/members — teammates in the workspace, member-gated. */
export async function getWorkspaceMembers(
  apiOrigin: string,
  name: string,
): Promise<WorkspaceMembersResult> {
  const result = await fetchWithTimeout(
    `${trimOrigin(apiOrigin)}/me/workspaces/${encodeURIComponent(name)}/members`,
    { credentials: "include", cache: "no-store" },
  );
  if (result.kind === "unavailable" || !result.response.ok) return { kind: "unavailable" };
  const body = (await result.response.json().catch(() => null)) as { members?: unknown } | null;
  if (!body || !Array.isArray(body.members)) return { kind: "unavailable" };
  return {
    kind: "ok",
    members: mapWorkspaceMembers(body.members),
  };
}

export type WorkspacePeopleResult =
  | {
      kind: "ok";
      role: string;
      canManage: boolean;
      organization: { id: string; slug: string; name: string };
      members: WorkspaceMember[];
      invites: WorkspaceInvite[];
    }
  | { kind: "unavailable"; reason?: "not_found" | "server" | RequestFailure };

/**
 * GET /me/workspaces/:name/people — members + invites (+ role) for the people
 * tab in one request.
 */
export async function getWorkspacePeople(
  apiOrigin: string,
  name: string,
): Promise<WorkspacePeopleResult> {
  const result = await fetchWithTimeout(
    `${trimOrigin(apiOrigin)}/me/workspaces/${encodeURIComponent(name)}/people`,
    { credentials: "include", cache: "no-store" },
  );
  if (result.kind === "unavailable") return result;
  const { response } = result;
  if (response.status === 404) return { kind: "unavailable", reason: "not_found" };
  if (!response.ok) return { kind: "unavailable", reason: "server" };
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || !Array.isArray(body.members) || typeof body.role !== "string") {
    return { kind: "unavailable", reason: "server" };
  }
  const org = body.organization as Record<string, unknown> | undefined;
  return {
    kind: "ok",
    role: body.role,
    canManage: body.canManage === true,
    organization: {
      id: typeof org?.id === "string" ? org.id : "",
      slug: typeof org?.slug === "string" ? org.slug : name,
      name: typeof org?.name === "string" ? org.name : name,
    },
    members: mapWorkspaceMembers(body.members),
    invites: Array.isArray(body.invites)
      ? body.invites.filter(
          (v): v is WorkspaceInvite =>
            !!v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string",
        )
      : [],
  };
}

export interface WorkspaceBillingLimits {
  maxStorageBytes: number | null;
  maxUploadsPerPeriod: number | null;
  maxUploadBytes: number | null;
  maxVideoUploadBytes: number | null;
}

export interface WorkspaceBilling {
  workspace: string;
  organization: { id: string; slug: string; name: string };
  plan: string;
  available: boolean;
  planApplied: boolean;
  limits: WorkspaceBillingLimits;
  usage: Record<string, unknown> | null;
  subscription: null;
}

export type WorkspaceBillingResult =
  | { kind: "ok"; billing: WorkspaceBilling }
  | { kind: "unavailable"; reason?: "not_found" | "server" | RequestFailure };

/**
 * GET /me/workspaces/:name/billing — plan metadata, resolved effective
 * limits, usage, and (always-null-for-now) subscription for the billing tab.
 */
export async function getWorkspaceBilling(
  apiOrigin: string,
  name: string,
): Promise<WorkspaceBillingResult> {
  const result = await fetchWithTimeout(
    `${trimOrigin(apiOrigin)}/me/workspaces/${encodeURIComponent(name)}/billing`,
    { credentials: "include", cache: "no-store" },
  );
  if (result.kind === "unavailable") return result;
  const { response } = result;
  if (response.status === 404) return { kind: "unavailable", reason: "not_found" };
  if (!response.ok) return { kind: "unavailable", reason: "server" };
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.plan !== "string") {
    return { kind: "unavailable", reason: "server" };
  }
  const org = body.organization as Record<string, unknown> | undefined;
  const rawLimits = (body.limits as Record<string, unknown> | undefined) ?? {};
  const numOrNull = (v: unknown): number | null => (typeof v === "number" ? v : null);
  return {
    kind: "ok",
    billing: {
      workspace: typeof body.workspace === "string" ? body.workspace : name,
      organization: {
        id: typeof org?.id === "string" ? org.id : "",
        slug: typeof org?.slug === "string" ? org.slug : name,
        name: typeof org?.name === "string" ? org.name : name,
      },
      plan: body.plan,
      available: body.available === true,
      planApplied: body.planApplied === true,
      limits: {
        maxStorageBytes: numOrNull(rawLimits.maxStorageBytes),
        maxUploadsPerPeriod: numOrNull(rawLimits.maxUploadsPerPeriod),
        maxUploadBytes: numOrNull(rawLimits.maxUploadBytes),
        maxVideoUploadBytes: numOrNull(rawLimits.maxVideoUploadBytes),
      },
      usage: (body.usage as Record<string, unknown> | null) ?? null,
      subscription: null,
    },
  };
}

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
    emailConfigured?: boolean;
  } | null;
  return {
    kind: "ok",
    invitationId: body?.invitation?.id,
    status: body?.invitation?.status,
    acceptUrl: typeof body?.acceptUrl === "string" ? body.acceptUrl : undefined,
    emailConfigured: typeof body?.emailConfigured === "boolean" ? body.emailConfigured : undefined,
  };
}

export interface WorkspaceInvite {
  id: string;
  email: string;
  role: string | null;
  status: string;
  expiresAt: string | number | null;
}

export type WorkspaceInvitesResult =
  | { kind: "ok"; invites: WorkspaceInvite[] }
  | { kind: "unavailable" };

export type ManageResult =
  | { kind: "ok" }
  | {
      kind: "unavailable";
      reason: RequestFailure | "server" | "forbidden" | "not_found" | "invalid";
    };

function manageResultFor(status: number): ManageResult {
  if (status >= 200 && status < 300) return { kind: "ok" };
  if (status === 403) return { kind: "unavailable", reason: "forbidden" };
  if (status === 404) return { kind: "unavailable", reason: "not_found" };
  if (status === 400) return { kind: "unavailable", reason: "invalid" };
  return { kind: "unavailable", reason: "server" };
}

/** GET /me/workspaces/:name/invites — pending invites, admin/owner only. */
export async function getWorkspaceInvites(
  apiOrigin: string,
  name: string,
): Promise<WorkspaceInvitesResult> {
  const result = await fetchWithTimeout(
    `${trimOrigin(apiOrigin)}/me/workspaces/${encodeURIComponent(name)}/invites`,
    { credentials: "include", cache: "no-store" },
  );
  if (result.kind === "unavailable" || !result.response.ok) return { kind: "unavailable" };
  const body = (await result.response.json().catch(() => null)) as { invites?: unknown } | null;
  if (!body || !Array.isArray(body.invites)) return { kind: "unavailable" };
  return {
    kind: "ok",
    invites: body.invites.filter(
      (v): v is WorkspaceInvite =>
        !!v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string",
    ),
  };
}

async function manageMutation(
  apiOrigin: string,
  path: string,
  init: RequestInit,
): Promise<ManageResult> {
  const result = await fetchWithTimeout(`${trimOrigin(apiOrigin)}${path}`, {
    credentials: "include",
    cache: "no-store",
    ...init,
  });
  if (result.kind === "unavailable") return result;
  return manageResultFor(result.response.status);
}

/** DELETE /me/workspaces/:name/invites/:id */
export async function revokeWorkspaceInvite(
  apiOrigin: string,
  name: string,
  inviteId: string,
): Promise<ManageResult> {
  return manageMutation(
    apiOrigin,
    `/me/workspaces/${encodeURIComponent(name)}/invites/${encodeURIComponent(inviteId)}`,
    { method: "DELETE" },
  );
}

/** DELETE /me/workspaces/:name/members/:memberId */
export async function removeWorkspaceMember(
  apiOrigin: string,
  name: string,
  memberId: string,
): Promise<ManageResult> {
  return manageMutation(
    apiOrigin,
    `/me/workspaces/${encodeURIComponent(name)}/members/${encodeURIComponent(memberId)}`,
    { method: "DELETE" },
  );
}

/** PATCH /me/workspaces/:name/members/:memberId */
export async function updateWorkspaceMemberRole(
  apiOrigin: string,
  name: string,
  memberId: string,
  role: "admin" | "member",
): Promise<ManageResult> {
  return manageMutation(
    apiOrigin,
    `/me/workspaces/${encodeURIComponent(name)}/members/${encodeURIComponent(memberId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    },
  );
}

export type CreateWorkspaceResult =
  | { kind: "created"; workspace: { name: string; publicBaseUrl?: string } }
  | { kind: "error"; code: string; message: string }
  | { kind: "unavailable" };

/** POST /v1/workspaces — self-serve workspace creation (session cookie auth). */
export async function createWorkspace(
  apiOrigin: string,
  name: string,
): Promise<CreateWorkspaceResult> {
  const result = await fetchWithTimeout(`${trimOrigin(apiOrigin)}/v1/workspaces`, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (result.kind === "unavailable") return { kind: "unavailable" };
  const { response } = result;
  const body = (await response.json().catch(() => null)) as {
    workspace?: { name?: string; publicBaseUrl?: string };
    error?: { code?: string; message?: string };
  } | null;
  if (response.ok && typeof body?.workspace?.name === "string") {
    return {
      kind: "created",
      workspace: { name: body.workspace.name, publicBaseUrl: body.workspace.publicBaseUrl },
    };
  }
  return {
    kind: "error",
    code: body?.error?.code ?? "unknown",
    message: body?.error?.message ?? "Workspace creation failed.",
  };
}

export interface SearchFileItem {
  key: string;
  url: string | null;
  embedUrl: string | null;
  metadata: Record<string, string>;
  /** Public `/f/` file-page URL when present (issue #308). */
  pageUrl?: string;
}

export type SearchFilesResult =
  | { kind: "ok"; items: SearchFileItem[]; truncated: boolean }
  | { kind: "unavailable"; reason: RequestFailure | "server" | "malformed" };

function isSearchFileItem(value: unknown): value is SearchFileItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.key === "string" &&
    (item.url === null || typeof item.url === "string") &&
    (item.embedUrl === null || typeof item.embedUrl === "string") &&
    typeof item.metadata === "object" &&
    item.metadata !== null &&
    (item.pageUrl === undefined || typeof item.pageUrl === "string")
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
  const result = await fetchWithTimeout(url, { credentials: "include", cache: "no-store" });
  if (result.kind === "unavailable") return result;
  const { response } = result;
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

export interface GithubTitleInfo {
  title: string;
  state: string;
  kind: "pull" | "issue";
}
export type GithubTitleMap = Record<string, GithubTitleInfo | null>;

/** Server-enforced per-request ref cap on `/me/workspaces/:name/github-titles`. */
export const GITHUB_TITLES_MAX_REFS = 20;

/**
 * Batch PR/issue titles for the connected-work rail (issue #267). `{}` for an
 * empty ref list (no request); null on outage/non-2xx/malformed body — the
 * caller keeps its metadata-derived labels.
 */
export async function getGithubTitles(
  apiOrigin: string,
  name: string,
  refs: string[],
): Promise<GithubTitleMap | null> {
  if (refs.length === 0) return {};
  const qs = encodeURIComponent(refs.slice(0, GITHUB_TITLES_MAX_REFS).join(","));
  const result = await fetchWithTimeout(
    `${trimOrigin(apiOrigin)}/me/workspaces/${encodeURIComponent(name)}/github-titles?refs=${qs}`,
    { credentials: "include", cache: "no-store" },
  );
  if (result.kind === "unavailable" || !result.response.ok) return null;
  const body = (await result.response.json().catch(() => null)) as { refs?: unknown } | null;
  const map = body && typeof body === "object" ? body.refs : null;
  if (!map || typeof map !== "object" || Array.isArray(map)) return null;
  // Per-entry shape check so a malformed payload can't push a non-string
  // label into rail rendering: entries are null or a full TitleInfo.
  for (const entry of Object.values(map)) {
    if (entry === null) continue;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const t = entry as Record<string, unknown>;
    if (typeof t.title !== "string" || typeof t.state !== "string") return null;
    if (t.kind !== "pull" && t.kind !== "issue") return null;
  }
  return map as GithubTitleMap;
}

export interface WorkspaceFolderFile {
  key: string;
  url: string | null;
  embedUrl: string | null;
  size?: number;
  contentType?: string;
  uploaded?: string;
  visibility?: "public" | "private";
  metadata?: Record<string, string>;
  /** Public `/f/` file-page URL when present (issue #308). Prefer for open/copy. */
  pageUrl?: string;
}

export interface WorkspaceFolderListing {
  files: WorkspaceFolderFile[];
  prefixes: string[];
  cursor?: string;
}

/** A fresh empty listing per call — never a shared object, so a caller mutating `files`/`prefixes` can't corrupt later degraded returns. */
function emptyFolderListing(): WorkspaceFolderListing {
  return { files: [], prefixes: [], cursor: undefined };
}

/** A folder listing row only needs a `key` — every other field is coerced defensively below. */
function isWorkspaceFolderFileCandidate(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  return typeof (value as Record<string, unknown>).key === "string";
}

function toWorkspaceFolderFile(raw: Record<string, unknown>): WorkspaceFolderFile {
  return {
    key: raw.key as string,
    // The API's ListedObject types these `string | null` (unconfigured public
    // base URL); pass through as-is so the files table can branch on null for
    // public-vs-private thumbnails rather than treating "" as a real URL.
    url: typeof raw.url === "string" ? raw.url : null,
    embedUrl: typeof raw.embedUrl === "string" ? raw.embedUrl : null,
    size: typeof raw.size === "number" ? raw.size : undefined,
    contentType: typeof raw.contentType === "string" ? raw.contentType : undefined,
    uploaded: typeof raw.uploaded === "string" ? raw.uploaded : undefined,
    visibility:
      raw.visibility === "public" || raw.visibility === "private" ? raw.visibility : undefined,
    metadata:
      raw.metadata && typeof raw.metadata === "object"
        ? (raw.metadata as Record<string, string>)
        : undefined,
    pageUrl: typeof raw.pageUrl === "string" && raw.pageUrl ? raw.pageUrl : undefined,
  };
}

/**
 * GET /me/workspaces/:name/files?prefix=&cursor=&limit= — folder-aware,
 * gh.*-metadata-hydrated workspace file listing (commit 0f9ac65). Backs the
 * settings-page files tab's folder browser, so like {@link fetchWorkspaceList}
 * this is a "less central" detail helper: any transport failure, non-2xx, or
 * malformed body degrades to an empty listing rather than surfacing an outage.
 *
 * The API returns `cursor` as `string | null`; normalized here to
 * `string | undefined`. Likewise `prefixes` defaults to `[]` when the API
 * omits it (non-delimited listings).
 */
export async function listWorkspaceFolder(
  apiOrigin: string,
  workspace: string,
  opts: { prefix?: string; cursor?: string; limit?: number } = {},
): Promise<WorkspaceFolderListing> {
  const params = new URLSearchParams();
  // Always list one folder level at a time — without the delimiter the API
  // returns a flat recursive listing and no `prefixes` (folders).
  params.set("delimiter", "/");
  if (opts.prefix !== undefined) params.set("prefix", opts.prefix);
  if (opts.cursor !== undefined) params.set("cursor", opts.cursor);
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  const query = params.toString();
  const url = `${trimOrigin(apiOrigin)}/me/workspaces/${encodeURIComponent(workspace)}/files${query ? `?${query}` : ""}`;

  const result = await fetchWithTimeout(url, { credentials: "include", cache: "no-store" });
  if (result.kind === "unavailable" || !result.response.ok) return emptyFolderListing();

  const body = (await result.response.json().catch(() => null)) as {
    files?: unknown;
    prefixes?: unknown;
    cursor?: unknown;
  } | null;
  if (!body) return emptyFolderListing();

  return {
    files: Array.isArray(body.files)
      ? body.files.filter(isWorkspaceFolderFileCandidate).map(toWorkspaceFolderFile)
      : [],
    prefixes: Array.isArray(body.prefixes)
      ? body.prefixes.filter((p) => typeof p === "string")
      : [],
    cursor: typeof body.cursor === "string" ? body.cursor : undefined,
  };
}
