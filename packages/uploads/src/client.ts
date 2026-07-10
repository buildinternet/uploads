import { inferContentType } from "./embed.js";
import type { UploadsClientConfig } from "./config.js";
import { UploadsError } from "./errors.js";
import { buildScreenshotKey } from "./keys.js";

export interface PutOptions {
  key?: string;
  contentType?: string;
  prefix?: string;
  repo?: string;
  ref?: string;
  deriveRepoFromGit?: boolean;
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
}

export interface DeleteResult {
  key: string;
  deleted: boolean;
}

export interface HealthResult {
  ok: boolean;
}

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

function mapApiError(status: number, error: string): UploadsError {
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
  return new UploadsError(error, "API_ERROR", status);
}

async function parseErrorResponse(res: Response): Promise<UploadsError> {
  const body = await res.json().catch(() => ({}));
  const message =
    typeof body === "object" && body && "error" in body && typeof body.error === "string"
      ? body.error
      : res.statusText || "request failed";
  return mapApiError(res.status, message);
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

      const result = await request<{
        workspace: string;
        key: string;
        url: string | null;
        size: number;
        contentType: string;
      }>("PUT", `${filesBase(config)}/${encodeKeyPath(key)}`, {
        body,
        headers: { "Content-Type": contentType },
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

    async list(opts: ListOptions = {}): Promise<ListResult> {
      const params = new URLSearchParams();
      if (opts.prefix) params.set("prefix", opts.prefix);
      if (opts.limit != null) params.set("limit", String(opts.limit));
      if (opts.cursor) params.set("cursor", opts.cursor);
      const qs = params.toString();
      return request<ListResult>("GET", `${filesBase(config)}${qs ? `?${qs}` : ""}`);
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
  };
}

export type UploadsClient = ReturnType<typeof createUploadsClient>;
