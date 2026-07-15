import { InsufficientScopeError, UnauthorizedError } from "@uploads/errors";
import type { MiddlewareHandler } from "hono";
import type { StorageProvider } from "@uploads/storage";
import { FILE_SCOPES, findActiveToken, parseScopes, type FileScope } from "./auth-db";

export type { FileScope } from "./auth-db";

/**
 * A workspace is a tenant: its own bucket, credentials, and auth token.
 * Records live in the REGISTRY KV namespace under `ws:<name>`; secrets in the
 * record are a SHA-256 token hash plus (optional) bucket-scoped S3 keys.
 */
export interface WorkspaceRecord {
  provider: StorageProvider;
  bucket: string;
  /** Name of an R2 binding declared in wrangler.jsonc (e.g. "UPLOADS"). When set, I/O uses the binding. */
  binding?: string;
  /** Key prefix inside the bucket (e.g. "myws/"). Set for shared-bucket workspaces; all I/O is confined under it. */
  prefix?: string;
  /** Public custom domain for this workspace's bucket. */
  publicBaseUrl?: string;
  /** Bearer tokens valid for this workspace. */
  tokens?: { hash: string; label?: string; createdAt: string }[];
  /** @deprecated legacy single-token field; still honored on read. */
  tokenHash?: string;
  /** HTTP credentials — presigning, or I/O for workspaces without a binding. */
  accountId?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Max bytes for a single image upload. Falls back to DEFAULT_MAX_UPLOAD_BYTES. */
  maxUploadBytes?: number;
  /**
   * Max bytes for video/mp4 and video/webm. When unset, videos use maxUploadBytes.
   */
  maxVideoUploadBytes?: number;
  /** Allowed (sniffed) content types. Falls back to DEFAULT_ALLOWED_CONTENT_TYPES. */
  allowedContentTypes?: string[];
  /**
   * Cap on net stored bytes for this workspace. Omit for unlimited.
   * Enforced on put against the usage ledger (see budget.ts / usage.ts).
   */
  maxStorageBytes?: number;
  /**
   * Cap on successful puts in the current UTC calendar month. Omit for unlimited.
   */
  maxUploadsPerPeriod?: number;
  /**
   * Delete objects whose last-modified is older than this many days when
   * purge-expired runs. Omit to skip retention. Configure via workspace:limits.
   */
  retentionDays?: number;
  /**
   * When true/undefined, bare keys (no `/`) become `f/<id>/<name>`. Set false
   * to allow root basenames (not recommended on shared buckets).
   */
  autoPrefixBareKeys?: boolean;
  /**
   * When set (non-empty), put/sign keys must start with one of these prefixes
   * after bare-key governance. Entries may omit the trailing `/`. Operator
   * tooling accepts `"default"` → `f/`, `screenshots/`, `gh/`. Omit = any path.
   */
  allowedKeyPrefixes?: string[];
  /**
   * Max `/`-separated path segments on put/sign after governance (e.g. 8).
   * Omit = only structural key validation (`badKey`).
   */
  maxKeyDepth?: number;
  /** True for workspaces provisioned by the self-serve flow (POST /v1/workspaces). */
  selfServe?: boolean;
  /** Better Auth user id that created this workspace via self-serve. */
  createdByUserId?: string;
  /** ISO timestamp of self-serve creation. */
  createdAt?: string;
}

export type WorkspaceVars = {
  Variables: {
    workspace: WorkspaceRecord;
    workspaceName: string;
    authScopes: FileScope[];
    authSource: "d1" | "legacy";
  };
  Bindings: Env;
};

/** Canonical workspace-name shape (lowercase, 2–63 chars). Shared so callers
 * that validate a name — `loadWorkspaceRecord` here, the token-mint route —
 * don't drift from one another. */
export const WS_NAME_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** All valid token hashes for a workspace (new list + legacy single field). */
export function workspaceTokenHashes(record: WorkspaceRecord): string[] {
  return record.tokens?.map((t) => t.hash) ?? (record.tokenHash ? [record.tokenHash] : []);
}

function bearerToken(header: string | undefined): string {
  return header?.startsWith("Bearer ") ? header.slice(7) : "";
}

/** Workspace name encoded in a bearer token (`up_<name>_…`), if well-formed. */
export function workspaceNameFromToken(token: string): string | undefined {
  const match = /^up_([a-z0-9][a-z0-9-]{1,62})_./.exec(token);
  return match?.[1];
}

/**
 * Verifies the bearer token against the named workspace's stored token
 * hashes and puts the record on the context. 401 for unknown workspaces only
 * after the token check, so probing for workspace names requires no fewer
 * requests than probing tokens. `nameOf` supplies the workspace name —
 * from the path for the REST API, or from the token itself for endpoints
 * without a workspace segment (the remote MCP worker's `/mcp`).
 */
/**
 * Loads a workspace record from the REGISTRY KV (`ws:<name>`), or null for an
 * unknown/malformed name. The single source of truth for that lookup —
 * `workspaceAuthWith` below and `src/routes/me.ts` (session-authenticated
 * usage surface) both go through this rather than duplicating the KV read.
 */
export async function loadWorkspaceRecord(
  env: Env,
  name: string | undefined,
): Promise<WorkspaceRecord | null> {
  if (!name || !WS_NAME_RE.test(name)) return null;
  return env.REGISTRY.get<WorkspaceRecord>(`ws:${name}`, { type: "json", cacheTtl: 60 });
}

function workspaceAuthWith(
  nameOf: (c: Parameters<MiddlewareHandler<WorkspaceVars>>[0], token: string) => string | undefined,
): MiddlewareHandler<WorkspaceVars> {
  return async (c, next) => {
    const token = bearerToken(c.req.header("Authorization"));
    const name = nameOf(c, token);

    const record = await loadWorkspaceRecord(c.env, name);

    const providedHash = await sha256Hex(token);
    const providedBytes = hexToBytes(providedHash);
    const candidates = record ? workspaceTokenHashes(record) : [];
    // Compare against every candidate hash (no early break) so match position isn't timing-visible.
    // Note: total work scales with token count — acceptable for this throwaway PoC; a leaked
    // token-count signal goes away with the real auth system.
    const toCheck = candidates.length > 0 ? candidates : [providedHash.replace(/./g, "0")];
    let matched = false;
    for (const hash of toCheck) {
      if (crypto.subtle.timingSafeEqual(providedBytes, hexToBytes(hash))) matched = true;
    }
    const legacyOk = record !== null && token.length > 0 && candidates.length > 0 && matched;
    // Always pay the D1 round-trip, with dummy inputs when the workspace is
    // unknown or the token empty, so response latency doesn't reveal whether
    // a workspace name exists (uniform-401 guarantee above).
    const d1Token = await findActiveToken(
      c.env.DB,
      record && name ? name : "__unknown__",
      token || "__unknown__",
    );
    const ok = legacyOk || (record !== null && d1Token !== null);

    if (!ok || !record || !name) throw new UnauthorizedError();

    c.set("workspace", record);
    c.set("workspaceName", name);
    c.set("authScopes", d1Token ? parseScopes(d1Token.scopes) : [...FILE_SCOPES]);
    c.set("authSource", d1Token ? "d1" : "legacy");
    await next();
  };
}

/** Resolves `:workspace` from the path (the REST API's routes). */
export const workspaceAuth = workspaceAuthWith((c) => c.req.param("workspace"));

/** Resolves the workspace from the bearer token itself (`up_<name>_…`). */
export const tokenWorkspaceAuth = workspaceAuthWith((_c, token) => workspaceNameFromToken(token));

export function requireScope(scope: FileScope): MiddlewareHandler<WorkspaceVars> {
  return async (c, next) => {
    if (!c.get("authScopes").includes(scope)) {
      throw new InsufficientScopeError(scope, "forbidden");
    }
    await next();
  };
}
