import {
  CONTENT_TIMEOUT_MS,
  JSON_TIMEOUT_MS,
  parseErrorResponse,
  resilientFetch,
  type TransportOptions,
} from "./request.js";
import {
  FIND_FILES_MAX_PAGES,
  type AddGalleryItemOptions,
  type ApproveResult,
  type CreateFeedOptions,
  type CreateGalleryOptions,
  type DeleteGalleryOptions,
  type DeleteResult,
  type Feed,
  type FeedListOptions,
  type FeedListResult,
  type FindFilesItem,
  type FindFilesOptions,
  type FindFilesResult,
  type FindGalleriesByReferenceOptions,
  type Gallery,
  type GalleryExternalReference,
  type GalleryExternalReferenceListResult,
  type GalleryItem,
  type GalleryListOptions,
  type GalleryListResult,
  type GetMetadataResult,
  type GithubCommentResult,
  type HeadResult,
  type HealthResult,
  type HeldFile,
  type LinkGalleryExternalReferenceOptions,
  type ListItem,
  type ListOptions,
  type ListResult,
  type MetadataKeysResult,
  type MetadataValuesResult,
  type PatchMetadataOptions,
  type PurgeExpiredResponse,
  type PutOptions,
  type PutPreview,
  type PutResult,
  type ReconcileResult,
  type UnlinkGalleryExternalReferenceOptions,
  type UsageResult,
} from "./types.js";

export const DEFAULT_API_URL = "https://api.uploads.sh";

export interface UploadsConfig {
  /** A workspace token (`up_<workspace>_...`) or service token. Keep it server-side. */
  token: string;
  /** The workspace slug the token belongs to. */
  workspace: string;
  /** Defaults to {@link DEFAULT_API_URL}. */
  apiUrl?: string;
}

export interface UploadsClientOptions extends TransportOptions {
  /** Sent as `User-Agent` where the runtime allows it. */
  userAgent?: string;
  /** Called with the token's expiry (ISO) when the API reports one. */
  onTokenExpiry?: (expiresAt: string) => void;
}

export interface RequestOptions {
  body?: BodyInit;
  headers?: Record<string, string>;
  /** Set false to send no token (public endpoints). */
  auth?: boolean;
  /** Use the longer content timeout, for request bodies that carry file bytes. */
  longTimeout?: boolean;
}

type FileBody = Uint8Array | ArrayBuffer | Blob;

function encodeKeyPath(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

function jsonBody(value: unknown): RequestOptions {
  return {
    body: new TextEncoder().encode(JSON.stringify(value)),
    headers: { "Content-Type": "application/json" },
  };
}

/**
 * A client for one workspace. Every method throws `UploadsError` on a
 * non-2xx response.
 */
export function createUploadsClient(config: UploadsConfig, clientOpts: UploadsClientOptions = {}) {
  const apiUrl = (config.apiUrl ?? DEFAULT_API_URL).replace(/\/$/, "");
  const workspaceBase = `${apiUrl}/v1/workspaces/${encodeURIComponent(config.workspace)}`;
  const filesBase = `${workspaceBase}/files`;
  const galleriesBase = `${workspaceBase}/galleries`;
  const feedsBase = `${workspaceBase}/feeds`;
  const usageBase = `${workspaceBase}/usage`;

  /**
   * Call any API route. `path` is relative to the API URL (`/v1/...`) or a
   * full URL. Returns the parsed JSON body, or undefined for a 204.
   */
  async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const url = /^https?:\/\//.test(path) ? path : `${apiUrl}${path}`;
    const headers: Record<string, string> = {
      ...(clientOpts.userAgent ? { "User-Agent": clientOpts.userAgent } : {}),
      ...opts.headers,
    };
    const sendsToken = opts.auth !== false;
    if (sendsToken) headers.Authorization = `Bearer ${config.token}`;

    const res = await resilientFetch(
      method,
      url,
      { method, headers, body: opts.body },
      opts.longTimeout ? CONTENT_TIMEOUT_MS : JSON_TIMEOUT_MS,
      clientOpts,
    );
    if (!res.ok) throw await parseErrorResponse(res);

    const expiresAt = sendsToken ? res.headers.get("Uploads-Token-Expires") : null;
    if (expiresAt) clientOpts.onTokenExpiry?.(expiresAt);

    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async function list(opts: ListOptions = {}): Promise<ListResult> {
    const params = new URLSearchParams();
    if (opts.prefix) params.set("prefix", opts.prefix);
    if (opts.limit != null) params.set("limit", String(opts.limit));
    if (opts.cursor) params.set("cursor", opts.cursor);
    // The route hydrates metadata by default; skip that server-side when the
    // caller would discard it.
    params.set("metadata", opts.metadata ? "1" : "0");
    // Map the `{files, prefixes, cursor}` envelope to `{items, cursor}`,
    // dropping metadata the caller didn't ask for.
    const page = await request<{ files: ListItem[]; cursor: string | null }>(
      "GET",
      `${filesBase}?${params}`,
    );
    return {
      cursor: page.cursor,
      items: page.files.map((item) => {
        const { metadata, ...rest } = item;
        return { ...rest, ...(opts.metadata && metadata !== undefined ? { metadata } : {}) };
      }),
    };
  }

  async function findFiles(
    filters: Record<string, string> = {},
    opts: FindFilesOptions = {},
  ): Promise<FindFilesResult> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) params.append(`meta.${k}`, v);
    if (opts.name) params.set("name", opts.name);
    if (opts.prefix) params.set("prefix", opts.prefix);
    if (opts.limit != null) params.set("limit", String(opts.limit));
    if (opts.cursor) params.set("cursor", opts.cursor);
    const result = await request<{
      items: FindFilesItem[];
      truncated: boolean;
      cursor?: string | null;
    }>("GET", `${filesBase}/search?${params}`);
    return {
      items: result.items,
      cursor: result.cursor ?? null,
      truncated: result.truncated,
    };
  }

  return {
    request,

    /** Upload bytes to `key`. Throws `KEY_EXISTS` on a strict key that exists, unless `replace`. */
    async put(key: string, body: FileBody, opts: PutOptions = {}): Promise<PutResult> {
      const headers: Record<string, string> = {};
      if (opts.contentType) headers["Content-Type"] = opts.contentType;
      if (opts.replace) headers["X-Uploads-Replace"] = "1";
      if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
      for (const [k, v] of Object.entries(opts.metadata ?? {})) {
        if (v !== undefined && v !== "") headers[`X-Uploads-Meta-${k}`] = v;
      }
      const result = await request<PutResult>("PUT", `${filesBase}/${encodeKeyPath(key)}`, {
        // DOM's BodyInit only names `Uint8Array<ArrayBuffer>`; every runtime's fetch takes any view.
        body: body as BodyInit,
        headers,
        longTimeout: true,
      });
      return { ...result, embedUrl: result.embedUrl ?? null, replaced: result.replaced === true };
    },

    /** Where a put to `key` would land and whether it would overwrite, without writing. */
    async previewPut(key: string, opts: { replace?: boolean } = {}): Promise<PutPreview> {
      const qs = opts.replace ? "dryRun=1&replace=1" : "dryRun=1";
      return request<PutPreview>("PUT", `${filesBase}/${encodeKeyPath(key)}?${qs}`);
    },

    list,

    /** Follow cursors (optionally starting from one) and return every remaining item. */
    async listAll(opts: ListOptions = {}): Promise<ListItem[]> {
      const items: ListItem[] = [];
      let cursor: string | undefined = opts.cursor;
      do {
        const page = await list({ ...opts, cursor });
        items.push(...page.items);
        cursor = page.cursor ?? undefined;
      } while (cursor);
      return items;
    },

    async head(key: string): Promise<HeadResult> {
      return request<HeadResult>("GET", `${filesBase}/${encodeKeyPath(key)}`);
    },

    async delete(key: string): Promise<DeleteResult> {
      return request<DeleteResult>("DELETE", `${filesBase}/${encodeKeyPath(key)}`);
    },

    /** Files held for review, optionally under one key prefix. */
    async listHeld(prefix?: string): Promise<HeldFile[]> {
      const query = prefix ? `?prefix=${encodeURIComponent(prefix)}` : "";
      const result = await request<{ items: HeldFile[] }>("GET", `${filesBase}/held${query}`);
      return result.items;
    },

    /** Release a file held for review (a likely secret or personal data). */
    async approve(key: string): Promise<ApproveResult> {
      return request<ApproveResult>("POST", `${filesBase}/approve?key=${encodeURIComponent(key)}`);
    },

    /** The file's queryable metadata. */
    async getMetadata(key: string): Promise<GetMetadataResult> {
      return request<GetMetadataResult>("GET", `${filesBase}/${encodeKeyPath(key)}?metadata=1`);
    },

    /** Merge `set` and `delete` into the file's metadata; returns the merged map. */
    async patchMetadata(key: string, opts: PatchMetadataOptions): Promise<GetMetadataResult> {
      return request<GetMetadataResult>(
        "PATCH",
        `${filesBase}/${encodeKeyPath(key)}`,
        jsonBody(opts),
      );
    },

    /**
     * ANDed metadata equality filters and/or a filename substring (at least
     * one). Pages are capped server-side; `cursor` continues, null on the
     * last page.
     */
    findFiles,

    /**
     * `findFiles` followed through its `cursor`, up to `maxPages` (default
     * `FIND_FILES_MAX_PAGES`). A non-null returned `cursor` means the cap
     * stopped early. An invalid `maxPages` uses the default.
     */
    async findFilesAll(
      filters: Record<string, string> = {},
      opts: FindFilesOptions = {},
      maxPages: number = FIND_FILES_MAX_PAGES,
    ): Promise<FindFilesResult> {
      const items: FindFilesItem[] = [];
      let cursor: string | undefined = opts.cursor;
      let truncated: boolean | undefined;
      const pages =
        Number.isFinite(maxPages) && maxPages >= 1 ? Math.floor(maxPages) : FIND_FILES_MAX_PAGES;
      for (let page = 0; page < pages; page += 1) {
        const result: FindFilesResult = await findFiles(filters, { ...opts, cursor });
        items.push(...result.items);
        truncated = result.truncated;
        cursor = result.cursor ?? undefined;
        if (!cursor) break;
      }
      return { items, cursor: cursor ?? null, ...(truncated === undefined ? {} : { truncated }) };
    },

    /** The workspace's metadata keys. */
    async listMetadataKeys(): Promise<MetadataKeysResult> {
      return request<MetadataKeysResult>("GET", `${filesBase}/facets`);
    },

    /** Distinct values for one metadata key. */
    async listMetadataValues(key: string): Promise<MetadataValuesResult> {
      return request<MetadataValuesResult>(
        "GET",
        `${filesBase}/facets?${new URLSearchParams({ key })}`,
      );
    },

    async createGallery(opts: CreateGalleryOptions): Promise<Gallery> {
      const { idempotencyKey = crypto.randomUUID(), ...body } = opts;
      const req = jsonBody(body);
      return request<Gallery>("POST", galleriesBase, {
        ...req,
        headers: { ...req.headers, "Idempotency-Key": idempotencyKey },
      });
    },

    async getGallery(id: string): Promise<Gallery> {
      return request<Gallery>("GET", `${galleriesBase}/${encodeURIComponent(id)}`);
    },

    async listGalleries(opts: GalleryListOptions = {}): Promise<GalleryListResult> {
      const params = new URLSearchParams();
      if (opts.limit != null) params.set("limit", String(opts.limit));
      if (opts.cursor) params.set("cursor", opts.cursor);
      const qs = params.toString();
      return request<GalleryListResult>("GET", `${galleriesBase}${qs ? `?${qs}` : ""}`);
    },

    async deleteGallery(
      id: string,
      opts: DeleteGalleryOptions,
    ): Promise<{ deleted: boolean; id: string }> {
      return request("DELETE", `${galleriesBase}/${encodeURIComponent(id)}`, jsonBody(opts));
    },

    async addGalleryItem(
      id: string,
      objectKey: string,
      opts: AddGalleryItemOptions,
    ): Promise<GalleryItem> {
      return request<GalleryItem>(
        "POST",
        `${galleriesBase}/${encodeURIComponent(id)}/items`,
        jsonBody({ objectKey, ...opts }),
      );
    },

    async listGalleryExternalReferences(id: string): Promise<GalleryExternalReferenceListResult> {
      return request("GET", `${galleriesBase}/${encodeURIComponent(id)}/external-references`);
    },

    async linkGalleryExternalReference(
      id: string,
      opts: LinkGalleryExternalReferenceOptions,
    ): Promise<GalleryExternalReference> {
      return request(
        "POST",
        `${galleriesBase}/${encodeURIComponent(id)}/external-references`,
        jsonBody(opts),
      );
    },

    async unlinkGalleryExternalReference(
      id: string,
      referenceId: string,
      opts: UnlinkGalleryExternalReferenceOptions,
    ): Promise<{ deleted: boolean; id: string }> {
      return request(
        "DELETE",
        `${galleriesBase}/${encodeURIComponent(id)}/external-references/${encodeURIComponent(referenceId)}`,
        jsonBody(opts),
      );
    },

    async findGalleriesByReference(
      opts: FindGalleriesByReferenceOptions,
    ): Promise<GalleryListResult> {
      const params = new URLSearchParams({ provider: opts.provider, coordinate: opts.coordinate });
      if (opts.limit != null) params.set("limit", String(opts.limit));
      if (opts.cursor) params.set("cursor", opts.cursor);
      return request<GalleryListResult>("GET", `${galleriesBase}/by-reference?${params}`);
    },

    async createFeed(opts: CreateFeedOptions): Promise<Feed> {
      return request<Feed>("POST", feedsBase, jsonBody(opts));
    },

    async getFeed(id: string): Promise<Feed> {
      return request<Feed>("GET", `${feedsBase}/${encodeURIComponent(id)}`);
    },

    async listFeeds(opts: FeedListOptions = {}): Promise<FeedListResult> {
      const params = new URLSearchParams();
      if (opts.limit != null) params.set("limit", String(opts.limit));
      if (opts.cursor) params.set("cursor", opts.cursor);
      const qs = params.toString();
      return request<FeedListResult>("GET", `${feedsBase}${qs ? `?${qs}` : ""}`);
    },

    async deleteFeed(id: string): Promise<{ deleted: boolean; id: string }> {
      return request("DELETE", `${feedsBase}/${encodeURIComponent(id)}`);
    },

    /**
     * Create or update the managed uploads.sh comment on a PR or issue. Call
     * it once after uploading. `resync: true` searches for the comment and
     * collapses duplicates instead of patching the cached one.
     */
    async upsertGithubComment(opts: {
      repo: string;
      num: number;
      kind: "pull" | "issues";
      resync?: boolean;
    }): Promise<GithubCommentResult> {
      return request<GithubCommentResult>(
        "POST",
        `${workspaceBase}/github/comment`,
        jsonBody(opts),
      );
    },

    async health(): Promise<HealthResult> {
      return request<HealthResult>("GET", `${apiUrl}/health`, { auth: false });
    },

    /** Workspace storage and upload counters, plus limits when configured. */
    async usage(): Promise<UsageResult> {
      return request<UsageResult>("GET", usageBase);
    },

    /** Rebuild ledger bytes/objects from storage (source of truth). Token only. */
    async reconcile(): Promise<ReconcileResult> {
      return request<ReconcileResult>("POST", `${usageBase}/reconcile`);
    },

    /** Delete objects past retentionDays (if set), then reconcile. Token only. */
    async purgeExpired(): Promise<PurgeExpiredResponse> {
      return request<PurgeExpiredResponse>("POST", `${usageBase}/purge-expired`);
    },
  };
}

export type UploadsClient = ReturnType<typeof createUploadsClient>;
