import { inferContentType } from "./embed.js";
import type { UploadsClientConfig } from "./config.js";
import { UploadsError } from "./errors.js";
import { buildScreenshotKey } from "./keys.js";

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
}

export interface ListOptions {
  prefix?: string;
  limit?: number;
  cursor?: string;
}

export interface PutResult {
  workspace: string;
  key: string;
  url: string;
  size: number;
  contentType: string;
  metadata?: Record<string, string>;
}

export interface ListItem {
  key: string;
  url: string | null;
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
  size: number;
  contentType: string;
  uploaded?: string;
  metadata?: Record<string, string>;
}

export interface DeleteResult {
  key: string;
  deleted: boolean;
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
  code: string;
  expiresAt: string;
  tokenExpiresAt: string;
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

function encodeKeyPath(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

function filesBase(config: UploadsClientConfig): string {
  return `${config.apiUrl}/v1/${encodeURIComponent(config.workspace)}/files`;
}

function usageBase(config: UploadsClientConfig): string {
  return `${config.apiUrl}/v1/${encodeURIComponent(config.workspace)}/usage`;
}

function mapApiError(status: number, error: string, code?: string): UploadsError {
  const normalized = error.toLowerCase();
  if (status === 401 || normalized === "unauthorized") {
    return new UploadsError(error, "UNAUTHORIZED", status);
  }
  if (status === 404 || normalized === "not found") {
    return new UploadsError(error, "NOT_FOUND", status);
  }
  if (status === 400 && normalized === "invalid key") {
    return new UploadsError(error, "INVALID_KEY", status);
  }
  if (code === "key_prefix_not_allowed" || code === "key_too_deep") {
    return new UploadsError(error, "KEY_POLICY", status);
  }
  // Prefer stable body.code — bare 429 is also used for write rate limits.
  if (status === 507 || code === "storage_quota_exceeded") {
    return new UploadsError(error, "STORAGE_QUOTA", status);
  }
  if (code === "upload_budget_exceeded") {
    return new UploadsError(error, "UPLOAD_BUDGET", status);
  }
  return new UploadsError(error, "API_ERROR", status);
}

async function parseErrorResponse(res: Response): Promise<UploadsError> {
  const body = await res.json().catch(() => ({}));
  const message =
    typeof body === "object" && body && "error" in body && typeof body.error === "string"
      ? body.error
      : res.statusText || "request failed";
  const code =
    typeof body === "object" && body && "code" in body && typeof body.code === "string"
      ? body.code
      : undefined;
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
    return request<ListResult>("GET", `${filesBase(config)}${qs ? `?${qs}` : ""}`);
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
      const headers: Record<string, string> = { "Content-Type": contentType };
      if (opts.provenance) {
        for (const [k, v] of Object.entries(opts.provenance)) {
          if (v !== undefined && v !== "") headers[`X-Uploads-Meta-${k}`] = v;
        }
      }

      const result = await request<{
        workspace: string;
        key: string;
        url: string | null;
        size: number;
        contentType: string;
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

      return { ...result, url: result.url };
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

    async head(key: string): Promise<HeadResult> {
      return request<HeadResult>("GET", `${filesBase(config)}/${encodeKeyPath(key)}`);
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
