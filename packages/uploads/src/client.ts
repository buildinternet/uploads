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
   * Queryable custom metadata (D1 `file_metadata`), sent alongside provenance
   * as more `X-Uploads-Meta-<key>` headers — the server routes each key to R2
   * (provenance) or D1 (everything else) by name. See `metadata.ts` for the
   * client-side validation callers should run before this.
   */
  metadata?: Record<string, string>;
  /** Validate key + resolve public URL without writing. `size` is local bytes only. */
  dryRun?: boolean;
  /**
   * Opt in to overwriting an existing object on a "strict" (non-`gh/`) key —
   * see issue #174. Ignored (always allowed) on managed `gh/` paths
   * (`attach`, `put --pr`/`--issue`), which stay silent hot-swap. Omit/false
   * on a strict path with an existing key throws `UploadsError` with code
   * `KEY_EXISTS`.
   */
  replace?: boolean;
  /**
   * Reuse this key to safely retry the same upload request (issue #829). Not
   * generated automatically — unlike `createGallery`, a `put` is only
   * retried by the client (see `resilientFetch`) or is server-replay-safe
   * when the caller supplies one; omit it and no header is sent.
   */
  idempotencyKey?: string;
}

export interface ListOptions {
  prefix?: string;
  limit?: number;
  cursor?: string;
  /** Hydrate each row's queryable D1 metadata (`?metadata=1`). */
  metadata?: boolean;
}

/**
 * Default page cap for `findFilesAll` / `uploads find --all`. Search is a
 * bounded read on the server, so following its cursor is bounded on the client
 * too rather than draining an unknown number of pages (issue #829 §4).
 */
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
   * Opaque continuation from a previous result's `cursor`. Pass it back
   * unchanged, with the same filters/name/prefix, to fetch the next page
   * (issue #829 §4). A cursor minted for one search path is rejected by the
   * other, so do not hand-build one.
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
   * The object's R2 provenance bag (`client`, `source-name`,
   * `content-sha256`) — what the upload was made *by*, not the tags it was
   * tagged *with*. Absent on a dry run, and on API deployments older than the
   * split that gave this bag its own name.
   */
  provenance?: Record<string, string>;
  /**
   * The queryable metadata (D1) this put stored, including server-derived
   * pairs the client never sent (`gh.uploader`). Absent when the put carried
   * no metadata — that case leaves any existing tags untouched, so the server
   * reports nothing rather than implying an empty set. Means the same thing
   * on `getMetadata`, `patchMetadata`, and `list({ metadata: true })`.
   *
   * An API older than the split returns the provenance bag here instead, so a
   * client that must work against both reads `path`-style tags defensively —
   * see `pathMetaHintFor` in commands.ts, which prefers what it sent.
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
  /**
   * The object's R2 provenance bag — see `PutResult.provenance`. A plain head
   * returns no queryable metadata at all: that tier lives in a separate store
   * and takes a separate read, so call `getMetadata(key)` for it.
   */
  provenance?: Record<string, string>;
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

/**
 * Reasons the bot did not post. The CLI falls back to the local `gh` path
 * for all of these except `not_authorized` (issue #297 baseline control):
 * the target repo is bound to a different workspace.
 * Falling back to `gh` there would let the human's own credentials post
 * anyway, defeating the point of the server-side gate, so the CLI surfaces
 * the decline instead.
 */
export type GithubCommentDeclineReason =
  | "app_unconfigured"
  | "not_installed"
  | "forbidden"
  | "not_authorized"
  | "actor_not_authorized"
  | "unavailable";

export type GithubCommentResult =
  | { posted: true; action: "created" | "updated" | "skipped"; count: number; commentUrl?: string }
  | {
      posted: false;
      reason: GithubCommentDeclineReason;
      // Present on `forbidden` (App installed, write pending approval): a ready
      // human message + fix link the CLI surfaces instead of degrading silently.
      message?: string;
      fixUrl?: string;
      required?: string[];
    };

/** `POST /v1/workspaces/:workspace/github/private-prefix` request (server contract, issue #631/#613). */
export interface ResolveGhPrefixOptions {
  repo: string;
  branch?: string;
  target?: { kind: "pull" | "issues"; num: number };
}

/** `POST /v1/workspaces/:workspace/github/private-prefix` response (server contract, issue #631/#613). */
export type ResolveGhPrefixResult =
  | { mode: "plain" }
  | { mode: "private"; prefixId: string; activePrefixIds?: string[] };

/** `POST /v1/workspaces/:workspace/github/private-prefix/rotate` request (server contract, issue #631/#613). */
export interface RotateGhPrefixOptions {
  repo: string;
  /** Mutually exclusive with `repoLevel`: rotate one branch's id. */
  branch?: string;
  /** Mutually exclusive with `branch`: rotate the repo-level id shared by
   * issue attachments and ingested assets. */
  repoLevel?: boolean;
}

/** `POST /v1/workspaces/:workspace/github/private-prefix/rotate` response (server contract, issue #631/#613). */
export type RotateGhPrefixResult =
  | { rotated: false; reason: string }
  | { rotated: true; prefixId: string; moved: number };

/** `POST /v1/workspaces/:workspace/github/promote` request/response (server contract, PR #310). */
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
  /** Branch-name lineage the sweep covered, current name first (issue #920).
   * Present only when the branch was renamed at least once. */
  lineage?: string[];
}

/** `POST /v1/workspaces/:workspace/github/branch-rename` request (server contract, issue #920). */
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
 * `POST /v1/workspaces/:workspace/github/attach` request/response (server
 * contract, issue #702). `source` is a raw object key or an uploads.sh URL
 * (storage host, embed host, or `/f/` page). Exactly one of `pr`/`issue` is
 * required. Copy by default; `move: true` deletes the source object after a
 * successful copy.
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

/** `GET`/`POST /v1/workspaces/:workspace/github/link` result (server contract, phase 4b). */
export interface GithubLinkResult {
  repo: string;
  linked: boolean;
  workspace: string | null;
  source: string | null;
  createdAt: string | null;
}

/** POST-only: whether THIS call's workspace ended up owning the binding. */
export interface GithubLinkClaimResult extends GithubLinkResult {
  claimed: boolean;
  /**
   * Present (only) when `claimed` is false because the repo is unbound and
   * this workspace couldn't be verified as entitled to claim it — issue
   * #297's cross-tenant authorization gate. Distinct from the "someone else
   * already owns it" case, which instead reports a non-null `workspace`.
   */
  reason?: "not_authorized";
}

/** `DELETE /v1/workspaces/:workspace/github/link` result (issue #318, self-serve unlink). */
export interface GithubLinkUnlinkResult {
  repo: string;
  unlinked: boolean;
  reason?: "not_linked";
}

/**
 * `GET /v1/workspaces/:workspace/github/repo-link` result (issue #398). Deliberately
 * minimal relative to `GithubLinkResult`: never names the owning workspace
 * when it isn't this one — "self"/"other"/"none" is all the stage-time
 * warning needs, and anything richer would leak cross-tenant info to a
 * caller that's just probing a repo it detected from local git context.
 */
export interface GithubRepoLinkResult {
  binding: "self" | "other" | "none";
}

/**
 * `POST /v1/workspaces/:workspace/github/ingest` result (Task 6, manual/
 * backfill entry point for GitHub-native `user-attachments` media). `repo`
 * comes back lowercased by the server.
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

/** `GET /v1/workspaces/:workspace/github/health` result (issue #293 follow-up). */
export interface GithubHealthResult {
  configured: boolean;
  ok: boolean;
  events: string[] | null;
  missingEvents: string[];
  requiredEvents: string[];
  /**
   * Recommended-but-non-gating events, e.g. `issue_comment` (issue #333).
   * Optional: older servers' health payload predates this field — treat a
   * missing field as "no recommendations", not an error.
   */
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
   * residue; the customer's own bucket is unmetered. */
  storageBudgetBasis?: "total" | "shared";
  /** Bearer-safe lane summary (issue #775; servers ≥ this field's release). */
  storage?: {
    mode: "shared" | "byo";
    /** Demoted former-active lanes that still serve previously uploaded files. */
    fallbackLanes: number;
    health: { ok: boolean; code?: string; message?: string; since?: string };
  };
  /** File scopes of the presented token (servers ≥ this field's release). */
  scopes?: Array<TokenScope>;
  /**
   * Workspace plan catalog id (`free` | `pro`). Present on API workers that
   * ship plan-aware usage; omitted on older servers.
   */
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

// --- Request resilience (issue #809) ---------------------------------------
//
// Bare `fetch` has no timeout — undici's default header timeout is ~5
// minutes, so a backend stall (see the 2026-08-23 D1 stall incident, #808)
// hangs the CLI silently for that whole window instead of failing fast like
// the workers now do (#805-#807). Every core API call routes through
// `resilientFetch` for a bounded timeout and a single bounded retry.
//
// Timeouts: short for JSON control calls, longer for the one content-bytes
// call (file `put`), matching the side-channel calls' pattern (telemetry.ts,
// update-check.ts already carry AbortController timeouts — this closes the
// gap on the core path).
const JSON_TIMEOUT_MS = 15_000;
const CONTENT_TIMEOUT_MS = 60_000;

// At most one retry. Retried on network errors, 503, and 429 — GET always.
// POST and PUT are retryable only when the request carries an
// Idempotency-Key (gallery-create's POST, and an upload PUT that opts in per
// issue #829) — a bare PUT is no longer assumed byte-idempotent, since a
// strict (non-`gh/`) key without a caller-supplied key can 409 `key_exists`
// on replay. DELETE/PATCH remain single-attempt because telling "no bytes
// sent" apart from "the mutation already landed" isn't reliable enough to
// risk a double-apply.
const MAX_ATTEMPTS = 2;
const RETRYABLE_METHODS = new Set(["GET"]);
const IDEMPOTENCY_KEYED_METHODS = new Set(["POST", "PUT"]);
const RETRYABLE_STATUSES = new Set([429, 503]);
const DEFAULT_RETRY_DELAY_MS = 2_000;
// Cap an honored X-Retry-After so a large server-suggested backoff can't
// stall a hook/CI step for minutes.
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

/** One-line stderr notice so a hook/CI log explains the pause (issue #809). */
function printRetryNotice(label: string, delayMs: number): void {
  const seconds = delayMs % 1000 === 0 ? `${delayMs / 1000}s` : `${Math.round(delayMs) / 1000}s`;
  process.stderr.write(`warning: uploads.sh ${label}, retrying in ${seconds}…\n`);
}

/**
 * fetch with a per-request AbortController timeout. A timeout (or any other
 * fetch rejection) surfaces as `UploadsError` code `NETWORK`, naming the
 * timeout so hook/CI logs are diagnosable.
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
 * The shared resilience core for both `jsonRequest` and
 * `createUploadsClient`'s `request`: bounded timeout + bounded retry on
 * network errors, 503, and 429, honoring `X-Retry-After` when present.
 * Never retries a non-idempotent method (see `RETRYABLE_METHODS` above).
 * Returns the raw `Response` on the final attempt — callers still handle
 * `!res.ok` themselves via `parseErrorResponse`.
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

// --- Device authorization (RFC 8628) — the `uploads login` device flow ---
//
// The CLI speaks the auth worker's OAuth-shaped endpoints directly with plain
// `fetch` (no better-auth client dependency in the published package, per plan
// D5). Better Auth's `device.code`/`device.token` endpoints take
// `application/json` bodies, NOT the RFC's form-encoding — the JSON shapes
// below are what the worker expects.

/**
 * OAuth client id for the device flow. Registered server-side as a managed
 * official `oauth_client` row (seeded by apps/auth migration
 * 20260719000000_seed_cli_oauth_client.sql — issue #251): public PKCE client,
 * no secret, device-code grant only. The auth worker's device endpoints
 * validate this id against that table, so operators can disable it from
 * /admin/oauth. The literal must match the seeded row's client_id.
 */
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
  /**
   * RFC 8628 `scope`. Carries the requested workspace (`workspace:<slug>`,
   * plus `create`) so the approval page can validate it before approving —
   * issue #362. Stored on the device-code row and echoed back at token
   * exchange, possibly rewritten by the page.
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
  scopes: Array<TokenScope>;
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
    scopes?: Array<TokenScope>;
    label?: string;
    ttlSeconds?: number | null;
    /**
     * Optional retry key. Reusing it (same effective request, within 24h)
     * replays the original response — including the one-time plaintext token —
     * instead of minting a second token. A changed request with the same key
     * returns 409.
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

// Canonical files surface (issue #613): every file operation now goes to
// `/v1/workspaces/:workspace/files`. Per-key ops share handlers with the
// legacy wildcard (#636); list/find/facets adapt the canonical envelopes in
// their wrappers below (#613 shape reconciliation).
function canonicalFilesBase(config: UploadsClientConfig): string {
  return `${config.apiUrl}/v1/workspaces/${encodeURIComponent(config.workspace)}/files`;
}

function usageBase(config: UploadsClientConfig): string {
  return `${config.apiUrl}/v1/workspaces/${encodeURIComponent(config.workspace)}/usage`;
}

function galleriesBase(config: UploadsClientConfig): string {
  return `${config.apiUrl}/v1/workspaces/${encodeURIComponent(config.workspace)}/galleries`;
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
    // The server's message is a bare "forbidden" — name the missing scope so
    // the failure is actionable without a doctor run.
    const message = requiredScope ? `token lacks the ${requiredScope} scope` : error;
    return new UploadsError(message, "INSUFFICIENT_SCOPE", status);
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
 * Parse API error bodies. Prefers the nested envelope
 * `{ error: { code, type, message, details? } }`; still accepts the legacy
 * flat `{ error: string, code?: string }` shape. Exported so other backends
 * (e.g. the screenshot render endpoint) share this parsing instead of
 * duplicating it — each caller supplies its own `fallback` message.
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

export function createUploadsClient(config: UploadsClientConfig) {
  async function request<T>(
    method: string,
    path: string,
    opts?: {
      body?: Uint8Array;
      headers?: Record<string, string>;
      auth?: boolean;
      /**
       * Content PUT/GET calls (byte bodies/downloads) get the longer
       * timeout; every JSON control call uses the default. Set by `put`'s
       * real (non-dry-run) write below — the only content-bytes call this
       * client makes today.
       */
      longTimeout?: boolean;
    },
  ): Promise<T> {
    const headers: Record<string, string> = { ...opts?.headers };
    if (opts?.auth !== false) {
      headers.Authorization = `Bearer ${config.token}`;
    }

    const res = await resilientFetch(
      method,
      path,
      { method, headers, body: opts?.body },
      opts?.longTimeout ? CONTENT_TIMEOUT_MS : JSON_TIMEOUT_MS,
    );

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
    // The canonical route hydrates D1 metadata by default (issue #613 — the
    // session shape won the reconciliation); when the caller didn't ask for
    // `opts.metadata` this client discards it anyway below, so `metadata=0`
    // opts out of the hydration pass server-side instead of paying for work
    // whose result is thrown away (issue #829 §5).
    params.set("metadata", opts.metadata ? "1" : "0");
    const qs = params.toString();
    // Canonical list envelope is `{files, prefixes, cursor}`. This client
    // keeps its historical `{items, cursor}` contract: rename the array and
    // honor `opts.metadata` by stripping the hydrated maps when the caller
    // didn't ask for them.
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

  // Per-process cache for resolveGhPrefix, keyed by repo+branch+target — see
  // that method's doc.
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
     * `GET /v1/workspaces/:workspace/files/search?meta.<k>=<v>&…&name=…` —
     * ANDed equality filter over queryable metadata and/or a case-insensitive
     * filename substring. At least one of non-empty `filters` or `opts.name`
     * is required. `filters` must be pre-validated when present (see
     * `metadata.ts`). The page is capped server-side (100, narrowable via
     * `limit`); when more matches exist the result carries an opaque `cursor`
     * to pass back as `opts.cursor` for the next page, and null when the last
     * page has been reached.
     */
    findFiles,

    /**
     * `findFiles` followed through its `cursor`, up to `maxPages` requests
     * (default `FIND_FILES_MAX_PAGES`). Bounded on purpose: search pages are
     * the expensive read path, so draining is capped rather than open-ended.
     * The returned `cursor` is non-null when the cap stopped the drain early —
     * pass it back to continue from there.
     *
     * `maxPages` must be a finite positive number. Anything else (`Infinity`,
     * `NaN`, zero, a negative) falls back to the default rather than removing
     * the bound or silently fetching nothing.
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

    /**
     * Upsert the managed attachments comment. `resync: true` marks an
     * explicit "make the comment state correct" call (`uploads comment`), so
     * the server hunts for the marker — and collapses any duplicate — instead
     * of patching its cached comment id (issue #480). Older servers ignore
     * the field.
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
     * Resolve the GitHub-key mode (plain vs. randomized private prefix, issue
     * #631) a caller should stage/list attachments under for `repo`. Fail-open:
     * ANY failure — a 404 from an older/self-hosted server, a network error, a
     * non-2xx response, or a malformed body — resolves to `{ mode: "plain" }`
     * silently (no stderr noise), never throws. Cached per-process, keyed by
     * repo+branch+target, so repeated calls for the same coordinate (e.g. the
     * gh-fallback comment gather re-checking on every sync) cost one request.
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
     * Rotate the active private-repo attachment prefix for `opts.repo` +
     * (`opts.branch` or `opts.repoLevel`) (issue #631). Unlike
     * `resolveGhPrefix`, this is NOT fail-open: it's an explicit, caller-
     * initiated action, so a failure (including a 404 from an older/self-
     * hosted server without this route) throws `UploadsError` — the CLI
     * command decides how to present that, rather than this method silently
     * degrading to a shape that would look like success.
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
     * Promote a workspace's branch-staged attachments into a PR's stable
     * attachment prefix (server contract, PR #310 — degrade-safe callers
     * treat any failure, including a 404 from an older/self-hosted worker
     * that doesn't have this route yet, as "nothing promoted").
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
     * Record one `git branch -m` step so promote sweeps the branch's whole
     * name lineage (issue #920). Degrade-safe on the one failure that is
     * expected in the wild: a 404 from an older/self-hosted worker without
     * this route collapses to `{ recorded: false }` — nothing recorded, same
     * as `promoteBranchAttachments`' callers treat a missing route. Other
     * failures throw; the CLI's `registerRenamesBestEffort` swallows those.
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
     * Attach an already-uploaded object to a PR/issue via a server-side copy
     * (issue #702) — see `AttachExistingOptions`. Throws `UploadsError` on
     * any failure (including a 404 from an older/self-hosted server without
     * this route, or `source_not_found`) — unlike the degrade-safe promote/
     * comment calls, this is the CLI's only way to move the object, so a
     * failure must be visible, not silently swallowed.
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

    /** Current binding for `repo`, or `{ linked: false }` if unclaimed. Throws
     * `UploadsError` (status 404) on an older/self-hosted server without this
     * route — callers treat that as "bindings unsupported". */
    async githubLinkStatus(repo: string): Promise<GithubLinkResult> {
      return request<GithubLinkResult>(
        "GET",
        `${config.apiUrl}/v1/workspaces/${encodeURIComponent(config.workspace)}/github/link?repo=${encodeURIComponent(repo)}`,
      );
    },

    /**
     * Explicitly claim `repo` for this workspace (first-claim-wins — see
     * github-repo-links.ts server-side). `claimed: false` in the result means
     * the repo is already bound to a DIFFERENT workspace; this call never
     * steals it. Throws `UploadsError` (status 404) on an older/self-hosted
     * server without this route.
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
     * Tri-state binding status for `repo` relative to this workspace (issue
     * #398, `attach --branch`'s stage-time warning) — never names another
     * workspace, unlike `githubLinkStatus` above. Throws `UploadsError`
     * (status 404) on an older/self-hosted server without this route; the
     * caller (the stage warning) treats ANY failure here as "stay silent".
     */
    async githubRepoLinkStatus(repo: string): Promise<GithubRepoLinkResult> {
      return request<GithubRepoLinkResult>(
        "GET",
        `${config.apiUrl}/v1/workspaces/${encodeURIComponent(config.workspace)}/github/repo-link?repo=${encodeURIComponent(repo)}`,
      );
    },

    /**
     * GitHub App configuration + webhook event subscription check. Throws
     * `UploadsError` (status 404) on an older/self-hosted server without
     * this route — callers treat that as "unknown", not "broken".
     */
    /**
     * `POST /v1/workspaces/:workspace/github/ingest` (Task 6) — manual/
     * backfill mirror of a PR/issue's `github.com/user-attachments` media
     * into the workspace. Only ever had the canonical `/v1/workspaces`
     * route (no old bearer-only alias) — unlike the other `github/*` client
     * methods above, which moved onto it in issue #613.
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

    async githubHealth(): Promise<GithubHealthResult> {
      return request<GithubHealthResult>(
        "GET",
        `${config.apiUrl}/v1/workspaces/${encodeURIComponent(config.workspace)}/github/health`,
      );
    },

    /**
     * Self-serve unlink (issue #318): removes `repo`'s binding, but only if
     * this workspace currently owns it. Throws `UploadsError` (status 403)
     * when a different workspace owns the binding — never steals or
     * overwrites another workspace's claim. Throws (status 404) on an
     * older/self-hosted server without this route.
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
