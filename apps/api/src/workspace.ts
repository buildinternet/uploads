import { ForbiddenError, InsufficientScopeError, UnauthorizedError } from "@uploads/errors";
import type { NoUploadsCommentMode } from "@uploads/comment-config";
import { insufficientScopeMessage } from "./scope-message";
import {
  d1ExecMs,
  ServerTiming,
  serverTimingDisabled,
  slowOpThresholdMs,
  timeOp,
} from "@uploads/observability";
import { setIssueContext } from "@uploads/observability/issues";
import type { Context, MiddlewareHandler } from "hono";
import type { R2Jurisdiction, StorageProvider } from "@uploads/storage";
import {
  FILE_SCOPES,
  findActiveToken,
  findExpiredToken,
  isWorkspaceScope,
  parseScopes,
  touchTokenLastUsed,
  type AuthTokenRecord,
  type FileScope,
  type WorkspaceScope,
} from "./auth-db";
import {
  type ClientPrincipal,
  legacyClientPrincipal,
  legacyCliUserAgent,
  parseCliUserAgent,
  recordClient,
  tokenClientPrincipal,
} from "./client-activity";
import { dbFor } from "./db-session";
import { writeSlowOpPoint } from "./slow-op-analytics";
import { type UploaderIdentity, userUploaderIdentity } from "./uploader-identity";

export type { FileScope } from "./auth-db";

/**
 * Appends `timing`'s Server-Timing entries, merging with any a downstream
 * middleware already appended. No-ops when disabled or empty.
 */
function appendServerTiming<T extends { Bindings: Env }>(
  c: Context<T>,
  timing: ServerTiming,
): void {
  if (serverTimingDisabled(c.env)) return;
  const value = timing.header();
  if (value) c.header("Server-Timing", value, { append: true });
}

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
   * `mutateWorkspaceRecord`. Absent reads as 0. Used only to tell whether
   * the blob just stored is still the one in KV (`workspace-mutate.ts`).
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
  /** R2 jurisdiction of a BYO bucket: "eu" or "fedramp"; absent = default endpoint. */
  jurisdiction?: R2Jurisdiction;
  /** S3-compatible service endpoint origin (e.g. an S3-compatible provider's URL). Required for `provider: "s3"`. */
  endpoint?: string;
  /** SigV4 signing region for a `provider: "s3"` bucket (e.g. "us-east-1"). Required for `provider: "s3"`. */
  region?: string;
  /** Path-style addressing (`https://endpoint/bucket/key`) instead of virtual-hosted style. `provider: "s3"` only. */
  forcePathStyle?: boolean;
  /**
   * Max bytes for a single image upload. Omit for the plan default; with no
   * `plan`, the legacy DEFAULT_MAX_UPLOAD_BYTES.
   */
  maxUploadBytes?: number;
  /** Max bytes for video/mp4 and video/webm. Unset: maxUploadBytes. */
  maxVideoUploadBytes?: number;
  /** Allowed (sniffed) content types. Falls back to DEFAULT_ALLOWED_CONTENT_TYPES. */
  allowedContentTypes?: string[];
  /** Cap on net stored bytes, enforced on put against the usage ledger. Omit for unlimited. */
  maxStorageBytes?: number;
  /** Cap on successful puts per UTC calendar month. Omit for unlimited. */
  maxUploadsPerPeriod?: number;
  /**
   * Cap on members plus pending invites. Omit for the plan default; `null` is
   * unlimited. Enforced only at invite creation. Resolved by
   * `resolveMemberCap`, which treats a self-serve workspace with no `plan` as
   * free (upload budgets treat that as unlimited).
   */
  maxMembers?: number | null;
  /** Retention in days for purge-expired. Omit to skip retention. */
  retentionDays?: number;
  /** Subscription plan. Absent or unrecognized reads as `free`. */
  plan?: "free" | "pro";
  /**
   * When the plan first went from free to paid. Stamped once (Stripe plan
   * sync or the admin plan PATCH) and never overwritten, so it answers
   * "customer since". The auth `subscription` table's periods roll forward,
   * so tenure can't be derived from it.
   */
  paidSince?: string;
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
  /** When the record was created. Absent on legacy records. */
  createdAt?: string;
  /**
   * Managed-comment attachment links: `false` links raw bytes instead of the
   * `/f/` page. Default links to the file page. Comment only.
   */
  githubCommentLinkToFilePage?: boolean;
  /**
   * When a PR with no uploads gets the how-to comment ("Ask for screenshots"):
   * "auto" (UI files changed, the default), "always", or "never". Older
   * records hold a boolean: true = "auto", false = "never". A repo's
   * `.uploads.yml` `noUploadsComment` wins over this.
   */
  githubNoUploadsComment?: NoUploadsCommentMode | boolean;
  /**
   * Workspace default for `.uploads.yml` `uiPaths`: globs for the files that
   * count as UI changes. A repo that sets its own `uiPaths` (even `[]`)
   * replaces this list.
   */
  githubUiPaths?: string[];
  /**
   * Workspace default for `.uploads.yml` `check.require: [uploads]`: the
   * uploads.sh check fails on a PR that changes UI files with nothing
   * attached. A repo that sets its own `check.require` replaces this.
   */
  githubRequireUploads?: boolean;
  /**
   * Whether the managed comment shows `path`/`state` metadata. Default shows.
   * `false` skips the metadata read. No other key is ever read here: the
   * comment is public on repos whose visibility isn't checked.
   */
  githubCommentShowMetadata?: boolean;
  /**
   * Actor-on-PR gate for the managed comment. When `true`, a token with a
   * resolvable GitHub identity is declined (`actor_not_authorized`) unless
   * it's the PR/issue author, an assignee, or a requested reviewer. Default
   * only logs would-declines. Any lookup failure skips the check; the repo
   * binding stays the real gate.
   */
  githubCommentRequireActorOnPr?: boolean;
  /** Workspace default managed-comment image width: "full" omits the width;
   * a number (160–1000) forces it. Absent = auto. Repo config overrides. */
  githubCommentImageWidth?: "full" | number;
  /** Workspace default for how many images render inline (1–48) before the
   * remainder collapse to links. Absent = 16. Repo config overrides. */
  githubCommentMaxInlineImages?: number;
  /** Workspace default short markdown note under the comment header.
   * Trimmed, max 500 chars (validated on PATCH). Repo config overrides. */
  githubCommentNote?: string;
  /** Workspace default for the repo `ingestGithubAttachments` knob. */
  githubIngestAttachments?: boolean;
  /** Workspace default for the repo `adoptLinkedFiles` knob. */
  githubAdoptLinkedFiles?: boolean;
  /**
   * Per-workspace opt-out for video posters. Default generates. Set from
   * Settings → Previews.
   */
  videoPosterEnabled?: boolean;
  /**
   * Per-workspace opt-out for PDF first-page previews. Default generates when
   * the Flagship flag is on. Set from Settings → Previews.
   */
  pdfPosterEnabled?: boolean;
  /**
   * Per-workspace opt-out for SVG/XML uploads. Default allows them once the
   * active lane's host is verified; `false` turns them off regardless.
   */
  activeContentUploads?: boolean;
  /**
   * Experimental LLM file classifier hard off. Flagship
   * `llm-file-classifier` is the allowlist (default off, targeting on
   * `{ org, workspace }`). Only `false` blocks classification here;
   * `undefined`/`true` do not. See `classificationAllowed` in classifier.ts.
   */
  llmClassifierEnabled?: boolean;
  /**
   * Hold high-confidence secret or sensitive-PII uploads for approval
   * (`upload-hold.ts`). On unless `false`. Only matters where the
   * classifier runs.
   */
  holdFlaggedUploads?: boolean;
  /**
   * Workspace admins' switch for AI labels on uploads (the settings page).
   * On unless `false`. Separate from the operator's `llmClassifierEnabled`
   * hard off, so an admin cannot switch on what an operator turned off.
   */
  classifyUploads?: boolean;
  /** Set by `DELETE /admin/workspaces/:name` (default/soft mode). Present → the workspace is soft-deleted. */
  deletedAt?: string;
  /** `deletedAt` + the grace window (`WORKSPACE_DELETE_GRACE_DAYS`); the retention sweep finalizes at/after this. */
  purgeAt?: string;
  /**
   * Operator kill switch for self-serve BYO storage. See `byoBucketAllowed`.
   */
  byoBucketEnabled?: boolean;
  /** Last successful self-serve storage-config save. Display only. */
  storageConfiguredAt?: string;
  /** Last successful storage verification. Display only. */
  storageVerifiedAt?: string;
  /** Active lane's last successful sandboxing-CSP check (mirrors `StorageLane.activeContentVerifiedAt`). Absent = never passed. */
  storageActiveContentVerifiedAt?: string;
  /**
   * When each lane's on-demand "Check now" probe last ran, keyed by lane id
   * (or `active`). A cooldown clock for `storageVerifyActiveContentHandler`:
   * it records attempts, not successes. Not a `StorageLane` field, so it
   * can't be mistaken for verification state. Pruned on every write.
   */
  storageActiveContentCheckedAt?: Record<string, string>;
  /** Better Auth user id that most recently configured this workspace's storage via the self-serve flow. */
  storageConfiguredBy?: string;
  /**
   * Last 4 chars of the plaintext access key id. Never derive this from
   * `accessKeyId`, which holds the sealed blob.
   */
  storageAccessKeyIdLast4?: string;
  /** Inactive lanes: saved-but-never-used configs and demoted former actives. */
  storageLanes?: StorageLane[];
  /**
   * Id of the active lane (the top-level storage fields). Absent on records
   * that predate lanes. Stamped into new-upload provenance.
   */
  storageLaneId?: string;
  /**
   * First failure of the active BYO lane's current unhealthy stretch ("failing
   * since"). Absent = healthy, always so for shared lanes. Written only by
   * `storage-health.ts`.
   */
  storageUnhealthyAt?: string;
  /**
   * `StorageHealthCode` (`storage-health.ts`), widened to `string` so an
   * older worker can parse a newer record.
   */
  storageUnhealthyCode?: string;
}

/**
 * Storage-connection fields shared by the record's active-lane fields and a
 * `StorageLane`, so `resolveStorageConfig` handles either. `provider` is a
 * widened string, validated at that boundary.
 */
export interface StorageLaneFields {
  provider: string;
  bucket: string;
  /** Shared lane uses the binding; BYO lanes are HTTP-credential mode. */
  binding?: string;
  prefix?: string;
  publicBaseUrl?: string;
  accountId?: string;
  /** Sealed (`enc:v1:`) on a `StorageLane`; same shape as the active-lane pair. */
  accessKeyId?: string;
  /** Sealed (`enc:v1:`) on a `StorageLane`. */
  secretAccessKey?: string;
  jurisdiction?: R2Jurisdiction;
  /** S3-compatible service endpoint origin. Required for `provider: "s3"`. */
  endpoint?: string;
  /** SigV4 signing region for `provider: "s3"`. Required for `provider: "s3"`. */
  region?: string;
  /** Path-style addressing instead of virtual-hosted style. `provider: "s3"` only. */
  forcePathStyle?: boolean;
}

/**
 * A saved or formerly active storage configuration. State is derived:
 * standby = no `lastActiveAt` (never received writes); fallback =
 * `lastActiveAt` set (may hold objects, used for reads).
 */
export interface StorageLane extends StorageLaneFields {
  /** Short opaque id, e.g. "lane_<8hex>"; stamped into new-upload provenance. */
  id: string;
  /** Last successful verify run against this lane's config. */
  verifiedAt?: string;
  /** Set when the lane is demoted from active; absence = never held writes (standby). */
  lastActiveAt?: string;
  /** Display/provenance mirrors of the top-level fields of the same name. */
  storageAccessKeyIdLast4?: string;
  storageConfiguredAt?: string;
  storageConfiguredBy?: string;
  /**
   * Health carried over when the lane was demoted, so a lane switched away
   * from because it broke still reads as broken. Cleared on promotion.
   */
  unhealthyAt?: string;
  /** `StorageHealthCode`, widened to `string` — see `WorkspaceRecord.storageUnhealthyCode`. */
  unhealthyCode?: string;
  /**
   * Last successful sandboxing-CSP check for this lane's public host. The
   * SVG/XML gate reads this, not `verifiedAt`: a lane can verify while its
   * host fails the probe.
   */
  activeContentVerifiedAt?: string;
}

/** New lane id: "lane_" + 8 lowercase hex chars from crypto.getRandomValues. */
export function newLaneId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `lane_${hex}`;
}

/**
 * Self-serve BYO storage is on for every workspace; only an operator-set
 * `false` blocks it.
 */
export function byoBucketAllowed(record: Pick<WorkspaceRecord, "byoBucketEnabled">): boolean {
  return record.byoBucketEnabled !== false;
}

/**
 * Switching to the shared lane must survive `byoBucketEnabled` revocation so
 * a workspace is never stranded on a customer bucket; switching to a BYO lane
 * still requires the flag.
 */
export function laneActivationAllowed(
  record: Pick<WorkspaceRecord, "byoBucketEnabled">,
  targetLane: Pick<StorageLaneFields, "binding">,
): boolean {
  return Boolean(targetLane.binding) || byoBucketAllowed(record);
}

/** Days a soft-deleted workspace's data is retained before the retention sweep finalizes it. */
export const WORKSPACE_DELETE_GRACE_DAYS = 14;

/**
 * Permanent tombstone left under `ws:<name>` after finalization. Its presence
 * keeps the slug reserved; see `workspace-teardown.ts`.
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
    /** "session" is set only by `dualWorkspaceAuth` (see dual-workspace-auth.ts). */
    authSource: "d1" | "legacy" | "session";
    /** Stable opaque credential identity used to isolate idempotency keys. */
    authPrincipal: string;
    /**
     * Who this credential uploads as: a user, a service token, or neither.
     * Use `mintingUserIdOf` when only the user id matters.
     */
    uploaderIdentity: UploaderIdentity;
    /** Credential identity for client-activity rows (client-activity.ts); unset on session auth. */
    clientPrincipal?: ClientPrincipal;
  };
  Bindings: Env;
};

/** Canonical workspace-name shape (lowercase, 2–63 chars). */
export const WS_NAME_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

/** SHA-256 hex digests are always 64 lowercase/uppercase hex chars (32 bytes). */
const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;

/** True when `hex` is a well-formed SHA-256 digest (64 hex chars). */
export function isSha256Hex(hex: string): boolean {
  return SHA256_HEX_RE.test(hex);
}

/**
 * Decode a hex string to bytes. Callers that compare digests with
 * `timingSafeEqual` must pass only `isSha256Hex` values — unequal lengths
 * throw in the Workers runtime.
 */
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

/**
 * True when the record spans a whole dedicated bucket rather than a
 * `prefix` slice. Lifecycle jobs must not assume they own every object
 * there: it may be a customer's own bucket.
 */
export function isUnprefixedDedicatedBucket(record: WorkspaceRecord): boolean {
  return !record.prefix;
}

function bearerToken(header: string | undefined): string {
  return header?.startsWith("Bearer ") ? header.slice(7) : "";
}

/**
 * Token prefixes: `up_` personal, `ups_` workspace-owned service tokens, so a
 * leaked token says what it is. Lookup is always by hash.
 */
export const PERSONAL_TOKEN_PREFIX = "up_";
export const SERVICE_TOKEN_PREFIX = "ups_";

/** True for a bearer shaped like a workspace token (`up_…` or `ups_…`). */
export function isWorkspaceTokenShaped(token: string | undefined): boolean {
  return (
    token !== undefined &&
    (token.startsWith(PERSONAL_TOKEN_PREFIX) || token.startsWith(SERVICE_TOKEN_PREFIX))
  );
}

/** Workspace name encoded in a bearer token (`up_<name>_…` or `ups_<name>_…`), if well-formed. */
export function workspaceNameFromToken(token: string): string | undefined {
  const match = /^ups?_([a-z0-9][a-z0-9-]{1,62})_./.exec(token);
  return match?.[1];
}

/**
 * Loads a workspace record from REGISTRY KV (`ws:<name>`), or null for an
 * unknown or malformed name.
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
  // Soft-deleted and tombstoned records deny like an unknown workspace but
  // keep the KV key, so the slug can't be re-registered.
  if (!record || isPurgedTombstone(record) || record.deletedAt) return null;
  // The lookup key is the source of truth for the slug, not stored JSON.
  return { ...record, name };
}

/**
 * Whether `ws:<name>` is occupied for registration. Not
 * `loadWorkspaceRecord(...) !== null`, which hides soft-deleted records and
 * tombstones that still hold the slug.
 *
 * No `cacheTtl`: a stale hit must not block a free name.
 */
export async function isWorkspaceNameTaken(env: Env, name: string): Promise<boolean> {
  return (await env.REGISTRY.get(`ws:${name}`)) !== null;
}

/**
 * Every `ws:` key with its KV metadata (parse with
 * `parseWorkspaceKeyMetadata`). One paged list, no record reads.
 */
export async function listWorkspaceKeys(
  env: Pick<Env, "REGISTRY">,
): Promise<{ name: string; metadata: unknown }[]> {
  const keys: { name: string; metadata: unknown }[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.REGISTRY.list({ prefix: "ws:", cursor, limit: 100 });
    for (const entry of page.keys) {
      const name = entry.name.startsWith("ws:") ? entry.name.slice(3) : entry.name;
      if (name) keys.push({ name, metadata: entry.metadata });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return keys;
}

/**
 * Every registered workspace name, from paging the `ws:` REGISTRY keys. Keys
 * only — callers that need records fan out `loadWorkspaceRecord` themselves.
 */
export async function listWorkspaceNames(env: Pick<Env, "REGISTRY">): Promise<string[]> {
  return (await listWorkspaceKeys(env)).map((key) => key.name);
}

/**
 * Unfiltered read of `ws:<name>`, including soft-deleted records and
 * tombstones, for admin routes and the retention sweep. No `cacheTtl`.
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
  // Stamp the slug as loadWorkspaceRecord does; tombstones are left alone.
  return { ...record, name };
}

/**
 * Verifies the bearer against the workspace's token hashes and puts the
 * record on the context. Unknown workspaces 401 only after the token check,
 * so names can't be probed more cheaply than tokens. `nameOf` reads the name
 * from the path or from the token itself.
 */
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
    // Compare every valid hash (no early break) so match position isn't
    // timing-visible. Skip malformed hashes: unequal lengths make
    // timingSafeEqual throw.
    const toCheck = candidates.length > 0 ? candidates : [providedHash.replace(/./g, "0")];
    let matched = false;
    let skippedInvalidHash = false;
    for (const hash of toCheck) {
      if (!isSha256Hex(hash)) {
        skippedInvalidHash = true;
        continue;
      }
      const candidateBytes = hexToBytes(hash);
      if (candidateBytes.byteLength !== providedBytes.byteLength) {
        skippedInvalidHash = true;
        continue;
      }
      if (crypto.subtle.timingSafeEqual(providedBytes, candidateBytes)) matched = true;
    }
    if (skippedInvalidHash && record) {
      console.error(
        JSON.stringify({
          message: "workspace_token_hash_invalid",
          workspace: name ?? null,
        }),
      );
    }
    const legacyOk = record !== null && token.length > 0 && candidates.length > 0 && matched;
    // Always pay the D1 round trip, with dummy inputs when the workspace is
    // unknown, so latency doesn't reveal whether a name exists.
    const timing = new ServerTiming();
    const thresholdMs = slowOpThresholdMs(c.env);
    let d1Token: Awaited<ReturnType<typeof findActiveToken>>;
    try {
      d1Token = await timeOp(
        () =>
          findActiveToken(
            dbFor(c.env),
            record && name ? name : "__unknown__",
            token || "__unknown__",
          ),
        {
          name: "d1",
          timing,
          route: c.req.path,
          thresholdMs,
          onSlowOp: (event) => writeSlowOpPoint(c.env, event),
        },
      );
    } finally {
      appendServerTiming(c, timing);
    }
    const ok = legacyOk || (record !== null && d1Token !== null);

    if (!ok || !record || !name) {
      // Dummy inputs again, so this doesn't reveal whether the workspace exists.
      const expired = await findExpiredToken(
        dbFor(c.env),
        record && name ? name : "__unknown__",
        token || "__unknown__",
      );
      if (expired?.expires_at) {
        throw new UnauthorizedError(`This token expired on ${expired.expires_at.slice(0, 10)}.`, {
          code: "token_expired",
          details: { expires_at: expired.expires_at },
        });
      }
      throw new UnauthorizedError();
    }

    c.set("workspace", record);
    c.set("workspaceName", name);
    c.set("authScopes", d1Token ? parseScopes(d1Token.scopes) : [...FILE_SCOPES]);
    c.set("authSource", d1Token ? "d1" : "legacy");
    c.set("authPrincipal", d1Token ? `d1-token:${d1Token.id}` : `legacy-token:${providedHash}`);
    c.set(
      "clientPrincipal",
      d1Token ? tokenClientPrincipal(d1Token) : legacyClientPrincipal(providedHash),
    );
    // `none` for legacy and enrollment tokens.
    c.set("uploaderIdentity", uploaderIdentityOf(d1Token));
    setIssueContext({
      userId: d1Token?.minting_user_id,
      workspace: name,
    });
    if (d1Token) {
      const touchTiming = new ServerTiming();
      try {
        await timeOp(() => touchTokenLastUsed(dbFor(c.env), d1Token.id), {
          name: "d1_touch",
          timing: touchTiming,
          route: c.req.path,
          thresholdMs,
          execMs: d1ExecMs,
          onSlowOp: (event) => writeSlowOpPoint(c.env, event),
        });
      } finally {
        appendServerTiming(c, touchTiming);
      }
    }
    // Lets the CLI warn before the token runs out (90-day tokens).
    if (d1Token?.expires_at) c.header("Uploads-Token-Expires", d1Token.expires_at);
    const userAgent = c.req.header("User-Agent");
    const client = parseCliUserAgent(userAgent) ?? legacyCliUserAgent(userAgent);
    if (client) await recordClient(c, client);
    await next();
  };
}

/**
 * Uploader identity for a D1 token row: a service token's label, else the
 * minting user, else `none`.
 */
export function uploaderIdentityOf(
  token: Pick<AuthTokenRecord, "id" | "label" | "owner" | "minting_user_id"> | null,
): UploaderIdentity {
  if (token?.owner === "workspace") {
    // Labels are required at mint; the fallback only covers a hand-edited row.
    return { kind: "service", tokenId: token.id, label: token.label?.trim() || "service token" };
  }
  return userUploaderIdentity(token?.minting_user_id);
}

/** Resolves `:workspace` from the path (the REST API's routes). */
export const workspaceAuth = workspaceAuthWith((c) => c.req.param("workspace"));

/** Resolves the workspace from the bearer token itself (`up_<name>_…` / `ups_<name>_…`). */
export const tokenWorkspaceAuth = workspaceAuthWith((_c, token) => workspaceNameFromToken(token));

/** Stamped-field result of `stampSoftDelete`/`stampRestore` — the caller writes it back to KV. */
export interface SoftDeleteStamp {
  deletedAt: string;
  purgeAt: string;
}

/** Stamps `deletedAt`/`purgeAt` onto a record. Shared by admin and self-serve delete. */
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
 * True once `purgeAt` has passed; restore must refuse after this. An
 * unparseable `purgeAt` stays restorable.
 */
export function isPastGrace(purgeAt: string | undefined, now: Date = new Date()): boolean {
  if (!purgeAt) return false;
  const purgeAtMs = Date.parse(purgeAt);
  if (!Number.isFinite(purgeAtMs)) return false;
  return now.getTime() >= purgeAtMs;
}

/** Clears `deletedAt`/`purgeAt`. Shared by admin and self-serve restore. */
export function stampRestore(record: WorkspaceRecord): WorkspaceRecord {
  const { deletedAt: _deletedAt, purgeAt: _purgeAt, ...rest } = record;
  return rest;
}

export function requireScope(scope: FileScope): MiddlewareHandler<WorkspaceVars> {
  return async (c, next) => {
    if (!c.get("authScopes").includes(scope)) {
      throw new InsufficientScopeError(scope, insufficientScopeMessage(scope));
    }
    await next();
  };
}

/** Vars set by `workspaceGovernanceAuth` on a matched `workspace:*`-scoped token. */
export type GovernanceVars = {
  Variables: {
    /** `minting_user_id` of the token; invites act as this user. */
    governanceMintingUserId: string | null;
  };
  Bindings: Env;
};

/**
 * Guards a route with a D1 `workspace:*`-scoped token. Governance tokens
 * carry no file access, and this never touches `authScopes`.
 *
 * 401: missing bearer, or no active token for its workspace. 403: token
 * workspace isn't `:name`, or the token lacks the required scope.
 */
export function workspaceGovernanceAuth(scope: WorkspaceScope): MiddlewareHandler<GovernanceVars> {
  return async (c, next) => {
    const token = bearerToken(c.req.header("Authorization"));
    const tokenWorkspace = token ? workspaceNameFromToken(token) : undefined;
    if (!tokenWorkspace) throw new UnauthorizedError();

    const thresholdMs = slowOpThresholdMs(c.env);
    const timing = new ServerTiming();
    let record: Awaited<ReturnType<typeof findActiveToken>>;
    try {
      record = await timeOp(() => findActiveToken(dbFor(c.env), tokenWorkspace, token), {
        name: "d1",
        timing,
        route: c.req.path,
        thresholdMs,
        onSlowOp: (event) => writeSlowOpPoint(c.env, event),
      });
    } finally {
      appendServerTiming(c, timing);
    }
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
    setIssueContext({
      userId: record.minting_user_id,
      workspace: name,
    });
    const touchTiming = new ServerTiming();
    try {
      await timeOp(() => touchTokenLastUsed(dbFor(c.env), record.id), {
        name: "d1_touch",
        timing: touchTiming,
        route: c.req.path,
        thresholdMs,
        execMs: d1ExecMs,
        onSlowOp: (event) => writeSlowOpPoint(c.env, event),
      });
    } finally {
      appendServerTiming(c, touchTiming);
    }
    await next();
  };
}
