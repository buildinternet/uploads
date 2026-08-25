import { ForbiddenError, InsufficientScopeError, UnauthorizedError } from "@uploads/errors";
import {
  d1ExecMs,
  ServerTiming,
  serverTimingDisabled,
  slowOpThresholdMs,
  timeOp,
} from "@uploads/observability";
import type { Context, MiddlewareHandler } from "hono";
import type { R2Jurisdiction, StorageProvider } from "@uploads/storage";
import {
  FILE_SCOPES,
  findActiveToken,
  isWorkspaceScope,
  parseScopes,
  touchTokenLastUsed,
  type FileScope,
  type WorkspaceScope,
} from "./auth-db";
import { dbFor } from "./db-session";
import { writeSlowOpPoint } from "./slow-op-analytics";

export type { FileScope } from "./auth-db";

/**
 * Appends `timing`'s Server-Timing entries to the response (issue #812) —
 * merges with anything a downstream middleware (e.g. `sessionAuth` on a
 * dual-auth route) already appended, since Hono joins multiple `append`ed
 * values for the same header name. No-ops when the kill switch is set or
 * there's nothing to report.
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
  /** R2 jurisdiction of a BYO bucket (issue #593). Only ever "eu" or "fedramp"; absent = default endpoint. */
  jurisdiction?: R2Jurisdiction;
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
   * Cap on total workspace members, counting pending invites (issue #450).
   * Omit to take the plan default; `null` clears it to unlimited. Enforced
   * at invite creation only — never retroactively, so a workspace over cap
   * keeps every member and simply can't send new invites. Resolved by
   * `@uploads/billing`'s `resolveMemberCap`, not the budget seam: the member
   * cap treats a self-serve workspace with no `plan` stamped as free, where
   * upload budgets treat an absent plan as legacy/unlimited.
   */
  maxMembers?: number | null;
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
   * Actor-on-PR gate for the managed GitHub comment (issue #297, control 2).
   * When `true`, a comment call whose token carries a resolvable GitHub
   * identity is declined (`actor_not_authorized`) unless that identity is the
   * target PR/issue's author, an assignee, or a requested reviewer. Default
   * (undefined/false) = log-only dry-run: the check still runs and logs a
   * would-decline, but never blocks. Best-effort augment by construction — a
   * token with no minting user, or any lookup failure, always skips the
   * check; the structural repo binding above it stays the real gate.
   */
  githubCommentRequireActorOnPr?: boolean;
  /** Workspace default for managed-comment image width (issue #307):
   * "full" omits the width attribute; a number (160–1000) forces that px.
   * Absent = auto (filename-heuristic sizing). Repo `.uploads.yml` overrides. */
  githubCommentImageWidth?: "full" | number;
  /** Workspace default for how many images render inline (1–48) before the
   * remainder collapse to links. Absent = 16. Repo config overrides. */
  githubCommentMaxInlineImages?: number;
  /** Workspace default short markdown note under the comment header.
   * Trimmed, max 500 chars (validated on PATCH). Repo config overrides. */
  githubCommentNote?: string;
  /** Workspace default for the repo `ingestGithubAttachments` knob (issue-spec 2026-08-11). */
  githubIngestAttachments?: boolean;
  /** Workspace default for the repo `adoptLinkedFiles` knob (issue #701). */
  githubAdoptLinkedFiles?: boolean;
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
  /**
   * Self-serve BYO-bucket feature gate (issue #583 Task 1.3). Fail-closed:
   * only `true` unlocks the storage-config surface (verify/write routes,
   * settings UI panel, create-flow branch). Default (undefined/false) keeps
   * every workspace on the shared bucket. Only an operator can set this
   * today (admin-ui limits/plan PATCH pattern) — no self-serve opt-in exists
   * yet. See `byoBucketAllowed` below (precedent: `videoPosterEnabled`).
   */
  byoBucketEnabled?: boolean;
  /** ISO timestamp of the most recent successful `PUT /me/workspaces/:name/storage` (self-serve storage-config save). Provenance for the settings UI, not read for any gating decision. */
  storageConfiguredAt?: string;
  /** ISO timestamp of the most recent successful storage verification (either at save time or a standalone re-verify). Powers the settings UI's "verified ✓ N days ago" line. */
  storageVerifiedAt?: string;
  /** Better Auth user id that most recently configured this workspace's storage via the self-serve flow. */
  storageConfiguredBy?: string;
  /**
   * Last 4 characters of the *plaintext* access key id, captured at seal time
   * for the settings UI. Never derive a display fragment from `accessKeyId`
   * itself — that field holds the sealed (`enc:v1:`) blob after a self-serve
   * save, so its trailing characters are ciphertext.
   */
  storageAccessKeyIdLast4?: string;
  /**
   * All configured inactive lanes: saved-but-never-used configs and demoted
   * former actives (spec: docs/superpowers/specs/2026-08-22-two-lane-storage-design.md,
   * "Record shape"). Absent/empty on every record until a later PR starts
   * writing to it — nothing in PR B populates this field.
   */
  storageLanes?: StorageLane[];
  /**
   * Id of the currently-active lane (the top-level storage fields above).
   * Absent means a record that predates this design — the implicit original
   * lane. Stamped into new-upload provenance (see `files-core.ts`).
   */
  storageLaneId?: string;
  /**
   * Set when the active BYO lane's credentials stopped working (issue #826) —
   * the timestamp of the *first* failure in the current unhealthy stretch, so
   * the UI can say "failing since". Absent = healthy, which is also every
   * shared-lane record: a platform-binding failure is never a workspace's
   * problem to fix. Written and cleared only through
   * `storage-health.ts`.
   */
  storageUnhealthyAt?: string;
  /**
   * Which kind of failure flagged the lane — `StorageHealthCode` in
   * `storage-health.ts` (`"auth" | "bucket_missing" | "unreachable"`),
   * widened to `string` here so an older worker reading a newer record can't
   * fail to parse it. Picks the plain-language sentence; the flag itself is
   * `storageUnhealthyAt`.
   */
  storageUnhealthyCode?: string;
}

/**
 * The storage-connection fields shared by `WorkspaceRecord`'s top-level
 * (active-lane) fields and a `StorageLane` — bucket/binding/credentials, not
 * lane bookkeeping (id, verifiedAt, lastActiveAt) or the display-only
 * mirrors. `packages/storage`'s `resolveStorageConfig` accepts this shape so
 * one function resolves either the active fields or a saved lane.
 * `provider` is a widened string (validated to `"r2"` at that boundary, not
 * here) so future files-sdk-supported providers need no record-shape
 * migration — see the spec's "N-lane readiness".
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
}

/**
 * A saved-or-formerly-active storage configuration, addressed by `id`.
 * Lane state is derived, not stored as an enum: **standby** = configured and
 * verified, `lastActiveAt` absent — a saved config that has never received
 * writes; **fallback** = `lastActiveAt` set — a former active lane that may
 * hold objects and participates in read resolution.
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
   * Health carried down from the active-lane fields when this lane was
   * demoted (issue #826) — a lane you switched away from *because* it broke
   * still reads as broken in the lane list. Cleared on promotion: a lane only
   * becomes active after it verifies.
   */
  unhealthyAt?: string;
  /** `StorageHealthCode`, widened to `string` — see `WorkspaceRecord.storageUnhealthyCode`. */
  unhealthyCode?: string;
}

/** New lane id: "lane_" + 8 lowercase hex chars from crypto.getRandomValues. */
export function newLaneId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `lane_${hex}`;
}

/**
 * Gate for the self-serve BYO-bucket surface (issue #583 Task 1.3). GA'd
 * 2026-08-24: on by default for every workspace — only an operator-set
 * explicit `false` (the admin panel's Storage toggle) blocks it, kept as a
 * per-workspace kill switch. Plan-level gating, if a billing decision ever
 * wants it, goes through `planAllowsByoBucket` (@uploads/billing), not here.
 */
export function byoBucketAllowed(record: Pick<WorkspaceRecord, "byoBucketEnabled">): boolean {
  return record.byoBucketEnabled !== false;
}

/**
 * The #619 posture, generalized to activating any lane: switching TO a
 * binding-mode (shared) lane must survive `byoBucketEnabled` revocation —
 * the workspace can never be stranded on a customer bucket just because an
 * operator turned the flag off — while switching to an HTTP-credential-mode
 * (BYO) lane still requires the flag. `storageActivateHandler` is this
 * predicate's only caller today; the legacy no-`laneId` DELETE path has its
 * own differently-shaped #619 gate (it also has to allow a workspace that's
 * never been BYO-configured to short-circuit as a no-op) and is not a good
 * fit for reuse here.
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
    /** "session" is set only by `dualWorkspaceAuth` (see dual-workspace-auth.ts). */
    authSource: "d1" | "legacy" | "session";
    /** Stable opaque credential identity used to isolate idempotency keys. */
    authPrincipal: string;
    /** Better Auth user behind the bearer token (issue #340), or null. */
    mintingUserId: string | null;
  };
  Bindings: Env;
};

/** Canonical workspace-name shape (lowercase, 2–63 chars). Shared so callers
 * that validate a name — `loadWorkspaceRecord` here, the token-mint route —
 * don't drift from one another. */
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
 * True when I/O for this record spans an entire dedicated bucket rather
 * than a confined `prefix` slice of a shared one. Platform lifecycle jobs
 * (teardown, retention, reconcile) must not assume they own every object in
 * a bucket like this — once self-serve BYO ships (issue #583) an unprefixed
 * record may be a customer's own bucket, where a `listAll()` + batch delete
 * would erase everything they own, not just what uploads.sh wrote.
 */
export function isUnprefixedDedicatedBucket(record: WorkspaceRecord): boolean {
  return !record.prefix;
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
 * Whether `ws:<name>` is occupied, for the purposes of registering that name.
 *
 * Deliberately NOT `loadWorkspaceRecord(...) !== null`. That function collapses
 * soft-deleted records and purged tombstones to "not found" so every auth and
 * serving path 404s uniformly — but those records still hold the KV key, and
 * the slug stays unregistrable (see docs/deletion.md). Anything deciding
 * whether a name can be *taken* must ask this question instead, or it will
 * disagree with the creation path.
 *
 * Both `POST /v1/workspaces` and the workspace-name suggestion (#506) gate on
 * this, so a prefilled name can never be one creation would reject with
 * `workspace_name_taken`.
 *
 * No `cacheTtl`: a 60s-stale cached miss would let a just-taken name through to
 * the org's own uniqueness check, which is fine, but a stale HIT must not block
 * a genuinely free name.
 */
export async function isWorkspaceNameTaken(env: Env, name: string): Promise<boolean> {
  return (await env.REGISTRY.get(`ws:${name}`)) !== null;
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
    // Compare against every *valid* candidate hash (no early break) so match
    // position isn't timing-visible. Skip corrupt/hand-edited hashes: unequal
    // lengths make timingSafeEqual throw and would 500 the whole tenant.
    // Note: total work scales with token count — acceptable for this throwaway PoC; a leaked
    // token-count signal goes away with the real auth system.
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
    // Always pay the D1 round-trip, with dummy inputs when the workspace is
    // unknown or the token empty, so response latency doesn't reveal whether
    // a workspace name exists (uniform-401 guarantee above).
    // One collector per request (issue #812) — findActiveToken's `.first()`
    // carries no D1 `meta`, so only wall time is recorded for it; the
    // touch-below `.run()` does carry `meta.duration` and reports exec ms too.
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

    if (!ok || !record || !name) throw new UnauthorizedError();

    c.set("workspace", record);
    c.set("workspaceName", name);
    c.set("authScopes", d1Token ? parseScopes(d1Token.scopes) : [...FILE_SCOPES]);
    c.set("authSource", d1Token ? "d1" : "legacy");
    c.set("authPrincipal", d1Token ? `d1-token:${d1Token.id}` : `legacy-token:${providedHash}`);
    // Uploader attribution (issue #340) — null for legacy/enrollment tokens.
    c.set("mintingUserId", d1Token?.minting_user_id ?? null);
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
