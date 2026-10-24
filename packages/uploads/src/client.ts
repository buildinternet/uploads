import { inferContentType } from "./embed.js";
import type { UploadsClientConfig } from "./config.js";
import { UsageError } from "./cli-args.js";
import { UploadsError } from "./errors.js";
import { buildScreenshotKey } from "./keys.js";
import { packageVersion } from "./package-version.js";
import { resolveEmbedUrl } from "./public-urls.js";

/** Scoped-operator-token permission scope. */
export type TokenScope =
  | "files:read"
  | "files:write"
  | "files:delete"
  | "operator:read"
  | "operator:write"
  | "workspace:invite"
  | "workspace:manage";

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
   * Queryable metadata (D1), sent as more `X-Uploads-Meta-<key>` headers; the
   * server routes each key to R2 provenance or D1 by name. Validate with
   * `metadata.ts` first.
   */
  metadata?: Record<string, string>;
  /** Validate key + resolve public URL without writing. `size` is local bytes only. */
  dryRun?: boolean;
  /**
   * Overwrite an existing object on a strict (non-`gh/`) key. Without it such
   * a put throws `UploadsError` `KEY_EXISTS`. Managed `gh/` paths always
   * hot-swap.
   */
  replace?: boolean;
  /** Reuse to safely retry the same upload. Not generated; omit and no header is sent. */
  idempotencyKey?: string;
}

export interface ListOptions {
  prefix?: string;
  limit?: number;
  cursor?: string;
  /** Hydrate each row's queryable D1 metadata (`?metadata=1`). */
  metadata?: boolean;
}

/** Page cap for `findFilesAll` / `uploads find --all`, so draining search stays bounded. */
export const FIND_FILES_MAX_PAGES = 20;

export interface FindFilesOptions {
  prefix?: string;
  limit?: number;
  /**
   * Case-insensitive substring match on object keys (`?name=`).
   * At least one of non-empty `filters` or `name` is required.
   */
  name?: string;
  /**
   * Opaque continuation from a previous result. Pass it back unchanged with
   * the same filters/name/prefix; don't hand-build one.
   */
  cursor?: string;
}

export interface FindFilesItem {
  key: string;
  url: string | null;
  metadata: Record<string, string>;
}

export interface FindFilesResult {
  items: FindFilesItem[];
  cursor: string | null;
  /** Present when a `name` term was used — true if the underlying query hit its cap. */
  truncated?: boolean;
}

export interface MetadataKeysResult {
  keys: Array<{ key: string; count: number; distinctValues: number }>;
  truncated: boolean;
}

export interface MetadataValuesResult {
  key: string;
  values: Array<{ value: string; count: number }>;
  truncated: boolean;
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
   * `pending` when the classifier may still hold this file for review. It
   * decides after the response; `uploads approve --pr <n>` lists holds.
   */
  holdCheck?: "pending";
  /**
   * True when the put overwrote an existing key, or (with dryRun) when a put
   * at this key would overwrite. Always set by the API for put/dry-run.
   */
  replaced?: boolean;
  /**
   * dryRun only: true when a real put at this key would be refused (strict
   * non-`gh/` key, existing object, no `replace`) instead of overwriting.
   */
  wouldRefuse?: boolean;
  /**
   * The R2 provenance bag (`client`, `source-name`, `content-sha256`). Absent
   * on a dry run and on older APIs.
   */
  provenance?: Record<string, string>;
  /**
   * The queryable metadata this put stored, including server-derived pairs
   * (`gh.uploader`). Absent when the put carried no metadata, since existing
   * tags were left untouched. Older APIs return the provenance bag here
   * instead, so read `path`-style tags defensively.
   */
  metadata?: Record<string, string>;
}

export interface ListItem {
  key: string;
  url: string | null;
  embedUrl?: string | null;
  /** Canonical `/f/` page URL when the API provides it. Absent on older API deployments. */
  pageUrl?: string;
  size?: number;
  uploaded?: string;
  /** Present only when listed with `metadata: true`, and only for keys that have rows. */
  metadata?: Record<string, string>;
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
  /** The R2 provenance bag. Queryable metadata needs `getMetadata(key)`. */
  provenance?: Record<string, string>;
}

export interface DeleteResult {
  key: string;
  deleted: boolean;
}

/** One row of `GET /v1/workspaces/:workspace/files/held`. */
export interface HeldFile {
  key: string;
  /** `secret: api_key`, `pii: financial`, or null. */
  reason: string | null;
  /** True when the bytes moved out of the public bucket while held. */
  moved: boolean;
}

/**
 * `POST /v1/workspaces/:workspace/files/approve?key=`. `approved: false`
 * with `reason: "not_held"` means the file was not held (already approved,
 * never flagged, or unknown).
 */
export type ApproveResult =
  | { key: string; approved: true }
  | { key: string; approved: false; reason: "not_held" };

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
  /** Reuse this key to safely retry the same create request. Generated when omitted. */
  idempotencyKey?: string;
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

/** A workspace-owned, query-backed public repo change feed. */
export interface FeedItem {
  id: string;
  objectKey: string;
  filename: string;
  status: "available" | "missing" | "withheld";
  url: string | null;
  embedUrl: string | null;
  /** Canonical `/c/<id>/<item>` page when the API computed one. */
  pageUrl?: string;
  contentType: string | null;
  size: number | null;
  uploaded: string | null;
  modified: string | null;
  path: string | null;
  state: string | null;
  posterUrl?: string;
  videoDimensions?: { width: number; height: number };
}

export interface Feed {
  id: string;
  /** Canonical public URL returned by the API; clients must not construct it. */
  url: string;
  workspace: string;
  repo: string;
  path: string | null;
  number: number | null;
  kind: "pull" | "issue" | null;
  title: string;
  createdAt: string;
  updatedAt: string;
  items: FeedItem[];
}

export type FeedSummary = Omit<Feed, "items">;

export interface FeedListOptions {
  limit?: number;
  cursor?: string;
}

export interface FeedListResult {
  feeds: FeedSummary[];
  nextCursor: string | null;
}

export interface CreateFeedOptions {
  repo: string;
  path?: string | null;
  number?: number | null;
  kind?: "pull" | "issue" | null;
  pr?: number | null;
  issue?: number | null;
}

/**
 * Reasons the bot didn't post. The CLI falls back to local `gh` for all but
 * `not_authorized` (repo bound to another workspace), where the user's own
 * credentials would bypass the server-side gate.
 */
export type GithubCommentDeclineReason =
  | "app_unconfigured"
  | "not_installed"
  | "forbidden"
  | "not_authorized"
  | "actor_not_authorized"
  | "unavailable";

export type GithubCommentResult =
  | {
      posted: true;
      action: "created" | "updated" | "skipped";
      count: number;
      commentUrl?: string;
      /** Files on the PR or issue held for review, when any. */
      held?: number;
    }
  | {
      posted: false;
      reason: GithubCommentDeclineReason;
      // On `forbidden` (App installed, write pending approval): a message and
      // fix link for the CLI to show.
      message?: string;
      fixUrl?: string;
      required?: string[];
    };

/** `POST /v1/workspaces/:workspace/github/private-prefix` request. */
export interface ResolveGhPrefixOptions {
  repo: string;
  branch?: string;
  target?: { kind: "pull" | "issues"; num: number };
}

/** `POST /v1/workspaces/:workspace/github/private-prefix` response. */
export type ResolveGhPrefixResult =
  | { mode: "plain" }
  | {
      mode: "private";
      prefixId: string;
      /**
       * Ids the caller may list: with a target, those that can hold it; with
       * only a branch, that branch's (a private staged key has no branch
       * segment). Older workers may return every active id in the repo.
       */
      activePrefixIds?: string[];
      /**
       * This branch's ids (active, then retired), on a branch resolve with no
       * target. Prefer it for `uploads staged`.
       */
      branchPrefixIds?: string[];
    };

/** `POST /v1/workspaces/:workspace/github/private-prefix/rotate` request. */
export interface RotateGhPrefixOptions {
  repo: string;
  /** Mutually exclusive with `repoLevel`: rotate one branch's id. */
  branch?: string;
  /** Mutually exclusive with `branch`: rotate the repo-level id shared by
   * issue attachments and ingested assets. */
  repoLevel?: boolean;
}

/** `POST /v1/workspaces/:workspace/github/private-prefix/rotate` response. */
export type RotateGhPrefixResult =
  | { rotated: false; reason: string }
  | { rotated: true; prefixId: string; moved: number };

/** `POST /v1/workspaces/:workspace/github/promote` request/response. */
export interface PromoteBranchAttachmentsOptions {
  repo: string;
  num: number;
  branch: string;
}

export interface PromoteSkip {
  key: string;
  reason: string;
}

export interface PromoteBranchAttachmentsResult {
  promoted: string[];
  skipped: PromoteSkip[];
  /** Branch names the sweep covered, current first. Only when the branch was renamed. */
  lineage?: string[];
}

/** `POST /v1/workspaces/:workspace/github/branch-rename` request. */
export interface RegisterBranchRenameOptions {
  repo: string;
  /** Previous branch name (`git branch -m <from> <to>`). */
  from: string;
  /** Name the branch was renamed to. */
  to: string;
}

/** `POST /v1/workspaces/:workspace/github/branch-rename` response. `recorded:
 * false` means the pair was already known (or the server has no such route). */
export interface RegisterBranchRenameResult {
  recorded: boolean;
}

/**
 * `POST /v1/workspaces/:workspace/github/attach`. `source` is an object key
 * or uploads.sh URL. Exactly one of `pr`/`issue`. Copies by default;
 * `move: true` deletes the source after.
 */
export interface AttachExistingOptions {
  source: string;
  repo: string;
  pr?: number;
  issue?: number;
  move?: boolean;
  filename?: string;
}

export interface AttachExistingResult {
  key: string;
  url: string | null;
  embedUrl: string | null;
  pageUrl?: string;
  moved: boolean;
  source: { key: string };
  comment: GithubCommentResult;
}

/** `GET`/`POST /v1/workspaces/:workspace/github/link` result. */
export interface GithubLinkResult {
  repo: string;
  linked: boolean;
  workspace: string | null;
  source: string | null;
  createdAt: string | null;
}

/** POST only: whether this call's workspace owns the binding. */
export interface GithubLinkClaimResult extends GithubLinkResult {
  claimed: boolean;
  /**
   * Set when the repo is unbound but this workspace couldn't be verified as
   * entitled to claim it. "Owned elsewhere" reports `workspace` instead.
   */
  reason?: "not_authorized";
}

/** `DELETE /v1/workspaces/:workspace/github/link` result. */
export interface GithubLinkUnlinkResult {
  repo: string;
  unlinked: boolean;
  reason?: "not_linked";
}

/**
 * `GET /v1/workspaces/:workspace/github/repo-link` result. Never names
 * another workspace; "self"/"other"/"none" avoids leaking cross-tenant info.
 */
export interface GithubRepoLinkResult {
  binding: "self" | "other" | "none";
}

/**
 * `POST /v1/workspaces/:workspace/github/ingest` result. `repo` comes back
 * lowercased.
 */
export interface IngestGithubResult {
  repo: string;
  kind: "pull" | "issues";
  num: number;
  /** Object keys newly mirrored into the workspace this call. */
  ingested: string[];
  /** Object keys whose previously-detached ledger row was un-detached. */
  reattached: string[];
  /** Object keys detached because they're no longer referenced. */
  detached: string[];
  /** Attachment URLs skipped, with the reason. */
  skipped: { url: string; reason: string }[];
}

export interface HealthResult {
  ok: boolean;
}

/** `GET /v1/workspaces/:workspace/github/health` result. */
export interface GithubHealthResult {
  configured: boolean;
  ok: boolean;
  events: string[] | null;
  missingEvents: string[];
  requiredEvents: string[];
  /** Recommended but non-gating events, e.g. `issue_comment`. Missing on older servers. */
  recommendedEvents?: string[];
  missingRecommendedEvents?: string[];
  hint?: string;
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
  /** Bytes still on hosted storage (shared-lane residue). */
  sharedBytes?: number;
  /** Objects still on hosted storage (shared-lane residue). */
  sharedObjects?: number;
  /** "shared" = BYO bucket active: the storage cap meters only hosted
   * residue. */
  storageBudgetBasis?: "total" | "shared";
  /** Lane summary. Missing on older servers. */
  storage?: {
    mode: "shared" | "byo";
    /** Demoted former-active lanes that still serve previously uploaded files. */
    fallbackLanes: number;
    health: { ok: boolean; code?: string; message?: string; since?: string };
  };
  /** File scopes of the presented token. Missing on older servers. */
  scopes?: Array<TokenScope>;
  /** Plan catalog id (`free` | `pro`). Missing on older servers. */
  plan?: string;
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
  scopes?: Array<TokenScope>;
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

// --- Request resilience ---------------------------------------------------
//
// Bare `fetch` has no timeout (undici waits ~5 minutes for headers), so a
// backend stall would hang the CLI. Every core API call goes through
// `resilientFetch` for a bounded timeout and one bounded retry. File `put`
// gets a longer timeout than JSON calls.
const JSON_TIMEOUT_MS = 15_000;
const CONTENT_TIMEOUT_MS = 60_000;

// At most one retry, on network errors, 503 and 429. GET always; POST/PUT
// only with an Idempotency-Key (a bare PUT to a strict key can 409 on
// replay). DELETE/PATCH never: "no bytes sent" vs "already applied" isn't
// reliably distinguishable.
const MAX_ATTEMPTS = 2;
const RETRYABLE_METHODS = new Set(["GET"]);
const IDEMPOTENCY_KEYED_METHODS = new Set(["POST", "PUT"]);
const RETRYABLE_STATUSES = new Set([429, 503]);
const DEFAULT_RETRY_DELAY_MS = 2_000;
// Cap an honored X-Retry-After so it can't stall a hook or CI step.
const MAX_RETRY_AFTER_DELAY_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Seconds-valued retry delay from the response, capped; falls back to the default backoff. */
function retryDelayMs(res: Response | undefined): number {
  const raw = res?.headers.get("x-retry-after") ?? res?.headers.get("retry-after");
  const seconds = raw ? Number(raw) : NaN;
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_DELAY_MS);
  }
  return DEFAULT_RETRY_DELAY_MS;
}

/** One-line stderr notice so a hook/CI log explains the pause. */
function printRetryNotice(label: string, delayMs: number): void {
  const seconds = delayMs % 1000 === 0 ? `${delayMs / 1000}s` : `${Math.round(delayMs) / 1000}s`;
  process.stderr.write(`warning: uploads.sh ${label}, retrying in ${seconds}…\n`);
}

/**
 * fetch with a timeout. Any rejection surfaces as `UploadsError` `NETWORK`,
 * naming the timeout.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new UploadsError(`request timed out after ${timeoutMs}ms`, "NETWORK");
    }
    throw new UploadsError(
      err instanceof Error ? err.message : "network request failed",
      "NETWORK",
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Shared resilience core: timeout plus one retry on network errors, 503 and
 * 429, honoring `X-Retry-After`. Never retries a non-idempotent request.
 * Returns the final raw `Response`; callers handle `!res.ok`.
 */
async function resilientFetch(
  method: string,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const normalizedMethod = method.toUpperCase();
  const retryable =
    RETRYABLE_METHODS.has(normalizedMethod) ||
    (IDEMPOTENCY_KEYED_METHODS.has(normalizedMethod) &&
      new Headers(init.headers).has("Idempotency-Key"));
  for (let attempt = 1; ; attempt++) {
    let res: Response | undefined;
    let networkErr: UploadsError | undefined;
    try {
      res = await fetchWithTimeout(url, init, timeoutMs);
    } catch (err) {
      networkErr = err as UploadsError;
    }

    const canRetry =
      retryable &&
      attempt < MAX_ATTEMPTS &&
      (networkErr !== undefined || (res !== undefined && RETRYABLE_STATUSES.has(res.status)));

    if (!canRetry) {
      if (networkErr) throw networkErr;
      return res as Response;
    }

    const delayMs = retryDelayMs(res);
    printRetryNotice(res ? `responded ${res.status}` : "request failed", delayMs);
    await sleep(delayMs);
  }
}

async function jsonRequest<T>(url: string, init: RequestInit): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const res = await resilientFetch(method, url, init, JSON_TIMEOUT_MS);
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
    scopes?: Array<TokenScope>;
  },
): Promise<EnrollmentCreateResult> {
  return jsonRequest(`${apiUrl.replace(/\/$/, "")}/admin/enrollments`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

// --- Device authorization (RFC 8628), for `uploads login` ---
//
// Plain `fetch` against the auth worker (no better-auth client dependency in
// the published package). Its device endpoints take JSON bodies, not the
// RFC's form encoding.

/**
 * OAuth client id for the device flow, a seeded `oauth_client` row (public
 * PKCE, device-code grant only) that operators can disable from
 * /admin/oauth. Must match the seeded client_id.
 */
export const DEVICE_CLIENT_ID = "uploads-cli";

/**
 * User-Agent for CLI requests. Stored on the session at `/device/token` so
 * the account UI can recognize a CLI login; the API records the client
 * version per credential (`mcp` purpose = stdio MCP). Keep the
 * `@buildinternet/uploads` prefix in sync with apps/web `CLI_USER_AGENT_RE`
 * and apps/api `CLI_UA_RE`.
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
  /**
   * RFC 8628 `scope`: the requested workspace (`workspace:<slug>`, plus
   * `create`), validated by the approval page and echoed back (possibly
   * rewritten) at token exchange.
   */
  scope?: string,
): Promise<DeviceCodeResponse> {
  return jsonRequest(`${authUrl.replace(/\/$/, "")}/api/auth/device/code`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": cliUserAgent("device-code"),
    },
    body: JSON.stringify({ client_id: clientId, ...(scope ? { scope } : {}) }),
  });
}

/**
 * One poll of POST /api/auth/device/token. `authorization_pending` and
 * `slow_down` are expected 400s, so this returns a result instead of throwing.
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
        // The session's user_agent comes from this request.
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
): Promise<{ workspaces: MintWorkspaceSummary[]; suggestedWorkspace?: string }> {
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
 * POST /v1/workspaces from a device-flow session bearer. Throws `UsageError`:
 * a linked-GitHub requirement gets an actionable pointer, anything else the
 * server's message.
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
  scopes: Array<TokenScope>;
  label: string | null;
  expiresAt: string | null;
}

/**
 * POST /me/workspaces/:name/invites. Needs a session bearer (device flow) and
 * org admin/owner. `acceptUrl` is always returned for installs without email.
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

/** POST /v1/tokens: mint an `up_<workspace>_…` token from a device-flow session bearer. */
export function mintWorkspaceToken(
  apiUrl: string,
  accessToken: string,
  input: {
    workspace: string;
    scopes?: Array<TokenScope>;
    label?: string;
    ttlSeconds?: number | null;
    /**
     * Reusing it within 24h replays the original response, including the
     * one-time token. A changed request with the same key returns 409.
     */
    idempotencyKey?: string;
  },
): Promise<MintTokenResult> {
  return jsonRequest(`${apiUrl.replace(/\/$/, "")}/v1/tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : {}),
    },
    body: JSON.stringify({
      grants: [{ workspace: input.workspace, ...(input.scopes ? { scopes: input.scopes } : {}) }],
      ...(input.label ? { label: input.label } : {}),
      ...(input.ttlSeconds !== undefined ? { ttlSeconds: input.ttlSeconds } : {}),
    }),
  });
}

function encodeKeyPath(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

// Every file operation goes to `/v1/workspaces/:workspace/files`;
// list/find/facets adapt its envelopes in their wrappers below.
function canonicalFilesBase(config: UploadsClientConfig): string {
  return `${config.apiUrl}/v1/workspaces/${encodeURIComponent(config.workspace)}/files`;
}

function usageBase(config: UploadsClientConfig): string {
  return `${config.apiUrl}/v1/workspaces/${encodeURIComponent(config.workspace)}/usage`;
}

function galleriesBase(config: UploadsClientConfig): string {
  return `${config.apiUrl}/v1/workspaces/${encodeURIComponent(config.workspace)}/galleries`;
}

function feedsBase(config: UploadsClientConfig): string {
  return `${config.apiUrl}/v1/workspaces/${encodeURIComponent(config.workspace)}/feeds`;
}

/** Where to get a missing file scope. Same sentence as the API 403. */
export function scopeRemedy(scope: string): string {
  return `Ask a workspace admin, or mint a token with ${scope} at https://uploads.sh/account/developers.`;
}

function mapApiError(
  status: number,
  error: string,
  code?: string,
  requiredScope?: string,
  existingUrl?: string,
): UploadsError {
  const normalized = error.toLowerCase();
  if (status === 401 || code === "unauthorized" || normalized === "unauthorized") {
    return new UploadsError(error, "UNAUTHORIZED", status);
  }
  if (code === "insufficient_scope") {
    // Rebuilt from `required_scope` so older servers' bare "forbidden" is
    // actionable too.
    const message = requiredScope
      ? `token lacks the ${requiredScope} scope. ${scopeRemedy(requiredScope)}`
      : error;
    return new UploadsError(message, "INSUFFICIENT_SCOPE", status, { requiredScope });
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
  if (code === "key_exists") {
    return new UploadsError(error, "KEY_EXISTS", status, { existingUrl });
  }
  return new UploadsError(error, "API_ERROR", status);
}

/**
 * Parse API error bodies: the nested `{ error: { code, type, message,
 * details? } }` envelope, or the legacy flat `{ error, code? }`. Shared with
 * other backends (the screenshot render endpoint).
 */
export function extractErrorFields(
  body: unknown,
  fallback = "request failed",
): { message: string; code?: string; requiredScope?: string; existingUrl?: string } {
  if (typeof body === "object" && body && "error" in body) {
    const err = (body as { error: unknown }).error;
    if (typeof err === "object" && err && "message" in err) {
      const nested = err as { message?: unknown; code?: unknown; details?: unknown };
      const details = nested.details as { required_scope?: unknown; url?: unknown } | undefined;
      return {
        message: typeof nested.message === "string" ? nested.message : fallback,
        code: typeof nested.code === "string" ? nested.code : undefined,
        ...(typeof details?.required_scope === "string"
          ? { requiredScope: details.required_scope }
          : {}),
        ...(typeof details?.url === "string" ? { existingUrl: details.url } : {}),
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
): Promise<{ message: string; code?: string; requiredScope?: string; existingUrl?: string }> {
  const body = await res.json().catch(() => ({}));
  return extractErrorFields(body, fallback);
}

async function parseErrorResponse(res: Response): Promise<UploadsError> {
  const { message, code, requiredScope, existingUrl } = await parseErrorEnvelope(
    res,
    res.statusText || "request failed",
  );
  return mapApiError(res.status, message, code, requiredScope, existingUrl);
}

export interface UploadsClientOptions {
  /** Which surface is calling (User-Agent comment): `mcp` for `uploads mcp`, else `cli`. */
  surface?: "cli" | "mcp";
  /**
   * Tokens the API has reported expired, so a remembered one fails locally
   * instead of being sent again (`expired-tokens.ts`).
   */
  expiredTokens?: ExpiredTokenStore;
  /** Called with the token's expiry (ISO) when the API reports one. */
  onTokenExpiry?: (expiresAt: string) => void;
}

export interface ExpiredTokenStore {
  /** The server's expiry message for this token, or undefined if not known expired. */
  lookup(token: string): string | undefined;
  remember(token: string, message: string): void;
}

export function createUploadsClient(
  config: UploadsClientConfig,
  clientOpts: UploadsClientOptions = {},
) {
  const userAgent = cliUserAgent(clientOpts.surface ?? "cli");

  async function request<T>(
    method: string,
    path: string,
    opts?: {
      body?: Uint8Array;
      headers?: Record<string, string>;
      auth?: boolean;
      /** Longer timeout for content bytes; only `put`'s real write sets it. */
      longTimeout?: boolean;
    },
  ): Promise<T> {
    const headers: Record<string, string> = { "User-Agent": userAgent, ...opts?.headers };
    const sendsToken = opts?.auth !== false;
    if (sendsToken) {
      const expired = clientOpts.expiredTokens?.lookup(config.token);
      if (expired) throw new UploadsError(expired, "UNAUTHORIZED", 401);
      headers.Authorization = `Bearer ${config.token}`;
    }

    const res = await resilientFetch(
      method,
      path,
      { method, headers, body: opts?.body },
      opts?.longTimeout ? CONTENT_TIMEOUT_MS : JSON_TIMEOUT_MS,
    );

    if (!res.ok) {
      const { message, code, requiredScope, existingUrl } = await parseErrorEnvelope(
        res,
        res.statusText || "request failed",
      );
      if (sendsToken && res.status === 401 && code === "token_expired") {
        clientOpts.expiredTokens?.remember(config.token, message);
      }
      throw mapApiError(res.status, message, code, requiredScope, existingUrl);
    }

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
    const qs = params.toString();
    // Map the `{files, prefixes, cursor}` envelope to this client's
    // `{items, cursor}`, dropping metadata the caller didn't ask for.
    const page = await request<{ files: ListItem[]; cursor: string | null }>(
      "GET",
      `${canonicalFilesBase(config)}${qs ? `?${qs}` : ""}`,
    );
    return {
      cursor: page.cursor,
      items: page.files.map((item) => {
        const { metadata, ...rest } = item;
        return {
          ...rest,
          ...(opts.metadata && metadata !== undefined ? { metadata } : {}),
          embedUrl: resolveEmbedUrl(item.url, item.embedUrl),
        };
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
    }>("GET", `${canonicalFilesBase(config)}/search?${params.toString()}`);
    return {
      items: result.items,
      cursor: result.cursor ?? null,
      truncated: result.truncated,
    };
  }

  async function getGallery(id: string): Promise<Gallery> {
    return request<Gallery>("GET", `${galleriesBase(config)}/${encodeURIComponent(id)}`);
  }

  // Per-process cache for resolveGhPrefix, keyed by repo+branch+target.
  const resolveGhPrefixCache = new Map<string, ResolveGhPrefixResult>();

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
        const qs = opts.replace ? "dryRun=1&replace=1" : "dryRun=1";
        const preview = await request<{
          workspace: string;
          key: string;
          url: string | null;
          embedUrl?: string | null;
          replaced?: boolean;
          wouldRefuse?: boolean;
        }>("PUT", `${canonicalFilesBase(config)}/${encodeKeyPath(key)}?${qs}`);
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
          wouldRefuse: preview.wouldRefuse === true,
        };
      }

      const headers: Record<string, string> = { "Content-Type": contentType };
      if (opts.replace) headers["X-Uploads-Replace"] = "1";
      if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
      if (opts.provenance) {
        for (const [k, v] of Object.entries(opts.provenance)) {
          if (v !== undefined && v !== "") headers[`X-Uploads-Meta-${k}`] = v;
        }
      }
      // The server splits provenance keys (R2) from the rest (D1) by name.
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
        provenance?: Record<string, string>;
        metadata?: Record<string, string>;
      }>("PUT", `${canonicalFilesBase(config)}/${encodeKeyPath(key)}`, {
        body,
        headers,
        longTimeout: true,
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
      return request<DeleteResult>("DELETE", `${canonicalFilesBase(config)}/${encodeKeyPath(key)}`);
    },

    /** Files held for review, optionally under one key prefix. */
    async listHeld(prefix?: string): Promise<HeldFile[]> {
      const query = prefix ? `?prefix=${encodeURIComponent(prefix)}` : "";
      const result = await request<{ items: HeldFile[] }>(
        "GET",
        `${canonicalFilesBase(config)}/held${query}`,
      );
      return result.items;
    },

    /** Release a file held for approval (a likely secret or personal data). */
    async approve(key: string): Promise<ApproveResult> {
      return request<ApproveResult>(
        "POST",
        `${canonicalFilesBase(config)}/approve?key=${encodeURIComponent(key)}`,
      );
    },

    /** `GET /v1/:workspace/files/:key?metadata=1` — the object's queryable metadata. */
    async getMetadata(key: string): Promise<GetMetadataResult> {
      return request<GetMetadataResult>(
        "GET",
        `${canonicalFilesBase(config)}/${encodeKeyPath(key)}?metadata=1`,
      );
    },

    /** `PATCH /v1/:workspace/files/:key` — merge `set`/`delete`; returns the merged map. */
    async patchMetadata(key: string, opts: PatchMetadataOptions): Promise<GetMetadataResult> {
      return request<GetMetadataResult>(
        "PATCH",
        `${canonicalFilesBase(config)}/${encodeKeyPath(key)}`,
        {
          body: new TextEncoder().encode(JSON.stringify(opts)),
          headers: { "Content-Type": "application/json" },
        },
      );
    },

    /**
     * `GET /v1/workspaces/:workspace/files/search` — ANDed metadata equality
     * filters and/or a filename substring (at least one). `filters` must be
     * pre-validated (`metadata.ts`). Pages are capped server-side; `cursor`
     * continues, null on the last page.
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

    /** `GET /v1/:workspace/files/facets` — workspace metadata key vocabulary. */
    async listMetadataKeys(): Promise<MetadataKeysResult> {
      return request<MetadataKeysResult>("GET", `${canonicalFilesBase(config)}/facets`);
    },

    /** `GET /v1/:workspace/files/facets?key=` — distinct values for one key. */
    async listMetadataValues(key: string): Promise<MetadataValuesResult> {
      return request<MetadataValuesResult>(
        "GET",
        `${canonicalFilesBase(config)}/facets?${new URLSearchParams({ key })}`,
      );
    },

    async head(key: string): Promise<HeadResult> {
      const result = await request<HeadResult>(
        "GET",
        `${canonicalFilesBase(config)}/${encodeKeyPath(key)}`,
      );
      return { ...result, embedUrl: resolveEmbedUrl(result.url, result.embedUrl) };
    },

    async createGallery(opts: CreateGalleryOptions): Promise<Gallery> {
      const { idempotencyKey = crypto.randomUUID(), ...body } = opts;
      return request<Gallery>("POST", galleriesBase(config), {
        body: new TextEncoder().encode(JSON.stringify(body)),
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
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

    async createFeed(opts: CreateFeedOptions): Promise<Feed> {
      return request<Feed>("POST", feedsBase(config), {
        body: new TextEncoder().encode(JSON.stringify(opts)),
        headers: { "Content-Type": "application/json" },
      });
    },

    async getFeed(id: string): Promise<Feed> {
      return request<Feed>("GET", `${feedsBase(config)}/${encodeURIComponent(id)}`);
    },

    async listFeeds(opts: FeedListOptions = {}): Promise<FeedListResult> {
      const params = new URLSearchParams();
      if (opts.limit != null) params.set("limit", String(opts.limit));
      if (opts.cursor) params.set("cursor", opts.cursor);
      const qs = params.toString();
      return request<FeedListResult>("GET", `${feedsBase(config)}${qs ? `?${qs}` : ""}`);
    },

    async deleteFeed(id: string): Promise<{ deleted: boolean; id: string }> {
      return request<{ deleted: boolean; id: string }>(
        "DELETE",
        `${feedsBase(config)}/${encodeURIComponent(id)}`,
      );
    },

    /**
     * Upsert the managed attachments comment. `resync: true` (`uploads
     * comment`) makes the server search for the marker and collapse
     * duplicates instead of patching its cached comment id.
     */
    async upsertGithubComment(opts: {
      repo: string;
      num: number;
      kind: "pull" | "issues";
      resync?: boolean;
    }): Promise<GithubCommentResult> {
      return request<GithubCommentResult>(
        "POST",
        `${config.apiUrl}/v1/workspaces/${encodeURIComponent(config.workspace)}/github/comment`,
        {
          body: new TextEncoder().encode(JSON.stringify(opts)),
          headers: { "Content-Type": "application/json" },
        },
      );
    },

    /**
     * Resolve the GitHub-key mode (plain or private prefix) for `repo`.
     * Fail-open: any failure resolves to `{ mode: "plain" }` silently. Cached
     * per process by repo+branch+target.
     */
    async resolveGhPrefix(opts: ResolveGhPrefixOptions): Promise<ResolveGhPrefixResult> {
      const cacheKey = JSON.stringify([
        opts.repo.toLowerCase(),
        opts.branch ?? "",
        opts.target ?? null,
      ]);
      const cached = resolveGhPrefixCache.get(cacheKey);
      if (cached) return cached;

      const resolved = await (async (): Promise<ResolveGhPrefixResult> => {
        try {
          return await request<ResolveGhPrefixResult>(
            "POST",
            `${config.apiUrl}/v1/workspaces/${encodeURIComponent(config.workspace)}/github/private-prefix`,
            {
              body: new TextEncoder().encode(JSON.stringify(opts)),
              headers: { "Content-Type": "application/json" },
            },
          );
        } catch {
          return { mode: "plain" };
        }
      })();
      resolveGhPrefixCache.set(cacheKey, resolved);
      return resolved;
    },

    /**
     * Rotate the private attachment prefix for a branch or the repo level.
     * Not fail-open: an explicit action, so any failure throws.
     */
    async rotateGhPrefix(opts: RotateGhPrefixOptions): Promise<RotateGhPrefixResult> {
      return request<RotateGhPrefixResult>(
        "POST",
        `${config.apiUrl}/v1/workspaces/${encodeURIComponent(config.workspace)}/github/private-prefix/rotate`,
        {
          body: new TextEncoder().encode(JSON.stringify(opts)),
          headers: { "Content-Type": "application/json" },
        },
      );
    },

    /**
     * Promote branch-staged attachments into a PR's prefix. Callers treat any
     * failure, including a 404 from an older worker, as nothing promoted.
     */
    async promoteBranchAttachments(
      opts: PromoteBranchAttachmentsOptions,
    ): Promise<PromoteBranchAttachmentsResult> {
      return request<PromoteBranchAttachmentsResult>(
        "POST",
        `${config.apiUrl}/v1/workspaces/${encodeURIComponent(config.workspace)}/github/promote`,
        {
          body: new TextEncoder().encode(JSON.stringify(opts)),
          headers: { "Content-Type": "application/json" },
        },
      );
    },

    /**
     * Record one `git branch -m` step so promote sweeps the old names too. A
     * 404 (older worker) returns `{ recorded: false }`; other failures throw.
     */
    async registerBranchRename(
      opts: RegisterBranchRenameOptions,
    ): Promise<RegisterBranchRenameResult> {
      try {
        return await request<RegisterBranchRenameResult>(
          "POST",
          `${config.apiUrl}/v1/workspaces/${encodeURIComponent(config.workspace)}/github/branch-rename`,
          {
            body: new TextEncoder().encode(JSON.stringify(opts)),
            headers: { "Content-Type": "application/json" },
          },
        );
      } catch (err) {
        if (err instanceof UploadsError && err.status === 404) return { recorded: false };
        throw err;
      }
    },

    /**
     * Attach an already-uploaded object to a PR/issue by server-side copy.
     * Throws on any failure: this is the only way to move the object, so
     * failures must be visible.
     */
    async attachExisting(opts: AttachExistingOptions): Promise<AttachExistingResult> {
      return request<AttachExistingResult>(
        "POST",
        `${config.apiUrl}/v1/workspaces/${encodeURIComponent(config.workspace)}/github/attach`,
        {
          body: new TextEncoder().encode(JSON.stringify(opts)),
          headers: { "Content-Type": "application/json" },
        },
      );
    },

    /** Current binding for `repo`, or `{ linked: false }`. A 404 means an
     * older server without bindings. */
    async githubLinkStatus(repo: string): Promise<GithubLinkResult> {
      return request<GithubLinkResult>(
        "GET",
        `${config.apiUrl}/v1/workspaces/${encodeURIComponent(config.workspace)}/github/link?repo=${encodeURIComponent(repo)}`,
      );
    },

    /**
     * Claim `repo` for this workspace (first claim wins). `claimed: false`
     * means another workspace owns it; never steals.
     */
    async githubLinkClaim(repo: string): Promise<GithubLinkClaimResult> {
      return request<GithubLinkClaimResult>(
        "POST",
        `${config.apiUrl}/v1/workspaces/${encodeURIComponent(config.workspace)}/github/link`,
        {
          body: new TextEncoder().encode(JSON.stringify({ repo })),
          headers: { "Content-Type": "application/json" },
        },
      );
    },

    /**
     * Tri-state binding status for `repo`; never names another workspace.
     * Callers treat any failure as "stay silent".
     */
    async githubRepoLinkStatus(repo: string): Promise<GithubRepoLinkResult> {
      return request<GithubRepoLinkResult>(
        "GET",
        `${config.apiUrl}/v1/workspaces/${encodeURIComponent(config.workspace)}/github/repo-link?repo=${encodeURIComponent(repo)}`,
      );
    },

    /**
     * `POST /v1/workspaces/:workspace/github/ingest`: mirror a PR/issue's
     * `github.com/user-attachments` media and public Cursor artifact URLs
     * into the workspace.
     */
    async ingestGithub(input: {
      repo: string;
      kind: "pull" | "issues";
      num: number;
    }): Promise<IngestGithubResult> {
      const body =
        input.kind === "pull"
          ? { repo: input.repo, pr: input.num }
          : { repo: input.repo, issue: input.num };
      return request<IngestGithubResult>(
        "POST",
        `${config.apiUrl}/v1/workspaces/${encodeURIComponent(config.workspace)}/github/ingest`,
        {
          body: new TextEncoder().encode(JSON.stringify(body)),
          headers: { "Content-Type": "application/json" },
        },
      );
    },

    /**
     * GitHub App configuration and webhook subscription check. A 404 (older
     * server) means unknown, not broken.
     */
    async githubHealth(): Promise<GithubHealthResult> {
      return request<GithubHealthResult>(
        "GET",
        `${config.apiUrl}/v1/workspaces/${encodeURIComponent(config.workspace)}/github/health`,
      );
    },

    /**
     * Remove `repo`'s binding if this workspace owns it. 403 when another
     * workspace does; never touches its claim.
     */
    async githubLinkUnlink(repo: string): Promise<GithubLinkUnlinkResult> {
      return request<GithubLinkUnlinkResult>(
        "DELETE",
        `${config.apiUrl}/v1/workspaces/${encodeURIComponent(config.workspace)}/github/link?repo=${encodeURIComponent(repo)}`,
      );
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
