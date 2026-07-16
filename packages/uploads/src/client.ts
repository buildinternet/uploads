import { inferContentType } from "./embed.js";
import type { UploadsClientConfig } from "./config.js";
import { UsageError } from "./cli-args.js";
import { UploadsError } from "./errors.js";
import { buildScreenshotKey } from "./keys.js";
import { packageVersion } from "./package-version.js";
import { resolveEmbedUrl } from "./public-urls.js";

/** Allowlisted object provenance (maps to X-Uploads-Meta-* on put). */
export type ProvenanceInput = {
  client?: string;
  "client-version"?: string;
  "source-name"?: string;
  optimized?: "0" | "1";
  frame?: string;
  "keep-exif"?: "0" | "1";
};

export interface PutOptions {
  key?: string;
  contentType?: string;
  prefix?: string;
  repo?: string;
  ref?: string;
  deriveRepoFromGit?: boolean;
  /** Stored as R2 custom metadata; echoed on put/head. */
  provenance?: ProvenanceInput;
  /**
   * Queryable custom metadata (D1 `file_metadata`), sent alongside provenance
   * as more `X-Uploads-Meta-<key>` headers — the server routes each key to R2
   * (provenance) or D1 (everything else) by name. See `metadata.ts` for the
   * client-side validation callers should run before this.
   */
  metadata?: Record<string, string>;
  /** Validate key + resolve public URL without writing. `size` is local bytes only. */
  dryRun?: boolean;
}

export interface ListOptions {
  prefix?: string;
  limit?: number;
  cursor?: string;
}

export interface FindFilesOptions {
  prefix?: string;
  limit?: number;
}

export interface FindFilesItem {
  key: string;
  url: string | null;
  metadata: Record<string, string>;
}

export interface FindFilesResult {
  items: FindFilesItem[];
  cursor: string | null;
}

export interface GetMetadataResult {
  metadata: Record<string, string>;
}

export interface PatchMetadataOptions {
  set?: Record<string, string>;
  delete?: string[];
}

export interface PutResult {
  workspace: string;
  key: string;
  url: string;
  /** Same object on the embed host when dual-host applies; prefer for GitHub markdown. */
  embedUrl: string | null;
  size: number;
  contentType: string;
  /**
   * True when the put overwrote an existing key, or (with dryRun) when a put
   * at this key would overwrite. Always set by the API for put/dry-run.
   */
  replaced?: boolean;
  metadata?: Record<string, string>;
}

export interface ListItem {
  key: string;
  url: string | null;
  embedUrl?: string | null;
  size?: number;
  uploaded?: string;
}

export interface ListResult {
  items: ListItem[];
  cursor: string | null;
}

export interface HeadResult {
  key: string;
  url: string | null;
  embedUrl?: string | null;
  size: number;
  contentType: string;
  uploaded?: string;
  metadata?: Record<string, string>;
}

export interface DeleteResult {
  key: string;
  deleted: boolean;
}

/** A workspace-owned, publicly visible ordered media gallery. */
export interface GalleryItem {
  id: string;
  objectKey: string;
  position: number;
  caption: string | null;
  altText: string | null;
  createdAt: string;
  status: "available" | "missing";
  url: string | null;
  /** Dual-host embed URL when available. */
  embedUrl?: string | null;
  /** Standalone web page for this item (gallery URL + item id). Absent on older API deployments. */
  pageUrl?: string;
  contentType: string | null;
  size: number | null;
}

export interface Gallery {
  id: string;
  /** Canonical public URL returned by the API; clients must not construct it. */
  url: string;
  workspace: string;
  title: string;
  description: string | null;
  visibility: "public";
  coverItemId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  items: GalleryItem[];
}

export type GallerySummary = Omit<Gallery, "items">;

export interface GalleryListOptions {
  limit?: number;
  cursor?: string;
}

export interface GalleryListResult {
  galleries: GallerySummary[];
  nextCursor: string | null;
}

export interface CreateGalleryOptions {
  title: string;
  description?: string | null;
}

export interface AddGalleryItemOptions {
  expectedVersion: number;
  caption?: string | null;
  altText?: string | null;
}

export interface DeleteGalleryOptions {
  expectedVersion: number;
}

export interface GalleryExternalReference {
  id: string;
  provider: "github";
  resourceType: "item";
  coordinate: string;
  canonicalUrl: string | null;
  createdAt: string;
}

export interface GalleryExternalReferenceListResult {
  references: GalleryExternalReference[];
}

export interface LinkGalleryExternalReferenceOptions {
  expectedVersion: number;
  provider: "github";
  coordinate: string;
}

export interface UnlinkGalleryExternalReferenceOptions {
  expectedVersion: number;
}

export interface FindGalleriesByReferenceOptions {
  provider: "github";
  coordinate: string;
  limit?: number;
  cursor?: string;
}

export interface HealthResult {
  ok: boolean;
}

export interface UsageResult {
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

export interface ReconcileResult {
  workspace: string;
  bytes: number;
  objects: number;
  previous: { bytes: number; objects: number };
  changed: boolean;
  usage: UsageResult;
}

export interface PurgeExpiredResult {
  workspace: string;
  retentionDays: number;
  cutoff: string;
  deleted: number;
  freedBytes: number;
  keys: string[];
  keysTruncated: boolean;
  reconcile: ReconcileResult;
}

export type PurgeExpiredResponse = PurgeExpiredResult | { skipped: true; reason: string };

export interface EnrollmentExchangeResult {
  apiUrl?: string;
  workspace: string;
  token: string;
  scopes?: Array<"files:read" | "files:write" | "files:delete">;
  expiresAt?: string;
}

export interface EnrollmentCreateResult {
  pageId: string;
  code: string;
  expiresAt: string;
  tokenExpiresAt: string;
  // Present only when an --email recipient was requested: whether delivery succeeded.
  emailed?: boolean;
}

async function jsonRequest<T>(url: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new UploadsError(
      err instanceof Error ? err.message : "network request failed",
      "NETWORK",
    );
  }
  if (!res.ok) throw await parseErrorResponse(res);
  return (await res.json()) as T;
}

export function exchangeEnrollment(
  apiUrl: string,
  code: string,
): Promise<EnrollmentExchangeResult> {
  return jsonRequest(`${apiUrl.replace(/\/$/, "")}/auth/enrollments/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
}

export function createEnrollment(
  apiUrl: string,
  adminToken: string,
  input: {
    workspace?: string;
    label?: string;
    email?: string;
    enrollmentSeconds?: number;
    tokenExpiresInSeconds?: number;
    scopes?: Array<"files:read" | "files:write" | "files:delete">;
  },
): Promise<EnrollmentCreateResult> {
  return jsonRequest(`${apiUrl.replace(/\/$/, "")}/admin/enrollments`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

// --- Device authorization (RFC 8628) — the `uploads login` device flow ---
//
// The CLI speaks the auth worker's OAuth-shaped endpoints directly with plain
// `fetch` (no better-auth client dependency in the published package, per plan
// D5). Better Auth's `device.code`/`device.token` endpoints take
// `application/json` bodies, NOT the RFC's form-encoding — the JSON shapes
// below are what the worker expects.

/** Static OAuth client id allowlisted by the auth worker's `validateClient`. */
export const DEVICE_CLIENT_ID = "uploads-cli";

/**
 * User-Agent for device-flow requests. Stored on the Better Auth session row
 * when `/device/token` creates the session, so the web account UI can tell a
 * completed `uploads login` apart from a browser tab. Keep the
 * `@buildinternet/uploads` prefix in sync with apps/web `CLI_USER_AGENT_RE`.
 */
export function cliUserAgent(purpose = "device-login"): string {
  return `@buildinternet/uploads/${packageVersion()} (${purpose})`;
}

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

/** POST /api/auth/device/code — start a device flow. Throws on a non-2xx. */
export function requestDeviceCode(
  authUrl: string,
  clientId = DEVICE_CLIENT_ID,
): Promise<DeviceCodeResponse> {
  return jsonRequest(`${authUrl.replace(/\/$/, "")}/api/auth/device/code`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": cliUserAgent("device-code"),
    },
    body: JSON.stringify({ client_id: clientId }),
  });
}

/**
 * One poll of POST /api/auth/device/token. Unlike most calls, the "not ready
 * yet" outcomes (`authorization_pending`, `slow_down`) are EXPECTED 400s, so
 * this returns a discriminated result instead of throwing — the caller's poll
 * loop branches on `status`.
 */
export type DeviceTokenResult =
  | { status: "ok"; accessToken: string; tokenType: string; expiresIn: number; scope: string }
  | { status: "pending" }
  | { status: "slow_down" }
  | { status: "expired" }
  | { status: "denied" }
  | { status: "error"; error: string; description?: string };

export async function requestDeviceToken(
  authUrl: string,
  input: { deviceCode: string; clientId?: string },
): Promise<DeviceTokenResult> {
  let res: Response;
  try {
    res = await fetch(`${authUrl.replace(/\/$/, "")}/api/auth/device/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Session user_agent is taken from this request when the token is
        // exchanged — identify as the CLI so /account can surface it.
        "User-Agent": cliUserAgent("device-token"),
      },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: input.deviceCode,
        client_id: input.clientId ?? DEVICE_CLIENT_ID,
      }),
    });
  } catch (err) {
    throw new UploadsError(
      err instanceof Error ? err.message : "network request failed",
      "NETWORK",
    );
  }
  const body = (await res.json().catch(() => null)) as {
    access_token?: string;
    token_type?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
    error_description?: string;
  } | null;
  if (res.ok && body?.access_token) {
    return {
      status: "ok",
      accessToken: body.access_token,
      tokenType: body.token_type ?? "Bearer",
      expiresIn: typeof body.expires_in === "number" ? body.expires_in : 0,
      scope: body.scope ?? "",
    };
  }
  switch (body?.error) {
    case "authorization_pending":
      return { status: "pending" };
    case "slow_down":
      return { status: "slow_down" };
    case "expired_token":
      return { status: "expired" };
    case "access_denied":
      return { status: "denied" };
    default:
      return {
        status: "error",
        error: body?.error ?? "unknown",
        description: body?.error_description,
      };
  }
}

export interface MintWorkspaceSummary {
  workspace: string;
  role: string;
}

/** GET /v1/tokens — workspaces the signed-in user can mint tokens for. */
export function listMintWorkspaces(
  apiUrl: string,
  accessToken: string,
): Promise<{ workspaces: MintWorkspaceSummary[] }> {
  return jsonRequest(`${apiUrl.replace(/\/$/, "")}/v1/tokens`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

export interface CreateWorkspaceResult {
  name: string;
  publicBaseUrl: string;
  selfServe: boolean;
}

/**
 * POST /v1/workspaces — self-serve workspace creation from a device-flow
 * session (presented as a bearer). Throws `UsageError` with a message tuned
 * for CLI display: a linked-GitHub requirement gets an actionable pointer,
 * everything else surfaces the server's message.
 */
export async function createWorkspaceRequest(
  apiUrl: string,
  accessToken: string,
  name: string,
): Promise<CreateWorkspaceResult> {
  try {
    const { workspace } = await jsonRequest<{ workspace: CreateWorkspaceResult }>(
      `${apiUrl.replace(/\/$/, "")}/v1/workspaces`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name }),
      },
    );
    return workspace;
  } catch (err) {
    if (err instanceof UploadsError && err.code === "GITHUB_REQUIRED") {
      throw new UsageError(
        "creating a workspace requires a linked GitHub account — connect one at https://uploads.sh/account/profile and re-run `uploads login`",
      );
    }
    throw new UsageError(err instanceof Error ? err.message : "workspace creation failed");
  }
}

export interface MintTokenResult {
  token: string;
  workspace: string;
  scopes: Array<"files:read" | "files:write" | "files:delete">;
  label: string | null;
  expiresAt: string | null;
}

/**
 * POST /me/workspaces/:name/invites — org invitation for a workspace.
 * Requires a Better Auth session bearer (device flow), not a workspace token.
 * Caller must be org admin|owner. `acceptUrl` is always returned so
 * self-hosted deploys without email can still share the link.
 */
export function createWorkspaceInvite(
  apiUrl: string,
  accessToken: string,
  workspace: string,
  input: { email: string; role?: "member" | "admin" },
): Promise<{
  invitation: { id: string; email: string; role: string; status: string };
  acceptUrl?: string;
  /** Whether the install can send invite emails; absent on older auth workers. */
  emailConfigured?: boolean;
}> {
  return jsonRequest(
    `${apiUrl.replace(/\/$/, "")}/me/workspaces/${encodeURIComponent(workspace)}/invites`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: input.email, role: input.role ?? "member" }),
    },
  );
}

/**
 * POST /v1/tokens — mint a `up_<workspace>_…` workspace token from a device-flow
 * session (presented as a bearer). v1 sends exactly one grant.
 */
export function mintWorkspaceToken(
  apiUrl: string,
  accessToken: string,
  input: {
    workspace: string;
    scopes?: Array<"files:read" | "files:write" | "files:delete">;
    label?: string;
    ttlSeconds?: number;
  },
): Promise<MintTokenResult> {
  return jsonRequest(`${apiUrl.replace(/\/$/, "")}/v1/tokens`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      grants: [{ workspace: input.workspace, ...(input.scopes ? { scopes: input.scopes } : {}) }],
      ...(input.label ? { label: input.label } : {}),
      ...(input.ttlSeconds ? { ttlSeconds: input.ttlSeconds } : {}),
    }),
  });
}

function encodeKeyPath(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

function filesBase(config: UploadsClientConfig): string {
  return `${config.apiUrl}/v1/${encodeURIComponent(config.workspace)}/files`;
}

function usageBase(config: UploadsClientConfig): string {
  return `${config.apiUrl}/v1/${encodeURIComponent(config.workspace)}/usage`;
}

function galleriesBase(config: UploadsClientConfig): string {
  return `${config.apiUrl}/v1/${encodeURIComponent(config.workspace)}/galleries`;
}

function mapApiError(status: number, error: string, code?: string): UploadsError {
  const normalized = error.toLowerCase();
  if (status === 401 || code === "unauthorized" || normalized === "unauthorized") {
    return new UploadsError(error, "UNAUTHORIZED", status);
  }
  if (status === 404 || code === "not_found" || normalized === "not found") {
    return new UploadsError(error, "NOT_FOUND", status);
  }
  if (code === "invalid_key" || (status === 400 && normalized === "invalid key")) {
    return new UploadsError(error, "INVALID_KEY", status);
  }
  if (code === "key_prefix_not_allowed" || code === "key_too_deep") {
    return new UploadsError(error, "KEY_POLICY", status);
  }
  // Prefer stable body code — bare 429 is also used for write rate limits.
  if (status === 507 || code === "storage_quota_exceeded") {
    return new UploadsError(error, "STORAGE_QUOTA", status);
  }
  if (code === "upload_budget_exceeded") {
    return new UploadsError(error, "UPLOAD_BUDGET", status);
  }
  if (code === "github_required") {
    return new UploadsError(error, "GITHUB_REQUIRED", status);
  }
  return new UploadsError(error, "API_ERROR", status);
}

/**
 * Parse API error bodies. Prefers the nested envelope
 * `{ error: { code, type, message, details? } }`; still accepts the legacy
 * flat `{ error: string, code?: string }` shape. Exported so other backends
 * (e.g. the screenshot render endpoint) share this parsing instead of
 * duplicating it — each caller supplies its own `fallback` message.
 */
export function extractErrorFields(
  body: unknown,
  fallback = "request failed",
): { message: string; code?: string } {
  if (typeof body === "object" && body && "error" in body) {
    const err = (body as { error: unknown }).error;
    if (typeof err === "object" && err && "message" in err) {
      const nested = err as { message?: unknown; code?: unknown };
      return {
        message: typeof nested.message === "string" ? nested.message : fallback,
        code: typeof nested.code === "string" ? nested.code : undefined,
      };
    }
    if (typeof err === "string") {
      const code =
        "code" in body && typeof (body as { code: unknown }).code === "string"
          ? (body as { code: string }).code
          : undefined;
      return { message: err, code };
    }
  }
  return { message: fallback };
}

/** Fetch + parse an error-response body via {@link extractErrorFields}. */
export async function parseErrorEnvelope(
  res: Response,
  fallback = "request failed",
): Promise<{ message: string; code?: string }> {
  const body = await res.json().catch(() => ({}));
  return extractErrorFields(body, fallback);
}

async function parseErrorResponse(res: Response): Promise<UploadsError> {
  const { message, code } = await parseErrorEnvelope(res, "request failed");
  return mapApiError(res.status, message, code);
}

export function createUploadsClient(config: UploadsClientConfig) {
  async function request<T>(
    method: string,
    path: string,
    opts?: { body?: Uint8Array; headers?: Record<string, string>; auth?: boolean },
  ): Promise<T> {
    const headers: Record<string, string> = { ...opts?.headers };
    if (opts?.auth !== false) {
      headers.Authorization = `Bearer ${config.token}`;
    }

    let res: Response;
    try {
      res = await fetch(path, {
        method,
        headers,
        body: opts?.body,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "network request failed";
      throw new UploadsError(message, "NETWORK");
    }

    if (!res.ok) {
      throw await parseErrorResponse(res);
    }

    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async function list(opts: ListOptions = {}): Promise<ListResult> {
    const params = new URLSearchParams();
    if (opts.prefix) params.set("prefix", opts.prefix);
    if (opts.limit != null) params.set("limit", String(opts.limit));
    if (opts.cursor) params.set("cursor", opts.cursor);
    const qs = params.toString();
    const page = await request<ListResult>("GET", `${filesBase(config)}${qs ? `?${qs}` : ""}`);
    return {
      ...page,
      items: page.items.map((item) => ({
        ...item,
        embedUrl: resolveEmbedUrl(item.url, item.embedUrl),
      })),
    };
  }

  async function getGallery(id: string): Promise<Gallery> {
    return request<Gallery>("GET", `${galleriesBase(config)}/${encodeURIComponent(id)}`);
  }

  return {
    async put(body: Uint8Array, opts: PutOptions & { filename: string }): Promise<PutResult> {
      const key =
        opts.key ??
        (await buildScreenshotKey({
          filename: opts.filename,
          fileBytes: body,
          prefix: opts.prefix,
          repo: opts.repo,
          ref: opts.ref,
          deriveRepoFromGit: opts.deriveRepoFromGit,
        }));
      const contentType = opts.contentType ?? inferContentType(opts.filename);

      if (opts.dryRun) {
        const preview = await request<{
          workspace: string;
          key: string;
          url: string | null;
          embedUrl?: string | null;
          replaced?: boolean;
        }>("PUT", `${filesBase(config)}/${encodeKeyPath(key)}?dryRun=1`);
        if (preview.url == null) {
          throw new UploadsError(
            "workspace has no publicBaseUrl (cannot resolve a public URL)",
            "NO_PUBLIC_URL",
          );
        }
        return {
          workspace: preview.workspace,
          key: preview.key,
          url: preview.url,
          embedUrl: resolveEmbedUrl(preview.url, preview.embedUrl),
          size: body.byteLength,
          contentType,
          replaced: preview.replaced === true,
        };
      }

      const headers: Record<string, string> = { "Content-Type": contentType };
      if (opts.provenance) {
        for (const [k, v] of Object.entries(opts.provenance)) {
          if (v !== undefined && v !== "") headers[`X-Uploads-Meta-${k}`] = v;
        }
      }
      // Same header prefix as provenance above; the server splits allowlisted
      // provenance keys (R2) from everything else (D1 file_metadata) by name.
      if (opts.metadata) {
        for (const [k, v] of Object.entries(opts.metadata)) {
          if (v !== undefined && v !== "") headers[`X-Uploads-Meta-${k}`] = v;
        }
      }

      const result = await request<{
        workspace: string;
        key: string;
        url: string | null;
        embedUrl?: string | null;
        size: number;
        contentType: string;
        replaced?: boolean;
        metadata?: Record<string, string>;
      }>("PUT", `${filesBase(config)}/${encodeKeyPath(key)}`, {
        body,
        headers,
      });

      if (result.url == null) {
        throw new UploadsError(
          "upload succeeded but workspace has no publicBaseUrl",
          "NO_PUBLIC_URL",
          201,
        );
      }

      return {
        ...result,
        url: result.url,
        embedUrl: resolveEmbedUrl(result.url, result.embedUrl),
        replaced: result.replaced === true,
      };
    },

    list,

    /** Follow cursors (optionally starting from one) and return every remaining item. */
    async listAll(
      opts: Omit<ListOptions, "cursor"> & { cursor?: string } = {},
    ): Promise<ListItem[]> {
      const items: ListItem[] = [];
      let cursor: string | undefined = opts.cursor;
      do {
        const page = await list({ ...opts, cursor });
        items.push(...page.items);
        cursor = page.cursor ?? undefined;
      } while (cursor);
      return items;
    },

    async delete(key: string): Promise<DeleteResult> {
      return request<DeleteResult>("DELETE", `${filesBase(config)}/${encodeKeyPath(key)}`);
    },

    /** `GET /v1/:workspace/files/:key?metadata=1` — the object's queryable metadata. */
    async getMetadata(key: string): Promise<GetMetadataResult> {
      return request<GetMetadataResult>(
        "GET",
        `${filesBase(config)}/${encodeKeyPath(key)}?metadata=1`,
      );
    },

    /** `PATCH /v1/:workspace/files/:key` — merge `set`/`delete`; returns the merged map. */
    async patchMetadata(key: string, opts: PatchMetadataOptions): Promise<GetMetadataResult> {
      return request<GetMetadataResult>("PATCH", `${filesBase(config)}/${encodeKeyPath(key)}`, {
        body: new TextEncoder().encode(JSON.stringify(opts)),
        headers: { "Content-Type": "application/json" },
      });
    },

    /**
     * `GET /v1/:workspace/files?meta.<k>=<v>&…` — ANDed equality filter over
     * queryable metadata. `filters` must be pre-validated (see `metadata.ts`).
     */
    async findFiles(
      filters: Record<string, string>,
      opts: FindFilesOptions = {},
    ): Promise<FindFilesResult> {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(filters)) params.append(`meta.${k}`, v);
      if (opts.prefix) params.set("prefix", opts.prefix);
      if (opts.limit != null) params.set("limit", String(opts.limit));
      return request<FindFilesResult>("GET", `${filesBase(config)}?${params.toString()}`);
    },

    async head(key: string): Promise<HeadResult> {
      const result = await request<HeadResult>("GET", `${filesBase(config)}/${encodeKeyPath(key)}`);
      return { ...result, embedUrl: resolveEmbedUrl(result.url, result.embedUrl) };
    },

    async createGallery(opts: CreateGalleryOptions): Promise<Gallery> {
      return request<Gallery>("POST", galleriesBase(config), {
        body: new TextEncoder().encode(JSON.stringify(opts)),
        headers: { "Content-Type": "application/json" },
      });
    },

    async getGallery(id: string): Promise<Gallery> {
      return getGallery(id);
    },

    async listGalleries(opts: GalleryListOptions = {}): Promise<GalleryListResult> {
      const params = new URLSearchParams();
      if (opts.limit != null) params.set("limit", String(opts.limit));
      if (opts.cursor) params.set("cursor", opts.cursor);
      const qs = params.toString();
      return request<GalleryListResult>("GET", `${galleriesBase(config)}${qs ? `?${qs}` : ""}`);
    },

    async deleteGallery(
      id: string,
      opts: DeleteGalleryOptions,
    ): Promise<{ deleted: boolean; id: string }> {
      return request<{ deleted: boolean; id: string }>(
        "DELETE",
        `${galleriesBase(config)}/${encodeURIComponent(id)}`,
        {
          body: new TextEncoder().encode(JSON.stringify(opts)),
          headers: { "Content-Type": "application/json" },
        },
      );
    },

    async addGalleryItem(
      id: string,
      objectKey: string,
      opts: AddGalleryItemOptions,
    ): Promise<GalleryItem> {
      return request<GalleryItem>(
        "POST",
        `${galleriesBase(config)}/${encodeURIComponent(id)}/items`,
        {
          body: new TextEncoder().encode(JSON.stringify({ objectKey, ...opts })),
          headers: { "Content-Type": "application/json" },
        },
      );
    },

    async listGalleryExternalReferences(id: string): Promise<GalleryExternalReferenceListResult> {
      return request<GalleryExternalReferenceListResult>(
        "GET",
        galleriesBase(config) + "/" + encodeURIComponent(id) + "/external-references",
      );
    },

    async linkGalleryExternalReference(
      id: string,
      opts: LinkGalleryExternalReferenceOptions,
    ): Promise<GalleryExternalReference> {
      return request<GalleryExternalReference>(
        "POST",
        galleriesBase(config) + "/" + encodeURIComponent(id) + "/external-references",
        {
          body: new TextEncoder().encode(JSON.stringify(opts)),
          headers: { "Content-Type": "application/json" },
        },
      );
    },

    async unlinkGalleryExternalReference(
      id: string,
      referenceId: string,
      opts: UnlinkGalleryExternalReferenceOptions,
    ): Promise<{ deleted: boolean; id: string }> {
      return request<{ deleted: boolean; id: string }>(
        "DELETE",
        galleriesBase(config) +
          "/" +
          encodeURIComponent(id) +
          "/external-references/" +
          encodeURIComponent(referenceId),
        {
          body: new TextEncoder().encode(JSON.stringify(opts)),
          headers: { "Content-Type": "application/json" },
        },
      );
    },

    async findGalleriesByReference(
      opts: FindGalleriesByReferenceOptions,
    ): Promise<GalleryListResult> {
      const params = new URLSearchParams({ provider: opts.provider, coordinate: opts.coordinate });
      if (opts.limit != null) params.set("limit", String(opts.limit));
      if (opts.cursor) params.set("cursor", opts.cursor);
      return request<GalleryListResult>("GET", galleriesBase(config) + "/by-reference?" + params);
    },

    async health(): Promise<HealthResult> {
      return request<HealthResult>("GET", `${config.apiUrl}/health`, { auth: false });
    },

    /** Workspace storage / upload counters (+ limits when configured). */
    async usage(): Promise<UsageResult> {
      return request<UsageResult>("GET", usageBase(config));
    },

    /** Rebuild ledger bytes/objects from storage (source of truth). */
    async reconcile(): Promise<ReconcileResult> {
      return request<ReconcileResult>("POST", `${usageBase(config)}/reconcile`);
    },

    /** Delete objects past retentionDays (if set), then reconcile. */
    async purgeExpired(): Promise<PurgeExpiredResponse> {
      return request<PurgeExpiredResponse>("POST", `${usageBase(config)}/purge-expired`);
    },
  };
}

export type UploadsClient = ReturnType<typeof createUploadsClient>;
