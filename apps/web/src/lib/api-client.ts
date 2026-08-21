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
  /**
   * Catalog plan id ("free" | "pro" | …) — additive, issue #365 follow-up.
   * Same fail-open-to-"free" contract as the billing tab's `planResponse`:
   * a legacy/unapplied workspace record always reads as "free" here, never
   * "pro". Undefined only against an older api build that omits the field.
   */
  plan?: string;
}

/**
 * The fields every api build has always sent. `hasPublicUrl`/`plan`
 * are deliberately excluded: web and api deploy independently, so an older api
 * may omit them — the entry is still accepted and `mapMyWorkspace` coerces each
 * missing value to a safe default.
 */
type MyWorkspaceCore = Omit<MyWorkspace, "hasPublicUrl" | "plan">;

function isMyWorkspaceCore(value: unknown): value is MyWorkspaceCore {
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
function mapMyWorkspace(ws: MyWorkspaceCore): MyWorkspace {
  const raw = ws as MyWorkspaceCore & {
    hasPublicUrl?: unknown;
    publicBaseUrl?: unknown;
    plan?: unknown;
  };
  return {
    workspace: raw.workspace,
    organization: raw.organization,
    role: raw.role,
    hasPublicUrl: raw.hasPublicUrl === true,
    publicBaseUrl: typeof raw.publicBaseUrl === "string" ? raw.publicBaseUrl : undefined,
    plan: typeof raw.plan === "string" ? raw.plan : undefined,
  };
}

/**
 * Whether this user may create another workspace (spec 2026-07-24). Purely
 * advisory — `POST /v1/workspaces` is the enforcement point, so the UI is
 * free to fail open when this is missing.
 */
export interface WorkspaceCreateQuota {
  used: number;
  cap: number;
  allowed: boolean;
}

export type WorkspacesResult =
  | { kind: "success"; workspaces: MyWorkspace[]; quota?: WorkspaceCreateQuota }
  | { kind: "unavailable"; reason: RequestFailure | "server" | "malformed" };

/**
 * Parse `workspaceCreate` from a `/me/workspaces` body.
 *
 * Returns `undefined` for anything unrecognized — an older API build that
 * omits the field, a partial response, a garbage value. Every consumer
 * treats `undefined` as "creation allowed", so a stale worker degrades to
 * the pre-cap behaviour (create offered, server still refusing at the cap)
 * rather than locking a user out of a workspace they are entitled to.
 */
export function parseWorkspaceCreateQuota(value: unknown): WorkspaceCreateQuota | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const { used, cap, allowed } = raw;
  if (typeof used !== "number" || typeof cap !== "number" || typeof allowed !== "boolean") {
    return undefined;
  }
  if (!Number.isFinite(used) || !Number.isFinite(cap)) return undefined;
  return { used, cap, allowed };
}

/** GET /me/workspaces, preserving an outage rather than rendering it as an empty account. */
export async function getMyWorkspaces(
  apiOrigin: string,
  opts?: { cookie?: string },
): Promise<WorkspacesResult> {
  const result = await fetchWithTimeout(
    `${trimOrigin(apiOrigin)}/me/workspaces`,
    sessionFetchInit(opts?.cookie),
  );
  if (result.kind === "unavailable") return result;
  const { response } = result;
  if (!response.ok) return { kind: "unavailable", reason: "server" };
  const body = (await response.json().catch(() => undefined)) as
    | { workspaces?: unknown[]; workspaceCreate?: unknown }
    | undefined;
  if (!body || !Array.isArray(body.workspaces)) return { kind: "unavailable", reason: "malformed" };
  return {
    kind: "success",
    workspaces: body.workspaces.filter(isMyWorkspaceCore).map(mapMyWorkspace),
    quota: parseWorkspaceCreateQuota(body.workspaceCreate),
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

/** GET /v1/workspaces/:name/usage. Returns null on any non-2xx or malformed body. */
export async function getMyWorkspaceUsage(
  apiOrigin: string,
  name: string,
): Promise<WorkspaceUsage | null> {
  const result = await fetchWithTimeout(
    `${trimOrigin(apiOrigin)}/v1/workspaces/${encodeURIComponent(name)}/usage`,
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
 * GET /v1/workspaces/:name/summary — membership + public URL + usage for the
 * workspace shell/rail (one authz pass instead of full list + usage).
 */
export async function getWorkspaceSummary(
  apiOrigin: string,
  name: string,
  opts?: { cookie?: string },
): Promise<WorkspaceSummaryResult> {
  const result = await fetchWithTimeout(
    `${trimOrigin(apiOrigin)}/v1/workspaces/${encodeURIComponent(name)}/summary`,
    sessionFetchInit(opts?.cookie),
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
 * Shared GET for the array-returning `/v1/workspaces/:name/<segment>` endpoints
 * (galleries). Reads `body[key]`, drops malformed entries via `isValid`,
 * and returns [] on any non-2xx or malformed body.
 */
async function fetchWorkspaceList<T>(
  apiOrigin: string,
  name: string,
  segment: string,
  key: string,
  isValid: (value: unknown) => value is T,
  opts?: { cookie?: string },
): Promise<T[]> {
  const result = await fetchWithTimeout(
    `${trimOrigin(apiOrigin)}/v1/workspaces/${encodeURIComponent(name)}/${segment}`,
    sessionFetchInit(opts?.cookie),
  );
  if (result.kind === "unavailable" || !result.response.ok) return [];
  const body = (await result.response.json().catch(() => null)) as Record<string, unknown> | null;
  const list = body?.[key];
  return Array.isArray(list) ? list.filter(isValid) : [];
}

export interface GalleryReferenceSummary {
  provider: string;
  resourceType: string;
  coordinate: string;
  canonicalUrl: string | null;
}

export interface GallerySummary {
  id: string;
  url: string;
  title: string;
  description: string | null;
  coverItemId: string | null;
  createdAt: string;
  updatedAt: string;
  /** Omitted on older API deployments. */
  itemCount?: number;
  references?: GalleryReferenceSummary[];
  /**
   * Public URL of the gallery's cover image for a list/grid thumbnail. `null`
   * when the gallery is empty or its cover isn't a still image; omitted on
   * older API deployments that predate the field.
   */
  previewUrl?: string | null;
}

function isGalleryReferenceSummary(value: unknown): value is GalleryReferenceSummary {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.provider === "string" &&
    typeof r.resourceType === "string" &&
    typeof r.coordinate === "string" &&
    (r.canonicalUrl === null || typeof r.canonicalUrl === "string")
  );
}

function isGallerySummary(value: unknown): value is GallerySummary {
  if (!value || typeof value !== "object") return false;
  const g = value as Record<string, unknown>;
  if (typeof g.id !== "string" || typeof g.url !== "string" || typeof g.title !== "string") {
    return false;
  }
  if (g.itemCount !== undefined && typeof g.itemCount !== "number") return false;
  if (g.previewUrl !== undefined && g.previewUrl !== null && typeof g.previewUrl !== "string") {
    return false;
  }
  if (g.references !== undefined) {
    if (!Array.isArray(g.references) || !g.references.every(isGalleryReferenceSummary)) {
      return false;
    }
  }
  return true;
}

/** GET /v1/workspaces/:name/galleries. See {@link fetchWorkspaceList}. */
export function getMyWorkspaceGalleries(
  apiOrigin: string,
  name: string,
  opts?: { cookie?: string },
): Promise<GallerySummary[]> {
  return fetchWorkspaceList(apiOrigin, name, "galleries", "galleries", isGallerySummary, opts);
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

/**
 * GET /v1/workspaces/:name/files. Same contract as {@link fetchWorkspaceList}
 * but on the canonical dual-auth surface rather than `/me`.
 */
export async function getMyWorkspaceFiles(
  apiOrigin: string,
  name: string,
  opts?: { cookie?: string },
): Promise<WorkspaceFile[]> {
  const result = await fetchWithTimeout(
    `${trimOrigin(apiOrigin)}/v1/workspaces/${encodeURIComponent(name)}/files`,
    sessionFetchInit(opts?.cookie),
  );
  if (result.kind === "unavailable" || !result.response.ok) return [];
  const body = (await result.response.json().catch(() => null)) as Record<string, unknown> | null;
  const list = body?.files;
  return Array.isArray(list) ? list.filter(isWorkspaceFile) : [];
}

export type FileVisibility = "public" | "private";

export type SetFileVisibilityResult =
  | { kind: "success"; visibility: FileVisibility }
  | { kind: "unavailable"; reason: RequestFailure | "server" | "malformed" };

/**
 * PATCH /v1/workspaces/:name/files/visibility — toggles a file's private flag
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
    `${trimOrigin(apiOrigin)}/v1/workspaces/${encodeURIComponent(name)}/files/visibility?key=${encodeURIComponent(key)}`,
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

export type DeleteWorkspaceFileResult =
  | { kind: "success" }
  | { kind: "unavailable"; reason: RequestFailure | "server" };

/**
 * DELETE /v1/workspaces/:name/files/<keyPath> — permanently deletes a file
 * (spec 2026-07-30). Unlike the legacy `/me` alias, the canonical route keys
 * the file off path segments rather than a `?key=` query param: each `/`
 * separated component of `key` is percent-encoded individually and joined
 * back with `/`, matching the API's own alias rewrite (apps/api/src/routes/me.ts).
 */
export async function deleteWorkspaceFile(
  apiOrigin: string,
  name: string,
  key: string,
): Promise<DeleteWorkspaceFileResult> {
  const keyPath = key.split("/").map(encodeURIComponent).join("/");
  const result = await fetchWithTimeout(
    `${trimOrigin(apiOrigin)}/v1/workspaces/${encodeURIComponent(name)}/files/${keyPath}`,
    { method: "DELETE", credentials: "include", cache: "no-store" },
  );
  if (result.kind === "unavailable") return result;
  if (!result.response.ok) return { kind: "unavailable", reason: "server" };
  return { kind: "success" };
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
  | {
      kind: "unavailable";
      reason: RequestFailure | "server" | "forbidden" | "invalid" | "member_cap";
      /** Server-authored copy, present for "member_cap": the workspace's real
       * cap and (on free) the upgrade nudge. Shown verbatim rather than
       * restated here, since only the API knows the resolved number. */
      message?: string;
    };

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

/** GET /v1/workspaces/:name/members — teammates in the workspace, member-gated. */
export async function getWorkspaceMembers(
  apiOrigin: string,
  name: string,
): Promise<WorkspaceMembersResult> {
  const result = await fetchWithTimeout(
    `${trimOrigin(apiOrigin)}/v1/workspaces/${encodeURIComponent(name)}/members`,
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
 * GET /v1/workspaces/:name/people — members + invites (+ role) for the people
 * tab in one request.
 */
export async function getWorkspacePeople(
  apiOrigin: string,
  name: string,
  opts?: { cookie?: string },
): Promise<WorkspacePeopleResult> {
  const result = await fetchWithTimeout(
    `${trimOrigin(apiOrigin)}/v1/workspaces/${encodeURIComponent(name)}/people`,
    sessionFetchInit(opts?.cookie),
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

/** Issue #445: "stripe" when an active Stripe subscription backs the plan,
 * "admin" when the plan is paid but comped/admin-set with no such
 * subscription, "none" on free with no subscription. */
export type WorkspacePlanSource = "stripe" | "admin" | "none";

export interface WorkspaceSubscription {
  status: string;
  periodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

export interface WorkspaceBilling {
  workspace: string;
  organization: { id: string; slug: string; name: string };
  plan: string;
  available: boolean;
  planApplied: boolean;
  limits: WorkspaceBillingLimits;
  usage: Record<string, unknown> | null;
  /** Issue #445: additive fields — see GET /v1/workspaces/:name/billing. */
  planSource: WorkspacePlanSource;
  subscription: WorkspaceSubscription | null;
}

export type WorkspaceBillingResult =
  | { kind: "ok"; billing: WorkspaceBilling }
  | { kind: "unavailable"; reason?: "not_found" | "server" | RequestFailure };

/**
 * GET /v1/workspaces/:name/billing — plan metadata, resolved effective
 * limits, usage, and (always-null-for-now) subscription for the billing tab.
 */
export async function getWorkspaceBilling(
  apiOrigin: string,
  name: string,
  opts?: { cookie?: string },
): Promise<WorkspaceBillingResult> {
  const result = await fetchWithTimeout(
    `${trimOrigin(apiOrigin)}/v1/workspaces/${encodeURIComponent(name)}/billing`,
    sessionFetchInit(opts?.cookie),
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
      planSource:
        body.planSource === "stripe" || body.planSource === "admin" || body.planSource === "none"
          ? body.planSource
          : "none",
      subscription: (() => {
        const raw = body.subscription as Record<string, unknown> | null | undefined;
        if (!raw || typeof raw.status !== "string") return null;
        return {
          status: raw.status,
          periodEnd: typeof raw.periodEnd === "string" ? raw.periodEnd : null,
          cancelAtPeriodEnd: raw.cancelAtPeriodEnd === true,
        };
      })(),
    },
  };
}

/**
 * POST /v1/workspaces/:name/invites — workspace admin|owner invites an email.
 * Always prefer showing `acceptUrl` (works without outbound email).
 */
export async function inviteToWorkspace(
  apiOrigin: string,
  name: string,
  email: string,
): Promise<InviteResult> {
  const result = await fetchWithTimeout(
    `${trimOrigin(apiOrigin)}/v1/workspaces/${encodeURIComponent(name)}/invites`,
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
  if (response.status === 403) {
    // Two different 403s: a plan member cap (issue #450), which the user can
    // act on, and the pre-existing "you aren't an admin here".
    const error = (await response.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    if (error?.error?.code === "member_cap_reached") {
      return { kind: "unavailable", reason: "member_cap", message: error.error.message };
    }
    return { kind: "unavailable", reason: "forbidden" };
  }
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

/** GET /v1/workspaces/:name/invites — pending invites, admin/owner only. */
export async function getWorkspaceInvites(
  apiOrigin: string,
  name: string,
): Promise<WorkspaceInvitesResult> {
  const result = await fetchWithTimeout(
    `${trimOrigin(apiOrigin)}/v1/workspaces/${encodeURIComponent(name)}/invites`,
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

/** DELETE /v1/workspaces/:name/invites/:id */
export async function revokeWorkspaceInvite(
  apiOrigin: string,
  name: string,
  inviteId: string,
): Promise<ManageResult> {
  return manageMutation(
    apiOrigin,
    `/v1/workspaces/${encodeURIComponent(name)}/invites/${encodeURIComponent(inviteId)}`,
    { method: "DELETE" },
  );
}

/** DELETE /v1/workspaces/:name/members/:memberId */
export async function removeWorkspaceMember(
  apiOrigin: string,
  name: string,
  memberId: string,
): Promise<ManageResult> {
  return manageMutation(
    apiOrigin,
    `/v1/workspaces/${encodeURIComponent(name)}/members/${encodeURIComponent(memberId)}`,
    { method: "DELETE" },
  );
}

/** PATCH /v1/workspaces/:name/members/:memberId */
export async function updateWorkspaceMemberRole(
  apiOrigin: string,
  name: string,
  memberId: string,
  role: "admin" | "member",
): Promise<ManageResult> {
  return manageMutation(
    apiOrigin,
    `/v1/workspaces/${encodeURIComponent(name)}/members/${encodeURIComponent(memberId)}`,
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
  /** Newest metadata-write time — the shot's upload time for the pop-over. */
  updatedAt?: string;
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
    (item.pageUrl === undefined || typeof item.pageUrl === "string") &&
    (item.updatedAt === undefined || typeof item.updatedAt === "string")
  );
}

/** GET /v1/workspaces/:name/files/search — session-authed metadata + name search. */
export async function searchWorkspaceFiles(
  apiOrigin: string,
  name: string,
  filters: MetaFilter[],
  opts: { name?: string; collapsePromoted?: boolean } = {},
): Promise<SearchFilesResult> {
  const params = new URLSearchParams(buildSearchQuery(filters));
  if (opts.name) params.set("name", opts.name);
  // Collapse promoted branch originals into their canonical pull/<n> copy so a
  // screenshot isn't listed twice (server-side; the API leaves general search
  // untouched).
  if (opts.collapsePromoted) params.set("collapse", "promoted");
  const url = `${trimOrigin(apiOrigin)}/v1/workspaces/${encodeURIComponent(name)}/files/search?${params.toString()}`;
  const result = await fetchWithTimeout(url, { credentials: "include", cache: "no-store" });
  if (result.kind === "unavailable") return result;
  const { response } = result;
  if (!response.ok) return { kind: "unavailable", reason: "server" };
  const body = (await response.json().catch(() => null)) as {
    items?: unknown;
    truncated?: unknown;
  } | null;
  if (
    !body ||
    !Array.isArray(body.items) ||
    typeof body.truncated !== "boolean" ||
    !body.items.every(isSearchFileItem)
  ) {
    return { kind: "unavailable", reason: "malformed" };
  }
  return { kind: "ok", items: body.items, truncated: body.truncated };
}

/** One recent upload inside a `by-path` group. */
export interface PathGroupItem {
  key: string;
  url: string | null;
  embedUrl: string | null;
  /** Present only when the file carries `state` metadata (e.g. before/after). */
  state?: string;
  /** Present only when the file is attached to a GitHub PR/issue. */
  ghKind?: string;
  ghNumber?: string;
  /** `owner/repo#n` — lets the pop-over resolve live PR/issue status. */
  ghRef?: string;
  /** Newest metadata-write time — the shot's upload time for the pop-over. */
  updatedAt?: string;
}

/** One `path` metadata value with its recent uploads. */
export interface FilesPathGroup {
  project: string;
  path: string;
  count: number;
  lastUpdated: string;
  recent: PathGroupItem[];
}

/** One unique (project, path) pair without thumbs — the filter-bar catalog. */
export interface PathCatalogEntry {
  project: string;
  path: string;
  count: number;
  lastUpdated: string;
}

/** One shot in the flat newest-first feed (the "Recent" view). */
export interface LatestShotItem extends PathGroupItem {
  project: string;
  path: string;
  uploadedAt: string;
}

/** One project bucket summary alongside the by-path groups. */
export interface ProjectSummary {
  label: string;
  count: number;
  lastUpdated: string;
}

export type FilesByPathResult =
  | {
      kind: "ok";
      groups: FilesPathGroup[];
      catalog: PathCatalogEntry[];
      projects: ProjectSummary[];
      latest: LatestShotItem[];
      truncated: boolean;
      catalogTruncated: boolean;
    }
  | { kind: "unavailable"; reason: RequestFailure | "server" | "malformed" };

function isPathGroupItem(value: unknown): value is PathGroupItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.key === "string" &&
    (item.url === null || typeof item.url === "string") &&
    (item.embedUrl === null || typeof item.embedUrl === "string") &&
    (item.state === undefined || typeof item.state === "string") &&
    (item.ghKind === undefined || typeof item.ghKind === "string") &&
    (item.ghNumber === undefined || typeof item.ghNumber === "string") &&
    (item.ghRef === undefined || typeof item.ghRef === "string") &&
    (item.updatedAt === undefined || typeof item.updatedAt === "string")
  );
}

function isFilesPathGroup(value: unknown): value is FilesPathGroup {
  if (!value || typeof value !== "object") return false;
  const group = value as Record<string, unknown>;
  return (
    typeof group.project === "string" &&
    typeof group.path === "string" &&
    typeof group.count === "number" &&
    typeof group.lastUpdated === "string" &&
    Array.isArray(group.recent) &&
    group.recent.every(isPathGroupItem)
  );
}

function isProjectSummary(value: unknown): value is ProjectSummary {
  if (!value || typeof value !== "object") return false;
  const project = value as Record<string, unknown>;
  return (
    typeof project.label === "string" &&
    typeof project.count === "number" &&
    typeof project.lastUpdated === "string"
  );
}

function isPathCatalogEntry(value: unknown): value is PathCatalogEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.project === "string" &&
    typeof entry.path === "string" &&
    typeof entry.count === "number" &&
    typeof entry.lastUpdated === "string"
  );
}

function isLatestShotItem(value: unknown): value is LatestShotItem {
  if (!isPathGroupItem(value)) return false;
  const item = value as unknown as Record<string, unknown>;
  return (
    typeof item.project === "string" &&
    typeof item.path === "string" &&
    typeof item.uploadedAt === "string"
  );
}

/** Derive a catalog from thumbed groups when an older API omitted it. */
function catalogFromGroups(groups: FilesPathGroup[]): PathCatalogEntry[] {
  return groups.map(({ project, path, count, lastUpdated }) => ({
    project,
    path,
    count,
    lastUpdated,
  }));
}

/** GET /v1/workspaces/:name/files/by-path — recent uploads grouped by `path` metadata. */
export async function getWorkspaceFilesByPath(
  apiOrigin: string,
  name: string,
  opts?: { cookie?: string },
): Promise<FilesByPathResult> {
  const url = `${trimOrigin(apiOrigin)}/v1/workspaces/${encodeURIComponent(name)}/files/by-path`;
  const result = await fetchWithTimeout(url, sessionFetchInit(opts?.cookie));
  if (result.kind === "unavailable") return result;
  const { response } = result;
  if (!response.ok) return { kind: "unavailable", reason: "server" };
  const body = (await response.json().catch(() => null)) as {
    groups?: unknown;
    catalog?: unknown;
    projects?: unknown;
    latest?: unknown;
    truncated?: unknown;
    catalogTruncated?: unknown;
  } | null;
  if (
    !body ||
    !Array.isArray(body.groups) ||
    !Array.isArray(body.projects) ||
    typeof body.truncated !== "boolean" ||
    !body.groups.every(isFilesPathGroup) ||
    !body.projects.every(isProjectSummary)
  ) {
    return { kind: "unavailable", reason: "malformed" };
  }
  // Catalog is additive: an older API (web/API deploy separately) omitted it.
  // Fall back to the thumbed groups so the filter bar still has something
  // to search, and treat `truncated` as the catalog cap in that case.
  // `latest` is additive too (older API deploys omit it) — the toggle just
  // has an empty Recent view until the API catches up.
  const latest =
    Array.isArray(body.latest) && body.latest.every(isLatestShotItem) ? body.latest : [];
  if (body.catalog === undefined) {
    return {
      kind: "ok",
      groups: body.groups,
      catalog: catalogFromGroups(body.groups),
      projects: body.projects,
      latest,
      truncated: body.truncated,
      catalogTruncated: body.truncated,
    };
  }
  if (!Array.isArray(body.catalog) || !body.catalog.every(isPathCatalogEntry)) {
    return { kind: "unavailable", reason: "malformed" };
  }
  return {
    kind: "ok",
    groups: body.groups,
    catalog: body.catalog,
    projects: body.projects,
    latest,
    truncated: body.truncated,
    catalogTruncated: typeof body.catalogTruncated === "boolean" ? body.catalogTruncated : false,
  };
}

/** One metadata key present in a workspace, with its file and value counts. */
export interface FacetKey {
  key: string;
  count: number;
  distinctValues: number;
}

/** One value of a metadata key, with how many files carry it. */
export interface FacetValue {
  value: string;
  count: number;
}

export type FacetKeysResult =
  | { kind: "ok"; keys: FacetKey[]; truncated: boolean }
  | { kind: "unavailable" };

export type FacetValuesResult =
  | { kind: "ok"; values: FacetValue[]; truncated: boolean }
  | { kind: "unavailable" };

function isFacetKey(value: unknown): value is FacetKey {
  const row = value as Record<string, unknown>;
  return (
    !!row &&
    typeof row.key === "string" &&
    typeof row.count === "number" &&
    typeof row.distinctValues === "number"
  );
}

function isFacetValue(value: unknown): value is FacetValue {
  const row = value as Record<string, unknown>;
  return !!row && typeof row.value === "string" && typeof row.count === "number";
}

/**
 * GET /v1/workspaces/:name/files/facets — which metadata keys this workspace
 * contains. A single `unavailable` kind (no `reason`) is enough here: the
 * filter bar degrades to its syntax hint either way and never surfaces the
 * distinction, unlike a search failure which the user must be told about.
 */
export async function getWorkspaceFacets(
  apiOrigin: string,
  name: string,
): Promise<FacetKeysResult> {
  const url = `${trimOrigin(apiOrigin)}/v1/workspaces/${encodeURIComponent(name)}/files/facets`;
  const result = await fetchWithTimeout(url, { credentials: "include", cache: "no-store" });
  if (result.kind === "unavailable" || !result.response.ok) return { kind: "unavailable" };
  const body = (await result.response.json().catch(() => null)) as {
    keys?: unknown;
    truncated?: unknown;
  } | null;
  if (
    !body ||
    !Array.isArray(body.keys) ||
    typeof body.truncated !== "boolean" ||
    !body.keys.every(isFacetKey)
  ) {
    return { kind: "unavailable" };
  }
  return { kind: "ok", keys: body.keys, truncated: body.truncated };
}

/** GET /v1/workspaces/:name/files/facets?key= — one key's values. */
export async function getWorkspaceFacetValues(
  apiOrigin: string,
  name: string,
  key: string,
): Promise<FacetValuesResult> {
  const url = `${trimOrigin(apiOrigin)}/v1/workspaces/${encodeURIComponent(name)}/files/facets?key=${encodeURIComponent(key)}`;
  const result = await fetchWithTimeout(url, { credentials: "include", cache: "no-store" });
  if (result.kind === "unavailable" || !result.response.ok) return { kind: "unavailable" };
  const body = (await result.response.json().catch(() => null)) as {
    values?: unknown;
    truncated?: unknown;
  } | null;
  if (
    !body ||
    !Array.isArray(body.values) ||
    typeof body.truncated !== "boolean" ||
    !body.values.every(isFacetValue)
  ) {
    return { kind: "unavailable" };
  }
  return { kind: "ok", values: body.values, truncated: body.truncated };
}

export interface GithubTitleInfo {
  title: string;
  state: string;
  kind: "pull" | "issue";
}
export type GithubTitleMap = Record<string, GithubTitleInfo | null>;

/** Server-enforced per-request ref cap on `/v1/workspaces/:name/github/titles`. */
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
    `${trimOrigin(apiOrigin)}/v1/workspaces/${encodeURIComponent(name)}/github/titles?refs=${qs}`,
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

/**
 * Whether this workspace already has the GitHub App installed (issue #492) —
 * `true` only on an explicit `installed: true`. Every other outcome (outage,
 * non-2xx, malformed body, App not configured) is `false`, which keeps the
 * rail's install CTA visible: nagging an installed workspace is cheaper than
 * hiding the CTA from one that never installed.
 */
export async function getGithubInstalled(apiOrigin: string, name: string): Promise<boolean> {
  const result = await fetchWithTimeout(
    `${trimOrigin(apiOrigin)}/v1/workspaces/${encodeURIComponent(name)}/github/status`,
    { credentials: "include", cache: "no-store" },
  );
  if (result.kind === "unavailable" || !result.response.ok) return false;
  const body = (await result.response.json().catch(() => null)) as { installed?: unknown } | null;
  return body?.installed === true;
}

/**
 * A workspace name to prefill for an account that has none yet (issue #506),
 * derived server-side from the user's GitHub login. Empty string for "offer
 * nothing" — no linked GitHub account, a login that can't become a valid slug,
 * a reserved or blocklisted name, or one already taken. Every failure mode is
 * indistinguishable here on purpose: the caller either has a name to prefill
 * or doesn't, and an empty field is the pre-#506 behavior.
 */
export async function getSuggestedWorkspaceName(apiOrigin: string): Promise<string> {
  const result = await fetchWithTimeout(`${trimOrigin(apiOrigin)}/v1/tokens`, {
    credentials: "include",
    cache: "no-store",
  });
  if (result.kind === "unavailable" || !result.response.ok) return "";
  const body = (await result.response.json().catch(() => null)) as {
    suggestedWorkspace?: unknown;
  } | null;
  return typeof body?.suggestedWorkspace === "string" ? body.suggestedWorkspace : "";
}

/** Matches `DEFAULT_TOKEN_SECONDS` / `MAX_TOKEN_SECONDS` in apps/api. */
export const WORKSPACE_TOKEN_TTL_90_DAYS = 90 * 24 * 60 * 60;
export const WORKSPACE_TOKEN_TTL_1_YEAR = 365 * 24 * 60 * 60;

export interface MintableWorkspace {
  workspace: string;
  role: string;
}

export interface IssuedWorkspaceToken {
  id: string;
  workspace: string;
  label: string | null;
  scopes: string[];
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
}

export type MintWorkspaceTokenResult =
  | {
      ok: true;
      token: string;
      workspace: string;
      scopes: string[];
      label: string | null;
      expiresAt: string | null;
    }
  | { ok: false; message: string };

function asMintableWorkspace(value: unknown): MintableWorkspace | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.workspace !== "string" || typeof row.role !== "string") return null;
  return { workspace: row.workspace, role: row.role };
}

function asIssuedWorkspaceToken(value: unknown): IssuedWorkspaceToken | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || typeof row.workspace !== "string") return null;
  if (typeof row.createdAt !== "string") return null;
  if (row.expiresAt !== null && typeof row.expiresAt !== "string") return null;
  if (row.label !== null && typeof row.label !== "string") return null;
  if (!Array.isArray(row.scopes) || !row.scopes.every((s) => typeof s === "string")) return null;
  return {
    id: row.id,
    workspace: row.workspace,
    label: row.label ?? null,
    scopes: row.scopes,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt ?? null,
    lastUsedAt: typeof row.lastUsedAt === "string" ? row.lastUsedAt : null,
  };
}

/** Parse GET /v1/tokens — workspaces this session can mint for. */
export function parseMintableWorkspaces(body: unknown): MintableWorkspace[] | null {
  if (!body || typeof body !== "object") return null;
  const rows = (body as { workspaces?: unknown }).workspaces;
  if (!Array.isArray(rows)) return null;
  const out: MintableWorkspace[] = [];
  for (const row of rows) {
    const parsed = asMintableWorkspace(row);
    if (!parsed) return null;
    out.push(parsed);
  }
  return out;
}

/** Parse GET /v1/tokens/issued. */
export function parseIssuedWorkspaceTokens(body: unknown): IssuedWorkspaceToken[] | null {
  if (!body || typeof body !== "object") return null;
  const rows = (body as { tokens?: unknown }).tokens;
  if (!Array.isArray(rows)) return null;
  const out: IssuedWorkspaceToken[] = [];
  for (const row of rows) {
    const parsed = asIssuedWorkspaceToken(row);
    if (!parsed) return null;
    out.push(parsed);
  }
  return out;
}

function sessionFetchInit(cookie?: string): RequestInit {
  return {
    credentials: "include",
    cache: "no-store",
    ...(cookie ? { headers: { cookie } } : {}),
  };
}

/** GET /v1/tokens — workspaces the signed-in user can mint a token for. */
export async function listMintableWorkspaces(
  apiOrigin: string,
  opts?: { cookie?: string },
): Promise<MintableWorkspace[] | null> {
  const result = await fetchWithTimeout(
    `${trimOrigin(apiOrigin)}/v1/tokens`,
    sessionFetchInit(opts?.cookie),
  );
  if (result.kind === "unavailable" || !result.response.ok) return null;
  const body = await result.response.json().catch(() => undefined);
  return parseMintableWorkspaces(body);
}

/** GET /v1/tokens/issued — tokens this session user minted. */
export async function listIssuedWorkspaceTokens(
  apiOrigin: string,
  opts?: { cookie?: string },
): Promise<IssuedWorkspaceToken[] | null> {
  const result = await fetchWithTimeout(
    `${trimOrigin(apiOrigin)}/v1/tokens/issued`,
    sessionFetchInit(opts?.cookie),
  );
  if (result.kind === "unavailable" || !result.response.ok) return null;
  const body = await result.response.json().catch(() => undefined);
  return parseIssuedWorkspaceTokens(body);
}

/** POST /v1/tokens — mint a `up_<workspace>_` token. Secret is returned once. */
export async function mintWorkspaceToken(
  apiOrigin: string,
  input: {
    workspace: string;
    label?: string;
    ttlSeconds?: number | null;
    scopes?: string[];
  },
): Promise<MintWorkspaceTokenResult> {
  const result = await fetchWithTimeout(`${trimOrigin(apiOrigin)}/v1/tokens`, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grants: [
        {
          workspace: input.workspace,
          ...(input.scopes ? { scopes: input.scopes } : {}),
        },
      ],
      ...(input.label ? { label: input.label } : {}),
      ...(input.ttlSeconds !== undefined ? { ttlSeconds: input.ttlSeconds } : {}),
    }),
  });
  if (result.kind === "unavailable") {
    return { ok: false, message: "The API is unreachable right now — try again shortly." };
  }
  const body = (await result.response.json().catch(() => null)) as {
    token?: unknown;
    workspace?: unknown;
    scopes?: unknown;
    label?: unknown;
    expiresAt?: unknown;
    error?: { message?: string };
  } | null;
  if (!result.response.ok) {
    return { ok: false, message: body?.error?.message ?? "Could not create a workspace token." };
  }
  if (typeof body?.token !== "string" || typeof body.workspace !== "string") {
    return { ok: false, message: "API returned a malformed workspace token." };
  }
  return {
    ok: true,
    token: body.token,
    workspace: body.workspace,
    scopes: Array.isArray(body.scopes)
      ? body.scopes.filter((s): s is string => typeof s === "string")
      : [],
    label: typeof body.label === "string" ? body.label : null,
    expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : null,
  };
}

/** DELETE /v1/tokens/:id — revoke a token this session user minted. */
export async function revokeIssuedWorkspaceToken(
  apiOrigin: string,
  tokenId: string,
): Promise<boolean> {
  const result = await fetchWithTimeout(
    `${trimOrigin(apiOrigin)}/v1/tokens/${encodeURIComponent(tokenId)}`,
    { method: "DELETE", credentials: "include", cache: "no-store" },
  );
  return result.kind !== "unavailable" && result.response.ok;
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
 * GET /v1/workspaces/:name/files?prefix=&cursor=&limit= — folder-aware,
 * gh.*-metadata-hydrated workspace file listing (commit 0f9ac65). Backs the
 * settings-page files tab's folder browser, so like {@link fetchWorkspaceList}
 * this is a "less central" detail helper: any transport failure, non-2xx, or
 * malformed body degrades to an empty listing rather than surfacing an outage.
 *
 * The API returns `cursor` as `string | null`; normalized here to
 * `string | undefined`. Likewise `prefixes` defaults to `[]` when the API
 * omits it (non-delimited listings).
 *
 * `opts.cookie` (plan 005): lets an Astro frontmatter server-fetch the
 * default folder listing with the incoming request's session cookie —
 * `credentials: "include"` alone only rides a browser's own cookie jar and
 * does nothing for a server-to-server fetch. Same `sessionFetchInit`
 * convention plan 001 added to the other `/v1/workspaces/:name/*` reads
 * below; this is the one plan 001 didn't touch, added here narrowly because
 * it's the actual data source `WorkspaceFileTable`'s default (unfiltered)
 * browse view uses, not `getMyWorkspaceFiles`.
 */
export async function listWorkspaceFolder(
  apiOrigin: string,
  workspace: string,
  opts: { prefix?: string; cursor?: string; limit?: number; cookie?: string } = {},
): Promise<WorkspaceFolderListing> {
  const params = new URLSearchParams();
  // Always list one folder level at a time — without the delimiter the API
  // returns a flat recursive listing and no `prefixes` (folders).
  params.set("delimiter", "/");
  if (opts.prefix !== undefined) params.set("prefix", opts.prefix);
  if (opts.cursor !== undefined) params.set("cursor", opts.cursor);
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  const query = params.toString();
  const url = `${trimOrigin(apiOrigin)}/v1/workspaces/${encodeURIComponent(workspace)}/files${query ? `?${query}` : ""}`;

  const result = await fetchWithTimeout(url, sessionFetchInit(opts.cookie));
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

/**
 * Workspace-level managed-comment defaults (issue #307, Task 7 — the
 * settings-tab block). Mirrors `commentSettingsResponse` in
 * apps/api/src/routes/me.ts exactly: `null` means "unset/auto" for every
 * field, never a separate "not configured" state.
 */
export interface CommentSettings {
  imageWidth: "full" | number | null;
  maxInlineImages: number | null;
  showMetadata: boolean | null;
  linkToFilePage: boolean | null;
  note: string | null;
  /** `null` (auto) defaults to `false` — unlike the other tri-state fields, which default to `true`. */
  ingestGithubAttachments: boolean | null;
}

export type CommentSettingsResult =
  | { kind: "ok"; settings: CommentSettings }
  | { kind: "unavailable"; reason: RequestFailure | "forbidden" | "not_found" | "server" };

function toCommentSettings(body: unknown): CommentSettings | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const imageWidth =
    b.imageWidth === "full" || typeof b.imageWidth === "number" ? b.imageWidth : null;
  const maxInlineImages = typeof b.maxInlineImages === "number" ? b.maxInlineImages : null;
  const showMetadata = typeof b.showMetadata === "boolean" ? b.showMetadata : null;
  const linkToFilePage = typeof b.linkToFilePage === "boolean" ? b.linkToFilePage : null;
  const note = typeof b.note === "string" ? b.note : null;
  const ingestGithubAttachments =
    typeof b.ingestGithubAttachments === "boolean" ? b.ingestGithubAttachments : null;
  return {
    imageWidth,
    maxInlineImages,
    showMetadata,
    linkToFilePage,
    note,
    ingestGithubAttachments,
  };
}

/** GET /v1/workspaces/:name/comment-settings — admin/owner only. */
export async function getWorkspaceCommentSettings(
  apiOrigin: string,
  name: string,
): Promise<CommentSettingsResult> {
  const result = await fetchWithTimeout(
    `${trimOrigin(apiOrigin)}/v1/workspaces/${encodeURIComponent(name)}/comment-settings`,
    { credentials: "include", cache: "no-store" },
  );
  if (result.kind === "unavailable") return result;
  const { response } = result;
  if (response.status === 403) return { kind: "unavailable", reason: "forbidden" };
  if (response.status === 404) return { kind: "unavailable", reason: "not_found" };
  if (!response.ok) return { kind: "unavailable", reason: "server" };
  const settings = toCommentSettings(await response.json().catch(() => null));
  if (!settings) return { kind: "unavailable", reason: "server" };
  return { kind: "ok", settings };
}

export type CommentSettingsPatchResult =
  | { kind: "ok"; settings: CommentSettings }
  | { kind: "invalid"; message: string }
  | { kind: "unavailable"; reason: RequestFailure | "forbidden" | "not_found" | "server" };

/**
 * PATCH /v1/workspaces/:name/comment-settings. `patch` is partial — an
 * omitted key leaves the field unchanged server-side, an explicit `null`
 * clears it. On a 400 the server's `error.message` is surfaced verbatim
 * (already a complete sentence naming the offending field/bounds) so the
 * settings form can show it inline without re-deriving it client-side.
 */
export async function patchWorkspaceCommentSettings(
  apiOrigin: string,
  name: string,
  patch: Partial<CommentSettings>,
): Promise<CommentSettingsPatchResult> {
  const result = await fetchWithTimeout(
    `${trimOrigin(apiOrigin)}/v1/workspaces/${encodeURIComponent(name)}/comment-settings`,
    {
      method: "PATCH",
      credentials: "include",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    },
  );
  if (result.kind === "unavailable") return result;
  const { response } = result;
  if (response.status === 400) {
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    return { kind: "invalid", message: body?.error?.message ?? "That change isn’t allowed." };
  }
  if (response.status === 403) return { kind: "unavailable", reason: "forbidden" };
  if (response.status === 404) return { kind: "unavailable", reason: "not_found" };
  if (!response.ok) return { kind: "unavailable", reason: "server" };
  const settings = toCommentSettings(await response.json().catch(() => null));
  if (!settings) return { kind: "unavailable", reason: "server" };
  return { kind: "ok", settings };
}

/**
 * GET /v1/workspaces/:name/github/repo-links — repo names this workspace has
 * linked (issue #307, Task 7's repo picker). Fails open to `[]`: an empty
 * picker just means "no repo config" is the only option, same as a
 * workspace that genuinely has no linked repos.
 */
export async function getWorkspaceRepoLinks(apiOrigin: string, name: string): Promise<string[]> {
  const result = await fetchWithTimeout(
    `${trimOrigin(apiOrigin)}/v1/workspaces/${encodeURIComponent(name)}/github/repo-links`,
    { credentials: "include", cache: "no-store" },
  );
  if (result.kind === "unavailable" || !result.response.ok) return [];
  const body = (await result.response.json().catch(() => null)) as { repos?: unknown } | null;
  if (!body || !Array.isArray(body.repos)) return [];
  return body.repos.filter((r): r is string => typeof r === "string");
}

/** Per-key attribution the preview endpoint returns: which layer supplied the resolved value. */
export type CommentOptionSource = "repo" | "workspace" | "auto";

export interface CommentPreviewResolved {
  imageWidth: "auto" | "full" | number;
  maxInlineImages: number;
  metaPath: boolean;
  metaState: boolean;
  linkToFilePage: boolean;
  note: string | null;
}

export interface CommentPreview {
  resolved: CommentPreviewResolved;
  source: Record<keyof CommentPreviewResolved, CommentOptionSource>;
  repoConfig: { found: boolean; path: string | null; warnings: string[] } | null;
  body: string;
  sample: "workspace" | "fixtures";
}

export type CommentPreviewResult =
  | { kind: "ok"; preview: CommentPreview }
  | {
      kind: "unavailable";
      reason: RequestFailure | "forbidden" | "not_found" | "invalid_repo" | "server";
    };

/**
 * GET /v1/workspaces/:name/comment-preview[?repo=owner/name]. `repo` must
 * already be linked to this workspace — an unlinked or malformed repo 404s/
 * 400s server-side, surfaced here as `not_found`/`invalid_repo` so the
 * preview panel can tell the two apart (a stale picker entry vs. a typo).
 */
export async function getWorkspaceCommentPreview(
  apiOrigin: string,
  name: string,
  repo?: string,
): Promise<CommentPreviewResult> {
  const qs = repo ? `?repo=${encodeURIComponent(repo)}` : "";
  const result = await fetchWithTimeout(
    `${trimOrigin(apiOrigin)}/v1/workspaces/${encodeURIComponent(name)}/comment-preview${qs}`,
    { credentials: "include", cache: "no-store" },
  );
  if (result.kind === "unavailable") return result;
  const { response } = result;
  if (response.status === 403) return { kind: "unavailable", reason: "forbidden" };
  if (response.status === 404) return { kind: "unavailable", reason: "not_found" };
  if (response.status === 400) return { kind: "unavailable", reason: "invalid_repo" };
  if (!response.ok) return { kind: "unavailable", reason: "server" };
  const body = (await response.json().catch(() => null)) as Partial<CommentPreview> | null;
  if (
    !body ||
    typeof body.body !== "string" ||
    !body.resolved ||
    typeof body.resolved !== "object" ||
    !body.source ||
    typeof body.source !== "object" ||
    (body.sample !== "workspace" && body.sample !== "fixtures")
  ) {
    return { kind: "unavailable", reason: "server" };
  }
  return {
    kind: "ok",
    preview: {
      resolved: body.resolved as CommentPreviewResolved,
      source: body.source as Record<keyof CommentPreviewResolved, CommentOptionSource>,
      repoConfig: body.repoConfig ?? null,
      body: body.body,
      sample: body.sample,
    },
  };
}

/**
 * Self-serve BYO R2 bucket (issue #583 Phase 2). Mirrors the
 * comment-settings pair above: `credentials: "include"`, 403/404 collapsed
 * to `"forbidden"`/`"not_found"` `unavailable` reasons, 400 messages
 * surfaced verbatim from `error.message`. Backed by
 * `storageStatusResponse`/`StorageVerifyResult` in
 * `apps/api/src/routes/workspace-storage.ts` — field names match exactly.
 */
export interface WorkspaceStorageStatus {
  mode: "shared" | "byo";
  byoBucketEnabled: boolean;
  bucket?: string;
  accountIdMasked?: string;
  accessKeyIdLast4?: string;
  publicBaseUrl?: string;
  configuredAt?: string;
  verifiedAt?: string;
  jurisdiction?: string;
}

function toWorkspaceStorageStatus(body: unknown): WorkspaceStorageStatus | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b.mode !== "shared" && b.mode !== "byo") return null;
  return {
    mode: b.mode,
    byoBucketEnabled: b.byoBucketEnabled === true,
    bucket: typeof b.bucket === "string" ? b.bucket : undefined,
    accountIdMasked: typeof b.accountIdMasked === "string" ? b.accountIdMasked : undefined,
    accessKeyIdLast4: typeof b.accessKeyIdLast4 === "string" ? b.accessKeyIdLast4 : undefined,
    publicBaseUrl: typeof b.publicBaseUrl === "string" ? b.publicBaseUrl : undefined,
    configuredAt: typeof b.configuredAt === "string" ? b.configuredAt : undefined,
    verifiedAt: typeof b.verifiedAt === "string" ? b.verifiedAt : undefined,
    jurisdiction: typeof b.jurisdiction === "string" ? b.jurisdiction : undefined,
  };
}

export type WorkspaceStorageStatusResult =
  | { kind: "ok"; status: WorkspaceStorageStatus }
  | { kind: "unavailable"; reason: RequestFailure | "forbidden" | "not_found" | "server" };

/**
 * GET /v1/workspaces/:name/storage — admin/owner only, but readable
 * regardless of `byoBucketEnabled` so the settings panel can decide whether
 * to reveal itself at all (mirrors `loadCommentSettings`'s
 * hidden-until-`ok` convention in settings.astro).
 */
export async function getWorkspaceStorageStatus(
  apiOrigin: string,
  name: string,
): Promise<WorkspaceStorageStatusResult> {
  const result = await fetchWithTimeout(
    `${trimOrigin(apiOrigin)}/v1/workspaces/${encodeURIComponent(name)}/storage`,
    { credentials: "include", cache: "no-store" },
  );
  if (result.kind === "unavailable") return result;
  const { response } = result;
  if (response.status === 403) return { kind: "unavailable", reason: "forbidden" };
  if (response.status === 404) return { kind: "unavailable", reason: "not_found" };
  if (!response.ok) return { kind: "unavailable", reason: "server" };
  const status = toWorkspaceStorageStatus(await response.json().catch(() => null));
  if (!status) return { kind: "unavailable", reason: "server" };
  return { kind: "ok", status };
}

export interface StorageVerifyCheck {
  /** Stable check id — `"shape" | "auth" | "round-trip" | "not-empty" | "public-url"`. */
  id: string;
  ok: boolean;
  /** Required checks gate `ok`; recommended (e.g. `public-url`) only ever warn. */
  required: boolean;
  /** Human remediation text, present when `ok` is false. Surfaced verbatim. */
  hint?: string;
}

export interface StorageVerifyResult {
  /** True only when every required check passed. */
  ok: boolean;
  checks: StorageVerifyCheck[];
}

function toStorageVerifyResult(body: unknown): StorageVerifyResult | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.ok !== "boolean" || !Array.isArray(b.checks)) return null;
  const checks = b.checks.flatMap((c): StorageVerifyCheck[] => {
    if (!c || typeof c !== "object") return [];
    const check = c as Record<string, unknown>;
    if (
      typeof check.id !== "string" ||
      typeof check.ok !== "boolean" ||
      typeof check.required !== "boolean"
    ) {
      return [];
    }
    return [
      {
        id: check.id,
        ok: check.ok,
        required: check.required,
        // Normalized rather than passed through: a non-string hint would
        // reach the checklist renderer typed as string.
        hint: typeof check.hint === "string" ? check.hint : undefined,
      },
    ];
  });
  return { ok: b.ok, checks };
}

/** Candidate config the wizard is trying to attach — never saved until a PUT. */
export interface StorageCandidate {
  bucket: string;
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl?: string;
  adoptExistingContents?: boolean;
  jurisdiction?: string;
}

export type StorageVerifyApiResult =
  | { kind: "ok"; result: StorageVerifyResult }
  | { kind: "unavailable"; reason: RequestFailure | "forbidden" | "not_found" | "server" };

/**
 * POST /v1/workspaces/:name/storage/verify — runs the server-side probe
 * pipeline against `candidate` without persisting anything (step 3 of the
 * connect wizard). 403 means `byoBucketEnabled` is off for this workspace.
 */
export async function verifyWorkspaceStorage(
  apiOrigin: string,
  name: string,
  candidate: StorageCandidate,
): Promise<StorageVerifyApiResult> {
  const result = await fetchWithTimeout(
    `${trimOrigin(apiOrigin)}/v1/workspaces/${encodeURIComponent(name)}/storage/verify`,
    {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(candidate),
    },
  );
  if (result.kind === "unavailable") return result;
  const { response } = result;
  if (response.status === 403) return { kind: "unavailable", reason: "forbidden" };
  if (response.status === 404) return { kind: "unavailable", reason: "not_found" };
  if (!response.ok) return { kind: "unavailable", reason: "server" };
  const verify = toStorageVerifyResult(await response.json().catch(() => null));
  if (!verify) return { kind: "unavailable", reason: "server" };
  return { kind: "ok", result: verify };
}

export type StorageSaveResult =
  | { kind: "ok"; status: WorkspaceStorageStatus }
  /** 422 — the server re-ran verify and it failed; render the same checklist. */
  | { kind: "invalid"; result: StorageVerifyResult }
  /** 409 `workspace_storage_not_empty` — message surfaced verbatim. */
  | { kind: "conflict"; message: string }
  | { kind: "unavailable"; reason: RequestFailure | "forbidden" | "not_found" | "server" };

/**
 * PUT /v1/workspaces/:name/storage — attach or rotate a BYO config. The
 * server re-verifies `candidate` itself (never trusts a client-side
 * "verified" claim), so a 422 here carries a fresh `StorageVerifyResult`
 * the wizard can render exactly like the standalone verify call's.
 */
export async function putWorkspaceStorage(
  apiOrigin: string,
  name: string,
  candidate: StorageCandidate,
): Promise<StorageSaveResult> {
  const result = await fetchWithTimeout(
    `${trimOrigin(apiOrigin)}/v1/workspaces/${encodeURIComponent(name)}/storage`,
    {
      method: "PUT",
      credentials: "include",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(candidate),
    },
  );
  if (result.kind === "unavailable") return result;
  const { response } = result;
  if (response.status === 422) {
    const verify = toStorageVerifyResult(await response.json().catch(() => null));
    if (verify) return { kind: "invalid", result: verify };
    return { kind: "unavailable", reason: "server" };
  }
  if (response.status === 409) {
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    return {
      kind: "conflict",
      message: body?.error?.message ?? "This workspace already has files.",
    };
  }
  if (response.status === 403) return { kind: "unavailable", reason: "forbidden" };
  if (response.status === 404) return { kind: "unavailable", reason: "not_found" };
  if (!response.ok) return { kind: "unavailable", reason: "server" };
  const status = toWorkspaceStorageStatus(await response.json().catch(() => null));
  if (!status) return { kind: "unavailable", reason: "server" };
  return { kind: "ok", status };
}

export type StorageDetachResult =
  | { kind: "ok"; status: WorkspaceStorageStatus }
  /** 409 `workspace_storage_not_empty` — message surfaced verbatim. */
  | { kind: "conflict"; message: string }
  | { kind: "unavailable"; reason: RequestFailure | "forbidden" | "not_found" | "server" };

/**
 * DELETE /v1/workspaces/:name/storage — detach BYO storage and restore
 * shared-bucket defaults. `force: true` bypasses the empty-bucket guard
 * (caller must have already confirmed with the user — never touches the
 * customer's bucket or its objects either way).
 */
export async function deleteWorkspaceStorage(
  apiOrigin: string,
  name: string,
  opts: { force?: boolean } = {},
): Promise<StorageDetachResult> {
  const qs = opts.force ? "?force=true" : "";
  const result = await fetchWithTimeout(
    `${trimOrigin(apiOrigin)}/v1/workspaces/${encodeURIComponent(name)}/storage${qs}`,
    { method: "DELETE", credentials: "include", cache: "no-store" },
  );
  if (result.kind === "unavailable") return result;
  const { response } = result;
  if (response.status === 409) {
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    return {
      kind: "conflict",
      message: body?.error?.message ?? "This workspace still has files on its BYO bucket.",
    };
  }
  if (response.status === 403) return { kind: "unavailable", reason: "forbidden" };
  if (response.status === 404) return { kind: "unavailable", reason: "not_found" };
  if (!response.ok) return { kind: "unavailable", reason: "server" };
  const status = toWorkspaceStorageStatus(await response.json().catch(() => null));
  if (!status) return { kind: "unavailable", reason: "server" };
  return { kind: "ok", status };
}
