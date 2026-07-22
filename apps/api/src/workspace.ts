import { ForbiddenError, InsufficientScopeError, UnauthorizedError } from "@uploads/errors";
import type { MiddlewareHandler } from "hono";
import type { StorageProvider } from "@uploads/storage";
import {
  FILE_SCOPES,
  findActiveToken,
  isWorkspaceScope,
  parseScopes,
  type FileScope,
  type WorkspaceScope,
} from "./auth-db";

export type { FileScope } from "./auth-db";

/**
 * A workspace is a tenant: its own bucket, credentials, and auth token.
 * Records live in the REGISTRY KV namespace under `ws:<name>`; secrets in the
 * record are a SHA-256 token hash plus (optional) bucket-scoped S3 keys.
 */
export interface WorkspaceRecord {
  /**
   * The registry slug this record was loaded under; stamped by the loaders
   * from the validated lookup key, not read from stored JSON. Absent only on
   * records built outside the loaders.
   */
  name?: string;
  /**
   * Optimistic-concurrency counter, bumped on every write through
   * `mutateWorkspaceRecord` (issue #387). Absent on records last written
   * before versioning — treated as 0, never backfilled. Nothing reads it for
   * behavior; it exists so a write can tell whether the blob it just stored is
   * still the one in KV. See `workspace-mutate.ts`.
   */
  version?: number;
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
   * Subscription plan (spec 2026-07-22, billing infrastructure). Absent
   * means `free`. Admin-only to change today (no self-serve upgrade path
   * exists); an unrecognized string is treated as `free` at read time by
   * `@uploads/billing`'s `getPlan` — never a lockout.
   */
  plan?: "free" | "pro";
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
  /**
   * Governs the managed GitHub-comment attachment click-through target only
   * (issue #304). When `false`, managed-comment attachments link to raw
   * object bytes instead of the `/f/` file page. Default (undefined/true) =
   * link to the file page (issue #301's behavior). Does not affect gallery
   * links or any non-comment surface.
   */
  githubCommentLinkToFilePage?: boolean;
  /**
   * Governs whether the managed GitHub comment shows an upload's canonical
   * `path`/`state` metadata (issue #365). Default (undefined/true) = show.
   * When `false`, the comment renders filenames only and the server skips the
   * metadata read entirely. Deliberately narrow: no other canonical key is
   * ever read for this surface, because the comment is posted publicly on
   * repos whose visibility uploads.sh does not check.
   */
  githubCommentShowMetadata?: boolean;
  /**
   * Per-workspace opt-out for video poster generation (issue #299). Default
   * (undefined/true) generates. The surgical kill switch between "all
   * workspaces" (Flagship) and "nothing" (removing the MEDIA binding).
   */
  videoPosterEnabled?: boolean;
  /** Set by `DELETE /admin/workspaces/:name` (default/soft mode). Present → the workspace is soft-deleted. */
  deletedAt?: string;
  /** `deletedAt` + the grace window (`WORKSPACE_DELETE_GRACE_DAYS`); the retention sweep finalizes at/after this. */
  purgeAt?: string;
}

/** Days a soft-deleted workspace's data is retained before the retention sweep finalizes it. */
export const WORKSPACE_DELETE_GRACE_DAYS = 14;

/**
 * Minimal permanent tombstone left under `ws:<name>` once a soft-deleted
 * workspace is finalized (or hard-deleted with `replaceWithTombstone`) —
 * intentionally not a full `WorkspaceRecord`. Its mere presence is what keeps
 * a slug reserved for registration checks; see `apps/api/src/workspace-teardown.ts`.
 */
export interface PurgedTombstone {
  status: "purged";
  name: string;
  purgedAt: string;
  deletedAt?: string;
}

/** True for a purged tombstone written after finalization. */
export function isPurgedTombstone(
  record: WorkspaceRecord | PurgedTombstone | null,
): record is PurgedTombstone {
  return record !== null && (record as PurgedTombstone).status === "purged";
}

export type WorkspaceVars = {
  Variables: {
    workspace: WorkspaceRecord;
    workspaceName: string;
    authScopes: FileScope[];
    authSource: "d1" | "legacy";
    /** Better Auth user behind the bearer token (issue #340), or null. */
    mintingUserId: string | null;
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
  const record = await env.REGISTRY.get<WorkspaceRecord | PurgedTombstone>(`ws:${name}`, {
    type: "json",
    cacheTtl: 60,
  });
  // Soft-deleted and purged-tombstone records deny access exactly like an
  // unknown workspace (uniform 404/401 across every auth/serving path) while
  // still occupying the KV key, so the slug can't be re-registered.
  if (!record || isPurgedTombstone(record) || record.deletedAt) return null;
  // Stamp the slug from the validated lookup key, never from the stored
  // JSON — the key is the source of truth even if the blob is stale/hand-edited.
  return { ...record, name };
}

/**
 * Unfiltered read of `ws:<name>` — used by admin routes and the retention
 * sweep, which need to see soft-deleted records and purged tombstones rather
 * than have them collapsed to "not found". No `cacheTtl`: these callers act
 * on the record (restore, finalize) and can't tolerate a stale hit.
 */
export async function loadWorkspaceRecordRaw(
  env: Env,
  name: string | undefined,
): Promise<WorkspaceRecord | PurgedTombstone | null> {
  if (!name || !WS_NAME_RE.test(name)) return null;
  const record = await env.REGISTRY.get<WorkspaceRecord | PurgedTombstone>(`ws:${name}`, {
    type: "json",
  });
  if (!record || isPurgedTombstone(record)) return record;
  // Stamp the slug from the validated lookup key (same rule as loadWorkspaceRecord);
  // tombstones are left untouched — they're not a WorkspaceRecord.
  return { ...record, name };
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
    // Uploader attribution (issue #340) — null for legacy/enrollment tokens.
    c.set("mintingUserId", d1Token?.minting_user_id ?? null);
    await next();
  };
}

/** Resolves `:workspace` from the path (the REST API's routes). */
export const workspaceAuth = workspaceAuthWith((c) => c.req.param("workspace"));

/** Resolves the workspace from the bearer token itself (`up_<name>_…`). */
export const tokenWorkspaceAuth = workspaceAuthWith((_c, token) => workspaceNameFromToken(token));

/** Stamped-field result of `stampSoftDelete`/`stampRestore` — the caller writes it back to KV. */
export interface SoftDeleteStamp {
  deletedAt: string;
  purgeAt: string;
}

/**
 * Stamps `deletedAt`/`purgeAt` (grace window) onto a workspace record. Shared
 * by the admin soft-delete path (`routes/admin.ts`) and the self-serve delete
 * path (`routes/workspaces.ts`) so the two can't drift on the stamp shape or
 * grace-window math.
 */
export function stampSoftDelete(
  record: WorkspaceRecord,
  now: Date = new Date(),
): WorkspaceRecord & SoftDeleteStamp {
  const deletedAt = now.toISOString();
  const purgeAt = new Date(
    now.getTime() + WORKSPACE_DELETE_GRACE_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  return { ...record, deletedAt, purgeAt };
}

/**
 * True once `purgeAt` has passed (grace window expired) — restoring must
 * refuse past this point even if the retention sweep hasn't finalized yet.
 * An unparseable `purgeAt` is treated as still-restorable (repairing a
 * malformed record is exactly what restore is for).
 */
export function isPastGrace(purgeAt: string | undefined, now: Date = new Date()): boolean {
  if (!purgeAt) return false;
  const purgeAtMs = Date.parse(purgeAt);
  if (!Number.isFinite(purgeAtMs)) return false;
  return now.getTime() >= purgeAtMs;
}

/**
 * Clears `deletedAt`/`purgeAt` off a record — shared by the admin and
 * self-serve restore paths.
 */
export function stampRestore(record: WorkspaceRecord): WorkspaceRecord {
  const { deletedAt: _deletedAt, purgeAt: _purgeAt, ...rest } = record;
  return rest;
}

export function requireScope(scope: FileScope): MiddlewareHandler<WorkspaceVars> {
  return async (c, next) => {
    if (!c.get("authScopes").includes(scope)) {
      throw new InsufficientScopeError(scope, "forbidden");
    }
    await next();
  };
}

/** Vars set by `workspaceGovernanceAuth` on a matched `workspace:*`-scoped token. */
export type GovernanceVars = {
  Variables: {
    /** `minting_user_id` of the D1 token record — invites/actions act as this user (issue #262). */
    governanceMintingUserId: string | null;
  };
  Bindings: Env;
};

/**
 * Guards a `/…/:name/…` route with a D1-backed `workspace:*`-scoped bearer
 * token (issue #262). Distinct from `tokenWorkspaceAuth`/`requireScope`
 * (file-plane, `parseScopes` fail-closed on non-file scopes) — a governance
 * token carries zero file access and this guard never touches `authScopes`.
 *
 * Rejects: missing/malformed bearer (401), no active D1 token for the
 * token's own workspace — revoked/expired/unknown (401), token workspace !==
 * the `:name` route param (403), and active tokens missing the required
 * `workspace:*` scope — including file-only or operator-only tokens, which
 * carry zero workspace scopes (403).
 */
export function workspaceGovernanceAuth(scope: WorkspaceScope): MiddlewareHandler<GovernanceVars> {
  return async (c, next) => {
    const token = bearerToken(c.req.header("Authorization"));
    const tokenWorkspace = token ? workspaceNameFromToken(token) : undefined;
    if (!tokenWorkspace) throw new UnauthorizedError();

    const record = await findActiveToken(c.env.DB, tokenWorkspace, token);
    if (!record) throw new UnauthorizedError();

    const name = c.req.param("name");
    if (tokenWorkspace !== name) throw new ForbiddenError();

    let parsed: unknown;
    try {
      parsed = JSON.parse(record.scopes);
    } catch {
      parsed = [];
    }
    const scopes = new Set(Array.isArray(parsed) ? parsed.filter(isWorkspaceScope) : []);
    if (!scopes.has(scope)) throw new ForbiddenError();

    c.set("governanceMintingUserId", record.minting_user_id);
    await next();
  };
}
