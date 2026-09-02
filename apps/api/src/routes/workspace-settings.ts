/**
 * Canonical comment-settings, storage, billing/summary, and comment-preview
 * verticals (issue #613 phase 3, comment-preview added final phase):
 * `/:workspace/comment-settings`, `/:workspace/comment-preview`,
 * `/:workspace/storage`, `/:workspace/storage/verify`, `/:workspace/summary`,
 * `/:workspace/billing`, mounted at `/v1/workspaces` in `index.ts` so its
 * public paths are `/v1/workspaces/:workspace/...`. Same self-contained-
 * router shape as `workspace-members.ts`/`workspace-github.ts`: own auth,
 * own `.onError()`, `.fetch()`-able directly by an alias with no
 * parent-mount dependency for its `:workspace` param.
 *
 * Posture (`.context/613-api-consolidation-plan.md`, "comment-settings",
 * "storage", "billing/summary"; comment-preview follows the comment-settings
 * tier exactly):
 *
 *  - `GET/PATCH /comment-settings`, `GET /comment-preview`,
 *    `GET/POST-verify/PUT/DELETE /storage` — **session-only, admin/owner
 *    tier**. A bearer `Authorization` header 403s `settings_requires_session`
 *    on every route in this tier — none of these verticals has a bearer
 *    analog today (comment-settings/comment-preview: no
 *    `/v1/:workspace/github/comment-settings` exists; storage is
 *    credential-adjacent and a token was never in scope for it), and this PR
 *    mints no new bearer capability for any of them. Flat 5-key
 *    comment-settings envelope (`imageWidth`/`maxInlineImages`/
 *    `showMetadata`/`linkToFilePage`/`note`) preserved EXACTLY — the
 *    admin-ui operator surface's prefixed 6-key naming
 *    (`/admin-ui/workspaces/:name/settings`) is a different privilege tier
 *    entirely and stays untouched. Storage's masked `storageStatusResponse`
 *    projection (never credential values) is likewise preserved exactly —
 *    see `workspace-storage.ts`. `comment-preview`'s response body (moved
 *    verbatim from `routes/me.ts`) is unchanged — see
 *    `commentPreviewHandler`'s docblock.
 *  - `GET /summary`, `GET /billing` — **session-only, member tier**. A
 *    bearer header 403s `billing_requires_session` — same "no bearer analog,
 *    none minted" posture, distinct code from the admin tier above so the
 *    two privilege levels in this router don't share one coded error.
 *    `billing`'s `stripeCustomerId` redaction (admin-ui-only field) is
 *    preserved exactly — see the handler's docblock.
 *
 * Session auth here is session-only-with-tier, the same small local-guard
 * shape `workspace-members.ts` uses (NOT `dualWorkspaceAuth`/
 * `requireSessionAdmin`, which grant a session caller file-plane
 * `FILE_SCOPES`, meaningless for this vertical; NOT `dualGovernanceAuth`,
 * which accepts a bearer governance token, and none of these routes should).
 * Reuses `resolveSessionUserId` from `dual-workspace-auth.ts` for the same
 * "one get-session call per forwarded request" property every other
 * vertical gets from the `presetResolvedSessionUser` WeakMap handoff.
 */
import {
  NOTE_MAX_CHARS,
  resolveCommentOptions,
  type OptionSource,
  type ResolvedCommentOptions,
} from "@uploads/comment-config";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RateLimitedError,
  ValidationError,
} from "@uploads/errors";
import { createStorage, hostOf, type R2Jurisdiction } from "@uploads/storage";
import { dbFor } from "../db-session";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { usageWithLimits } from "../budget";
import { previewFixtureItems } from "../comment-preview-fixtures";
import { hasPreresolvedSession, resolveSessionUserId } from "../dual-workspace-auth";
import { respondError } from "../error-response";
import { getMetadataForKeys } from "../file-metadata";
import { listObjects } from "../files-core";
import { findRepoLink } from "../github-repo-links";
import {
  attachmentsCommentBody,
  attachmentsMarker,
  type AttachmentItem,
} from "../github-comment-render";
import {
  activeContentStatus,
  fresh,
  HOST_RECORD_MAX_AGE_MS,
  LANE_STAMP_MAX_AGE_MS,
} from "../active-content";
import { readHostActiveContent } from "../active-content-hosts";
import { allowWrite } from "../guards";
import {
  adminWorkspaceOr403,
  memberWorkspaceOr404,
  subscriptionForOrg,
  type MyWorkspace,
} from "../org-workspaces";
import { resolveRepoCommentOptions, workspaceCommentDefaults } from "../repo-comment-config";
import { sealCredentialFieldsStrict } from "../secrets";
import { selfServeWorkspaceRecord } from "../self-serve-defaults";
import type { SessionVars } from "../session-auth";
import { clearStorageHealthFields } from "../storage-health";
import { isSharedLane, storageConfig as laneConfig } from "../storage";
import { getWorkspaceUsage } from "../usage";
import {
  byoBucketAllowed,
  laneActivationAllowed,
  newLaneId,
  loadWorkspaceRecord,
  type StorageLane,
  type WorkspaceRecord,
} from "../workspace";
import {
  demoteActiveLane,
  isLaneVerifyStale,
  laneIdentity,
  promoteLane,
  providerCredentialFields,
  upsertDemotedLane,
  upsertStandbyLane,
} from "../workspace-lanes";
import { mutateWorkspaceRecord } from "../workspace-mutate";
import { planResponse, planSourceFor } from "../workspace-plan";
import type { ListBucketsResult } from "../r2-list-buckets";
import {
  activeContentStampFromVerify,
  candidateFromBody,
  isByoRecord,
  laneActiveContentCheck,
  listBuckets,
  storageReconcile,
  storageStatusResponse,
  storageVerify,
  verifyLaneForActivate,
  type StorageStatusResponse,
} from "./workspace-storage";

/** `?repo=` shape for the comment preview endpoint: exactly one `/`, no empty segments. */
const REPO_SHAPE_RE = /^[^/\s]+\/[^/\s]+$/;

/** Context vars a `sessionMemberGate`/`sessionAdminGate`-guarded route can rely on. */
export type SettingsVars = {
  Variables: SessionVars["Variables"] & {
    settingsWorkspace: MyWorkspace;
    settingsUserId: string;
  };
  Bindings: Env;
};

/**
 * Best-effort usage reconcile off the response path. Activation/detach used
 * to await this before responding, which pushed real switches past the
 * browser's request timeout — the client reported "couldn't switch" for a
 * switch that had already committed (#788). `waitUntil` keeps the rebuild
 * running after the response; runtimes without an execution context (unit
 * tests) fall back to awaiting so assertions still see the reconciled state.
 */
async function reconcileOffPath(
  c: Context<SettingsVars>,
  updated: WorkspaceRecord,
  name: string,
  label: string,
): Promise<void> {
  const task = storageReconcile(c.env, updated, name).catch((err) =>
    console.error(`${label}: usage reconcile failed for`, name, err),
  );
  try {
    c.executionCtx.waitUntil(task);
  } catch {
    await task;
  }
}

/**
 * Session-only member gate for the billing/summary tier: a bearer
 * `Authorization` header 403s outright (no bearer capability exists for
 * either route and none is minted here), otherwise resolves the session +
 * membership with a uniform 404 for non-members (never a 403 — no existence
 * probe, same posture as `dualWorkspaceAuth`/`dualGovernanceAuth`/
 * `workspace-members.ts`'s `sessionMemberGate`).
 */
function sessionMemberGate(): MiddlewareHandler<SettingsVars> {
  return async (c, next) => {
    // Preset check first: a forwarded `/me` request keeps its original
    // headers, so a caller who authenticated there with a Better Auth bearer
    // session must not be re-rejected here (same ordering as every other
    // session gate — the #617 review's lesson).
    if (!hasPreresolvedSession(c.req.raw) && c.req.header("Authorization")?.startsWith("Bearer ")) {
      throw new ForbiddenError("requires a session", { code: "billing_requires_session" });
    }
    const userId = await resolveSessionUserId(c as unknown as Context<SessionVars>);
    const name = c.req.param("workspace") ?? "";
    if (!name) throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
    const ws = await memberWorkspaceOr404(c.env, userId, name);
    c.set("settingsWorkspace", ws);
    c.set("settingsUserId", userId);
    await next();
  };
}

/**
 * Session-only admin/owner gate for the comment-settings/storage tier: same
 * bearer-403 posture as `sessionMemberGate` above, but with its own coded
 * error (`settings_requires_session`, not `billing_requires_session`) since
 * these are a materially different privilege tier within this one router.
 * `adminWorkspaceOr403` itself produces the 404-then-403 ordering
 * (non-member -> `workspace_not_found`, member-not-admin ->
 * `workspace_admin_required`).
 */
function sessionAdminGate(): MiddlewareHandler<SettingsVars> {
  return async (c, next) => {
    // Preset-first ordering — see `sessionMemberGate` above.
    if (!hasPreresolvedSession(c.req.raw) && c.req.header("Authorization")?.startsWith("Bearer ")) {
      throw new ForbiddenError("requires a session", { code: "settings_requires_session" });
    }
    const userId = await resolveSessionUserId(c as unknown as Context<SessionVars>);
    const name = c.req.param("workspace") ?? "";
    if (!name) throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
    const ws = await adminWorkspaceOr403(c.env, userId, name);
    c.set("settingsWorkspace", ws);
    c.set("settingsUserId", userId);
    await next();
  };
}

/** `imageWidth` bounds (issue #307): "full" or an integer clamp width in px. */
const COMMENT_IMAGE_WIDTH_MIN = 160;
const COMMENT_IMAGE_WIDTH_MAX = 1000;
/** `maxInlineImages` bounds (issue #307). */
const COMMENT_MAX_INLINE_IMAGES_MIN = 1;
const COMMENT_MAX_INLINE_IMAGES_MAX = 48;

/** The six workspace-level comment-defaults fields (issue #307; ingestGithubAttachments added issue-spec 2026-08-11). */
const COMMENT_SETTINGS_KEYS = [
  "imageWidth",
  "maxInlineImages",
  "showMetadata",
  "linkToFilePage",
  "note",
  "ingestGithubAttachments",
] as const;
type CommentSettingsKey = (typeof COMMENT_SETTINGS_KEYS)[number];

/** Record field each API key writes to. */
const COMMENT_SETTINGS_RECORD_FIELD: Record<CommentSettingsKey, keyof WorkspaceRecord> = {
  imageWidth: "githubCommentImageWidth",
  maxInlineImages: "githubCommentMaxInlineImages",
  showMetadata: "githubCommentShowMetadata",
  linkToFilePage: "githubCommentLinkToFilePage",
  note: "githubCommentNote",
  ingestGithubAttachments: "githubIngestAttachments",
};

type CommentSettingsValue = string | number | boolean;
type CommentSettingsPatch = Partial<Record<CommentSettingsKey, CommentSettingsValue | null>>;

/**
 * Validates a PATCH body for the workspace-level managed-comment defaults
 * (issue #307). Single enforcement point for the bounds the resolver itself
 * does not clamp: imageWidth "full" or an integer 160–1000, maxInlineImages
 * an integer 1–48, and note trimmed, non-empty, and at most `NOTE_MAX_CHARS`.
 * Reject-all-or-apply-all — the whole body is checked before any record
 * mutation, so an invalid field never partially applies. An omitted key
 * means "leave unchanged"; an explicit `null` clears the field. Unknown keys
 * are ignored, mirroring `validateGithubCommentSettingsPatch` (admin-ui.ts)
 * and `validateLimitsPatch` (workspace-limits.ts). Moved verbatim from
 * `routes/me.ts` (issue #613 phase 3) — see git history for the original.
 */
function validateCommentSettingsPatch(body: unknown): CommentSettingsPatch {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ValidationError("request body must be a JSON object", { code: "invalid_settings" });
  }
  const record = body as Record<string, unknown>;
  const patch: CommentSettingsPatch = {};

  if ("imageWidth" in record) {
    const value = record.imageWidth;
    if (value === null) {
      patch.imageWidth = null;
    } else if (value === "full") {
      patch.imageWidth = "full";
    } else if (
      typeof value === "number" &&
      Number.isInteger(value) &&
      value >= COMMENT_IMAGE_WIDTH_MIN &&
      value <= COMMENT_IMAGE_WIDTH_MAX
    ) {
      patch.imageWidth = value;
    } else {
      throw new ValidationError(
        `imageWidth must be "full", an integer ${COMMENT_IMAGE_WIDTH_MIN}–${COMMENT_IMAGE_WIDTH_MAX}, or null`,
        { code: "invalid_settings", details: { field: "imageWidth" } },
      );
    }
  }

  if ("maxInlineImages" in record) {
    const value = record.maxInlineImages;
    if (value === null) {
      patch.maxInlineImages = null;
    } else if (
      typeof value === "number" &&
      Number.isInteger(value) &&
      value >= COMMENT_MAX_INLINE_IMAGES_MIN &&
      value <= COMMENT_MAX_INLINE_IMAGES_MAX
    ) {
      patch.maxInlineImages = value;
    } else {
      throw new ValidationError(
        `maxInlineImages must be an integer ${COMMENT_MAX_INLINE_IMAGES_MIN}–${COMMENT_MAX_INLINE_IMAGES_MAX} or null`,
        { code: "invalid_settings", details: { field: "maxInlineImages" } },
      );
    }
  }

  if ("showMetadata" in record) {
    const value = record.showMetadata;
    if (value !== null && typeof value !== "boolean") {
      throw new ValidationError("showMetadata must be a boolean or null", {
        code: "invalid_settings",
        details: { field: "showMetadata" },
      });
    }
    patch.showMetadata = value;
  }

  if ("linkToFilePage" in record) {
    const value = record.linkToFilePage;
    if (value !== null && typeof value !== "boolean") {
      throw new ValidationError("linkToFilePage must be a boolean or null", {
        code: "invalid_settings",
        details: { field: "linkToFilePage" },
      });
    }
    patch.linkToFilePage = value;
  }

  if ("ingestGithubAttachments" in record) {
    const value = record.ingestGithubAttachments;
    if (value !== null && typeof value !== "boolean") {
      throw new ValidationError("ingestGithubAttachments must be a boolean or null", {
        code: "invalid_settings",
        details: { field: "ingestGithubAttachments" },
      });
    }
    patch.ingestGithubAttachments = value;
  }

  if ("note" in record) {
    const value = record.note;
    if (value === null) {
      patch.note = null;
    } else if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length === 0 || trimmed.length > NOTE_MAX_CHARS) {
        throw new ValidationError(`note must be 1–${NOTE_MAX_CHARS} characters after trimming`, {
          code: "invalid_settings",
          details: { field: "note" },
        });
      }
      patch.note = trimmed;
    } else {
      throw new ValidationError("note must be a string or null", {
        code: "invalid_settings",
        details: { field: "note" },
      });
    }
  }

  return patch;
}

/**
 * Wire type for `GET`/`PATCH /:workspace/comment-settings` (issue #896
 * pattern), inferred from the serializer below so apps/web imports the shape
 * it receives (via `@uploads/api/workspace-settings`) instead of re-declaring
 * it. Type-only — never imported at runtime across workers.
 */
export type CommentSettingsResponse = ReturnType<typeof commentSettingsResponse>;

/** Response body shared by GET and PATCH: the workspace-level comment defaults. */
function commentSettingsResponse(record: WorkspaceRecord) {
  return {
    imageWidth: record.githubCommentImageWidth ?? null,
    maxInlineImages: record.githubCommentMaxInlineImages ?? null,
    showMetadata: record.githubCommentShowMetadata ?? null,
    linkToFilePage: record.githubCommentLinkToFilePage ?? null,
    note: record.githubCommentNote ?? null,
    ingestGithubAttachments: record.githubIngestAttachments ?? null,
  };
}

/** `GET /:workspace/comment-settings` — admin/owner only. */
export async function commentSettingsGetHandler(c: Context<SettingsVars>) {
  const name = c.req.param("workspace") ?? "";
  const record = await loadWorkspaceRecord(c.env, name);
  if (!record) throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
  return c.json(commentSettingsResponse(record));
}

/**
 * `PATCH /:workspace/comment-settings` — admin/owner only. Validated in full
 * before any write (reject-all-or-apply-all — see
 * `validateCommentSettingsPatch`); an omitted key leaves the field
 * unchanged, an explicit `null` clears it.
 */
export async function commentSettingsPatchHandler(c: Context<SettingsVars>) {
  const name = c.req.param("workspace") ?? "";
  if (!(await allowWrite(c.env, name))) {
    throw new RateLimitedError("rate limit exceeded");
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError("request body must be valid JSON", { code: "invalid_settings" });
  }
  const patch = validateCommentSettingsPatch(body);
  const record = await mutateWorkspaceRecord(
    c.env,
    name,
    (current) => {
      const next = { ...current };
      for (const key of COMMENT_SETTINGS_KEYS) {
        if (!(key in patch)) continue;
        const field = COMMENT_SETTINGS_RECORD_FIELD[key];
        const value = patch[key];
        if (value === null || value === undefined) delete next[field];
        else (next as Record<string, unknown>)[field] = value;
      }
      return next;
    },
    { requireServing: true },
  );
  return c.json(commentSettingsResponse(record));
}

/**
 * `GET /:workspace/storage` — self-serve BYO R2 bucket (issue #583 Task
 * 1.1), admin/owner only. Readable regardless of `byoBucketEnabled` (the
 * settings UI needs the flag value to decide whether to show the panel at
 * all). Never returns credential values — `storageStatusResponse`
 * (`workspace-storage.ts`) projects masked/presence fields only, same
 * posture as `GET /admin/workspaces/:name` (admin.ts).
 */
export async function storageGetHandler(c: Context<SettingsVars>) {
  const name = c.req.param("workspace") ?? "";
  const record = await loadWorkspaceRecord(c.env, name);
  if (!record) throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
  const status = storageStatusResponse(record, byoBucketAllowed(record));
  return c.json(await withActiveContentStatus(c.env, record, status));
}

/**
 * Replaces the stamps the pure `storageStatusResponse` projection
 * (`workspace-storage.ts`) can echo with what SVG/XML acceptance actually
 * turns on right now (issue #929).
 *
 * The active lane's row comes straight from `activeContentStatus` — the gate
 * itself — so the page can never say "Verified" about a lane the gate has
 * already closed, whatever closed it: the workspace opt-out, the Flagship
 * flag, an unhealthy lane, a stale hosted-host record, the embed twin's
 * record, or a BYO stamp past `LANE_STAMP_MAX_AGE_MS`. The raw stamp on the
 * record is not that answer; the projection has no KV or flag access to find
 * it out for itself, which is exactly why this lives at the handler.
 *
 * The other lanes aren't the gate's subject — none of them is serving
 * anything — so each is judged on its own evidence: a shared lane by its
 * host's daily-probed record, a BYO lane by its own stamp's freshness. Host
 * records are read once per distinct host, in parallel, since several
 * fallback lanes commonly share one.
 */
async function withActiveContentStatus(
  env: Env,
  record: WorkspaceRecord,
  status: StorageStatusResponse,
): Promise<StorageStatusResponse> {
  const now = new Date();
  const gate = await activeContentStatus(env, record, now);
  status.activeContentVerifiedAt = gate.verifiedAt;
  status.activeContentReason = gate.reason;

  const hosts = new Set(
    status.lanes.flatMap((lane) => {
      if (lane.mode !== "shared") return [];
      const host = hostOf(lane.publicBaseUrl);
      return host ? [host] : [];
    }),
  );
  const hostRecords = new Map(
    await Promise.all(
      [...hosts].map(async (host) => [host, await readHostActiveContent(env, host)] as const),
    ),
  );
  for (const lane of status.lanes) {
    if (lane.mode === "shared") {
      const host = hostOf(lane.publicBaseUrl);
      const hostRecord = host ? hostRecords.get(host) : null;
      lane.activeContentVerifiedAt =
        hostRecord?.ok && fresh(hostRecord.verifiedAt, HOST_RECORD_MAX_AGE_MS, now)
          ? hostRecord.verifiedAt
          : undefined;
    } else if (!fresh(lane.activeContentVerifiedAt, LANE_STAMP_MAX_AGE_MS, now)) {
      lane.activeContentVerifiedAt = undefined;
    }
  }
  return status;
}

/**
 * `POST /:workspace/storage/verify` — runs the verify pipeline
 * (`storage-verify.ts`) against the request body, never saved state, so an
 * admin can iterate on credentials before anything is persisted. 403s
 * `byo_bucket_disabled` when the workspace flag is off. Rate-limited via
 * `allowWrite` like every other mutating-adjacent route here: each call does
 * real remote I/O (auth probe + a write/read/delete round-trip against the
 * candidate bucket).
 */
export async function storageVerifyHandler(c: Context<SettingsVars>) {
  const name = c.req.param("workspace") ?? "";
  const record = await loadWorkspaceRecord(c.env, name);
  if (!record) throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
  if (!byoBucketAllowed(record)) {
    throw new ForbiddenError("BYO storage is not enabled for this workspace", {
      code: "byo_bucket_disabled",
    });
  }
  if (!(await allowWrite(c.env, name))) {
    throw new RateLimitedError("rate limit exceeded");
  }

  const body = await c.req.json().catch(() => null);
  const candidate = candidateFromBody(body);
  const result = await storageVerify(candidate);
  return c.json(result);
}

/** Body shape for `POST /:workspace/storage/buckets`. Never persisted — same in-flight-only posture as verify's candidate body. */
interface ListBucketsBody {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  jurisdiction?: string;
}

function listBucketsCredentialsFromBody(body: unknown): ListBucketsBody {
  const b = (body ?? {}) as Record<string, unknown>;
  return {
    accountId: typeof b.accountId === "string" ? b.accountId : "",
    accessKeyId: typeof b.accessKeyId === "string" ? b.accessKeyId : "",
    secretAccessKey: typeof b.secretAccessKey === "string" ? b.secretAccessKey : "",
    jurisdiction:
      typeof b.jurisdiction === "string" && b.jurisdiction !== "" ? b.jurisdiction : undefined,
  };
}

/**
 * `POST /:workspace/storage/buckets` — the wizard's bucket picker (issue
 * #783 Part A item 2). Same auth/rate-limit tier as `storage/verify` (never
 * persists anything; every call does real remote I/O), but calls S3
 * `ListBuckets` directly (`../r2-list-buckets.ts`) rather than the verify
 * pipeline — `ListBuckets` is account-level, not bucket-scoped, so it's a
 * different request entirely from the round-trip probe.
 *
 * Always 200s with a `ListBucketsResult` body — including the
 * `access_denied` shape a bucket-scoped token produces, which is the
 * *expected*, common case (R2 only permits `ListBuckets` for account-scoped
 * tokens) and the wizard's signal to fall back to a plain bucket-name field,
 * not an error to surface.
 */
export async function storageBucketsHandler(c: Context<SettingsVars>) {
  const name = c.req.param("workspace") ?? "";
  const record = await loadWorkspaceRecord(c.env, name);
  if (!record) throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
  if (!byoBucketAllowed(record)) {
    throw new ForbiddenError("BYO storage is not enabled for this workspace", {
      code: "byo_bucket_disabled",
    });
  }
  if (!(await allowWrite(c.env, name))) {
    throw new RateLimitedError("rate limit exceeded");
  }

  const body = await c.req.json().catch(() => null);
  // The picker is R2-only: `ListBuckets` is a Cloudflare-account-level call
  // with no S3-compatible equivalent this route can drive generically, so an
  // s3 candidate goes straight to a typed 400 rather than an
  // always-`access_denied` round trip. The web form's s3 mode never calls
  // this route (Task 5) — this guards direct API use too.
  if ((body as { provider?: unknown } | null)?.provider === "s3") {
    throw new ValidationError('the bucket picker only supports provider "r2"', {
      code: "unsupported_provider",
      details: { provider: "s3" },
    });
  }
  const creds = listBucketsCredentialsFromBody(body);
  const result: ListBucketsResult = await listBuckets(creds);
  return c.json(result);
}

/**
 * `PUT /:workspace/storage` — verifies a candidate BYO config and saves it
 * as a **standby lane** (spec: "Configure, then switch"). Never trusts a
 * client-side "verified" claim — re-runs the same pipeline server-side
 * against the request body, and only writes on a pass. On a fail, responds
 * with the verify result (422) so the UI can render the same checklist the
 * standalone verify route would have.
 *
 * Saving a config never changes routing — the top-level (active-lane) fields
 * are untouched for any *other* bucket, so there is no
 * `workspace_storage_not_empty` guard on this path: attaching a config to a
 * populated workspace is always safe because nothing about where uploads
 * land has changed yet. Switching lanes is `POST .../storage/activate`'s
 * job. Saving again for the same bucket+accountId replaces that lane in
 * place (`upsertStandbyLane`) rather than appending a duplicate.
 *
 * The one exception: a candidate matching the bucket+accountId of the
 * *currently active* BYO lane is a credential rotation of that lane, not a
 * new saved config — it updates the top-level fields in place instead of
 * writing a standby. Writing a standby here instead would leave the active
 * lane's stale credentials live (nothing ever re-points them at the new
 * standby without an explicit activate) and a later activate's demote step
 * could silently discard the rotated creds entirely (CodeRabbit review).
 *
 * `mutateWorkspaceRecord` (with `requireServing`) both re-checks the
 * workspace hasn't been soft-deleted since the request started and gives us
 * the read-immediately-before-write window issue #387 exists for; sealing
 * happens *inside* that callback (precedent: `reencrypt-registry.ts`), never
 * on data read earlier in the request.
 */
export async function storagePutHandler(c: Context<SettingsVars>) {
  const name = c.req.param("workspace") ?? "";
  const userId = c.get("settingsUserId");
  const record = await loadWorkspaceRecord(c.env, name);
  if (!record) throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
  if (!byoBucketAllowed(record)) {
    throw new ForbiddenError("BYO storage is not enabled for this workspace", {
      code: "byo_bucket_disabled",
    });
  }
  if (!(await allowWrite(c.env, name))) {
    throw new RateLimitedError("rate limit exceeded");
  }

  const body = await c.req.json().catch(() => null);
  const candidate = candidateFromBody(body);
  const result = await storageVerify(candidate);
  if (!result.ok) {
    return c.json(result, 422);
  }

  const nowIso = new Date().toISOString();
  // ok when the recommended `active-content-headers` check passed; absent
  // (no publicBaseUrl, or the check failed/never ran) counts as not-verified
  // — SVG/XML stay off for this lane until a check actually succeeds. That
  // includes inconclusive: unlike the dedicated verify route
  // (`storageVerifyActiveContentHandler`), which leaves a prior stamp
  // untouched on an inconclusive recheck, a save always makes a fresh
  // determination from this result — inconclusive-on-save clears the stamp,
  // fail-closed, by design.
  const activeContentVerifiedAt = activeContentStampFromVerify(result, nowIso);
  const updated = await mutateWorkspaceRecord(
    c.env,
    name,
    async (current) => {
      const sealed = await sealCredentialFieldsStrict(c.env.WORKSPACE_SECRETS_KEY, {
        accessKeyId: candidate.accessKeyId,
        secretAccessKey: candidate.secretAccessKey,
      });
      // Prefer whatever the caller supplied explicitly (parsed client-side
      // from a pasted endpoint URL) — cast is safe since `storageVerify`
      // above already ran the shape check (storage-verify.ts) that 422s on
      // anything outside R2_JURISDICTIONS. When the caller omitted it (the
      // common case now that the wizard has no jurisdiction field),
      // fall back to whichever jurisdiction the verify pipeline's auto-probe
      // actually found live — never save a jurisdiction the bucket wasn't
      // proven to answer at.
      const jurisdiction =
        (candidate.jurisdiction as R2Jurisdiction | undefined) ?? result.jurisdiction;
      // Display fragment for the settings UI, captured from the plaintext
      // before sealing — every sealed field below is ciphertext from here on.
      const accessKeyIdLast4 = candidate.accessKeyId.slice(-4);

      const isS3 = candidate.provider === "s3";

      const rotatesActiveLane =
        isByoRecord(current) &&
        (current.provider === "s3") === isS3 &&
        laneIdentity(current) === laneIdentity(candidate);

      if (rotatesActiveLane) {
        const next: WorkspaceRecord = { ...current };
        next.accessKeyId = sealed.accessKeyId;
        next.secretAccessKey = sealed.secretAccessKey;
        if (candidate.publicBaseUrl) next.publicBaseUrl = candidate.publicBaseUrl;
        else delete next.publicBaseUrl;
        if (!isS3 && jurisdiction) next.jurisdiction = jurisdiction;
        else delete next.jurisdiction;
        if (isS3) {
          next.endpoint = candidate.endpoint;
          next.region = candidate.region;
          next.forcePathStyle = candidate.forcePathStyle;
        }
        next.storageVerifiedAt = nowIso;
        if (activeContentVerifiedAt) next.storageActiveContentVerifiedAt = activeContentVerifiedAt;
        else delete next.storageActiveContentVerifiedAt;
        next.storageConfiguredAt = nowIso;
        next.storageConfiguredBy = userId;
        next.storageAccessKeyIdLast4 = accessKeyIdLast4;
        // The rotation just passed the full verify pipeline against these
        // exact credentials, so whatever flagged this lane unhealthy (issue
        // #826) is demonstrably fixed — clear the badge and the banner now
        // rather than waiting for the next upload to prove it again.
        clearStorageHealthFields(next);
        return next;
      }

      const lane: StorageLane = {
        id: newLaneId(),
        provider: isS3 ? "s3" : "r2",
        bucket: candidate.bucket,
        accessKeyId: sealed.accessKeyId,
        secretAccessKey: sealed.secretAccessKey,
        publicBaseUrl: candidate.publicBaseUrl,
        verifiedAt: nowIso,
        activeContentVerifiedAt,
        storageConfiguredAt: nowIso,
        storageConfiguredBy: userId,
        storageAccessKeyIdLast4: accessKeyIdLast4,
        // s3 candidates carry no accountId/jurisdiction; r2 candidates carry
        // no endpoint/region/forcePathStyle — never both on one lane.
        ...providerCredentialFields(isS3, {
          accountId: candidate.accountId,
          jurisdiction,
          endpoint: candidate.endpoint,
          region: candidate.region,
          forcePathStyle: candidate.forcePathStyle,
        }),
      };
      return { ...current, storageLanes: upsertStandbyLane(current.storageLanes, lane) };
    },
    { requireServing: true },
  );

  console.log(JSON.stringify({ event: "workspace_storage_saved", workspace: name, userId }));

  const status = await withActiveContentStatus(
    c.env,
    updated,
    storageStatusResponse(updated, true),
  );
  return c.json({ ...status, verify: result });
}

/**
 * `POST /:workspace/storage/activate` — switches the active (write) lane to
 * a saved config, body `{ laneId }` (spec: "Configure, then switch",
 * decoupled activation). The target lane must already be saved in
 * `storageLanes` — either a standby config from `PUT` or a former active
 * lane being reactivated. `byoBucketAllowed` is required unless the target
 * is binding-mode: switching back to shared storage must survive flag
 * revocation, the same #619 posture `storageDeleteHandler`'s legacy detach
 * already carries — an HTTP-mode target still requires the flag.
 *
 * An HTTP-credential-mode target whose `verifiedAt` is stale (or absent) is
 * re-verified against its *opened* (decrypted) credentials before the swap —
 * a switch never lands on a config that has silently rotted — and 422s with
 * the verify result, mutating nothing, on failure. Binding-mode targets
 * (switching back to shared) skip verification entirely: there's nothing to
 * decrypt or reach over HTTP.
 *
 * The swap itself is one `mutateWorkspaceRecord` callback: the current
 * active fields are demoted into a lane (`demoteActiveLane`) and the target
 * is promoted onto the top level (`promoteLane`) — read paths built in PR C
 * mean the demoted lane keeps serving pre-switch files immediately.
 */
export async function storageActivateHandler(c: Context<SettingsVars>) {
  const name = c.req.param("workspace") ?? "";
  const userId = c.get("settingsUserId");
  const record = await loadWorkspaceRecord(c.env, name);
  if (!record) throw new NotFoundError("workspace not found", { code: "workspace_not_found" });

  const body = await c.req.json().catch(() => null);
  const laneId = (body as { laneId?: unknown } | null)?.laneId;
  if (typeof laneId !== "string" || laneId.length === 0) {
    throw new ValidationError("laneId is required", { code: "invalid_lane_id" });
  }
  const target = (record.storageLanes ?? []).find((lane) => lane.id === laneId);
  if (!target) {
    throw new NotFoundError("storage lane not found", { code: "storage_lane_not_found" });
  }

  if (!laneActivationAllowed(record, target)) {
    throw new ForbiddenError("BYO storage is not enabled for this workspace", {
      code: "byo_bucket_disabled",
    });
  }
  if (!(await allowWrite(c.env, name))) {
    throw new RateLimitedError("rate limit exceeded");
  }

  const nowIso = new Date().toISOString();
  let verifiedAt = target.verifiedAt;
  // Carried forward unless a re-verify below runs and settles it fresh —
  // same "carry, or refresh from the fresh result" posture as `verifiedAt`.
  let activeContentVerifiedAt = target.activeContentVerifiedAt;
  // A lane carrying a health flag (issue #826) is re-verified however fresh
  // its `verifiedAt` looks: the flag is later evidence than the stamp, and
  // `promoteLane` clears the flag unconditionally — so without this a broken
  // lane could be switched back to and silently read as healthy again.
  if (!isSharedLane(target) && (isLaneVerifyStale(target.verifiedAt) || target.unhealthyAt)) {
    const result = await verifyLaneForActivate(c.env, target);
    if (!result.ok) {
      return c.json(result, 422);
    }
    verifiedAt = nowIso;
    // Same fail-closed posture as `storagePutHandler`: this re-verify is a
    // fresh determination, so inconclusive-on-save clears the stamp rather
    // than carrying the pre-re-verify value forward, unlike the dedicated
    // verify route's leave-it-alone handling of an inconclusive recheck.
    activeContentVerifiedAt = activeContentStampFromVerify(result, nowIso);
  }

  const updated = await mutateWorkspaceRecord(
    c.env,
    name,
    (current) => {
      const freshTarget = (current.storageLanes ?? []).find((lane) => lane.id === laneId);
      if (!freshTarget) {
        throw new ConflictError("storage lane no longer exists", {
          code: "storage_lane_not_found",
        });
      }
      const demoted = demoteActiveLane(current, nowIso);
      const remaining = (current.storageLanes ?? []).filter((lane) => lane.id !== laneId);
      const next: WorkspaceRecord = {
        ...current,
        storageLanes: upsertDemotedLane(remaining, demoted),
      };
      promoteLane(next, freshTarget, { verifiedAt, activeContentVerifiedAt });
      return next;
    },
    { requireServing: true },
  );

  console.log(
    JSON.stringify({
      event: "workspace_storage_lane_activated",
      workspace: name,
      userId,
      laneId,
    }),
  );

  // The promoted lane may already hold objects (a reactivated fallback, or a
  // standby saved via `adoptExistingContents`) that the ledger has never
  // walked — rebuild totals/shared-subset so `maxStorageBytes` enforcement
  // and the settings UI are honest. Best-effort, same rationale as the
  // legacy attach/detach reconcile calls.
  await reconcileOffPath(c, updated, name, "workspace storage activate");

  return c.json(
    await withActiveContentStatus(
      c.env,
      updated,
      storageStatusResponse(updated, byoBucketAllowed(updated)),
    ),
  );
}

/**
 * `DELETE /:workspace/storage` — removes a saved lane, or (legacy shape, no
 * `laneId`) detaches the active BYO lane and restores shared-bucket
 * defaults. Never touches the customer's bucket or its objects — only the
 * platform's own KV record.
 *
 * With `laneId`: removes exactly that lane from `storageLanes`. A standby
 * lane (never active — no `lastActiveAt`) is always removable, no emptiness
 * check: it's pure saved configuration. A fallback lane (`lastActiveAt`
 * set — it may hold objects) is checked for emptiness first (a cheap
 * `list({ limit: 1 })` against that lane's own store) and 409s
 * `workspace_storage_not_empty` unless `force` — the "my bucket is gone"
 * escape hatch, which knowingly orphans that lane's objects.
 *
 * Without `laneId` (legacy call shape): unchanged from before — blocked
 * unless the ledger reports zero objects or `force` is passed (mirrors the
 * `laneId` emptiness guard, against the D1 ledger instead of a live list —
 * cheaper, and this is the path that already has ledger totals). The #619
 * gate (detach must survive `byoBucketEnabled` revocation) is preserved
 * exactly. Unlike before two-lane storage, a non-empty active BYO config is
 * no longer discarded outright: it's kept as a fallback lane (`lastActiveAt`
 * stamped) so files uploaded during the BYO era keep resolving — unless
 * `force` is set, which drops it entirely as before. Shared-bucket fields
 * (bucket/binding/prefix/publicBaseUrl) come from `selfServeWorkspaceRecord`
 * so this can't drift from what a brand-new self-serve workspace actually
 * gets; everything else on the record (limits, github links, comment
 * settings, plan, other flags) is preserved untouched.
 */
export async function storageDeleteHandler(c: Context<SettingsVars>) {
  const name = c.req.param("workspace") ?? "";
  const userId = c.get("settingsUserId");
  const record = await loadWorkspaceRecord(c.env, name);
  if (!record) throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
  // Detach must stay available after the flag is revoked, otherwise the
  // workspace is stranded on the customer bucket (#619).
  if (!byoBucketAllowed(record) && !record.storageConfiguredAt) {
    throw new ForbiddenError("BYO storage is not enabled for this workspace", {
      code: "byo_bucket_disabled",
    });
  }
  if (!(await allowWrite(c.env, name))) {
    throw new RateLimitedError("rate limit exceeded");
  }

  const queryForce = c.req.query("force");
  const queryLaneId = c.req.query("laneId");
  const parsedBody = await c.req.json<{ force?: unknown; laneId?: unknown }>().catch(() => null);
  const force = queryForce === "true" || queryForce === "1" || parsedBody?.force === true;
  const laneId =
    queryLaneId || (typeof parsedBody?.laneId === "string" ? parsedBody.laneId : undefined);

  if (laneId) {
    const target = (record.storageLanes ?? []).find((lane) => lane.id === laneId);
    if (!target) {
      throw new NotFoundError("storage lane not found", { code: "storage_lane_not_found" });
    }
    if (target.lastActiveAt && !force) {
      // Resolves only the target lane's own config — never the active
      // lane's (unlike `storageConfigs`, which would also decrypt/validate
      // the active lane and turn an unrelated active-lane problem into a
      // 503 on this lane's removal). A lane that fails to resolve at all
      // (bad binding, undecryptable creds) is treated as empty: it's
      // already unreachable, so removal can't be blocked on data nobody can
      // read anyway — that data is exactly what `force` exists to release.
      const nonEmpty = await laneConfig(c.env, target as unknown as WorkspaceRecord)
        .then((config) => createStorage(config).list({ limit: 1 }))
        .then((page) => page.items.length > 0)
        .catch(() => false);
      if (nonEmpty) {
        throw new ConflictError(
          "this storage lane still has files — pass force to remove it anyway",
          { code: "workspace_storage_not_empty" },
        );
      }
    }
    const updated = await mutateWorkspaceRecord(
      c.env,
      name,
      (current) => ({
        ...current,
        storageLanes: (current.storageLanes ?? []).filter((lane) => lane.id !== laneId),
      }),
      { requireServing: true },
    );
    console.log(
      JSON.stringify({ event: "workspace_storage_lane_removed", workspace: name, userId, laneId }),
    );
    return c.json(
      await withActiveContentStatus(
        c.env,
        updated,
        storageStatusResponse(updated, byoBucketAllowed(updated)),
      ),
    );
  }

  const usage = await getWorkspaceUsage(dbFor(c.env), name);
  if (!force && usage.objects > 0) {
    throw new ConflictError(
      "this workspace still has files on its BYO bucket — pass force to detach anyway",
      { code: "workspace_storage_not_empty" },
    );
  }

  const nowIso = new Date().toISOString();
  const updated = await mutateWorkspaceRecord(
    c.env,
    name,
    (current) => {
      const shared = selfServeWorkspaceRecord({
        name,
        userId: current.createdByUserId ?? userId,
        now: new Date(),
      });
      // The ledger has objects (only reachable via `force`, since the guard
      // above already blocked a non-empty non-force detach): the outgoing
      // BYO config may hold objects that must keep resolving, so it's kept
      // as a fallback lane rather than discarded (spec: "Detach
      // symmetrically" / "Lane hygiene").
      const keepAsFallback = usage.objects > 0 && isByoRecord(current);
      const storageLanes = keepAsFallback
        ? upsertDemotedLane(current.storageLanes, demoteActiveLane(current, nowIso))
        : current.storageLanes;

      const next: WorkspaceRecord = { ...current, storageLanes };
      // The shared lane's fields come from `selfServeWorkspaceRecord` (never
      // hand-rolled, so this can't drift from what a brand-new self-serve
      // workspace actually gets) and go through the same `promoteLane` field
      // list every other lane promotion uses. No `id` — the restored shared
      // lane has none until a future activate demotes it again.
      promoteLane(
        next,
        {
          provider: shared.provider,
          bucket: shared.bucket,
          binding: shared.binding,
          prefix: shared.prefix,
          publicBaseUrl: shared.publicBaseUrl,
        },
        // A restored shared lane carries neither stamp: it was never verified
        // as a customer lane, and its host's active-content state comes from
        // the hosted-host records, not a per-workspace stamp.
        {},
      );
      return next;
    },
    { requireServing: true },
  );

  console.log(JSON.stringify({ event: "workspace_storage_detached", workspace: name, userId }));

  // `force` bypassed the emptiness guard, so the ledger still describes the
  // detached BYO bucket — but `maxStorageBytes` enforcement resumes on the
  // shared bucket the moment this record is restored, and stale counts
  // could leave the workspace permanently over-budget with nothing to
  // delete. Rebuild from the restored shared-bucket prefix (best-effort,
  // same rationale as the attach path above).
  if (force) {
    await reconcileOffPath(c, updated, name, "workspace storage detach");
  }

  return c.json(
    await withActiveContentStatus(
      c.env,
      updated,
      storageStatusResponse(updated, byoBucketAllowed(updated)),
    ),
  );
}

/**
 * True when `laneIdParam` names the record's *active* lane — either the
 * literal `"active"`, or the active lane's own id (`record.storageLaneId`,
 * absent on a record that predates lanes, in which case only the literal
 * matches).
 */
function isActiveLaneParam(record: WorkspaceRecord, laneIdParam: string): boolean {
  return (
    laneIdParam === "active" || (!!record.storageLaneId && laneIdParam === record.storageLaneId)
  );
}

/**
 * Resolves `laneIdParam` to a `StorageLane`-shaped view of the target lane —
 * the active lane's top-level fields (via `demoteActiveLane`, the same
 * field mapping `storageDeleteHandler`'s detach path uses to turn the active
 * fields into a lane shape) when it names the active lane, else a saved
 * entry in `storageLanes`. `null` when nothing matches.
 */
function resolveActiveContentLaneTarget(
  record: WorkspaceRecord,
  laneIdParam: string,
): StorageLane | null {
  if (isActiveLaneParam(record, laneIdParam)) {
    return demoteActiveLane(record, new Date().toISOString());
  }
  return (record.storageLanes ?? []).find((lane) => lane.id === laneIdParam) ?? null;
}

/**
 * Minimum gap between two on-demand active-content checks of the same lane
 * (issue #929 adversarial review L-3). A "Check now" button that a person
 * actually presses never comes close; a script driving Worker-origin fetches
 * at an arbitrary host does.
 */
export const ACTIVE_CONTENT_CHECK_COOLDOWN_MS = 60_000;

/**
 * The `storageActiveContentCheckedAt` key for the lane `laneIdParam` names.
 * The active lane is keyed by its own id when it has one, so naming it
 * `active` and naming it by id share a cooldown rather than each getting
 * their own.
 */
function activeContentCooldownKey(record: WorkspaceRecord, laneIdParam: string): string {
  return isActiveLaneParam(record, laneIdParam) ? (record.storageLaneId ?? "active") : laneIdParam;
}

/**
 * The cooldown map with `key` stamped at `nowIso`, pruned to lanes that
 * still exist (plus `active`) so a deleted lane's entry doesn't linger in the
 * record forever.
 */
function nextActiveContentCheckedAt(
  record: WorkspaceRecord,
  key: string,
  nowIso: string,
): Record<string, string> {
  const live = new Set<string>(["active", key]);
  if (record.storageLaneId) live.add(record.storageLaneId);
  for (const lane of record.storageLanes ?? []) live.add(lane.id);
  return Object.fromEntries([
    ...Object.entries(record.storageActiveContentCheckedAt ?? {}).filter(([k]) => live.has(k)),
    [key, nowIso],
  ]);
}

/**
 * `POST /:workspace/storage/lanes/:laneId/verify-active-content` (issue
 * #929) — runs only the SVG/XML sandboxing-CSP probe against one lane
 * (`laneActiveContentCheck`: upload the inert SVG probe through the lane's
 * own storage client, ask `checkActiveContentHeaders`, delete the probe),
 * then stamps the result. This is a rule for *this on-demand route only* —
 * `storagePutHandler`/`storageActivateHandler` run the same probe as part of
 * a save and handle inconclusive differently (see the comment at each):
 *
 *  - probe passed → `activeContentVerifiedAt`/`storageActiveContentVerifiedAt` set to now.
 *  - probe failed (not inconclusive) → the stamp is cleared, even if it was
 *    previously fresh — a lane that used to pass and now doesn't must stop
 *    admitting SVG/XML immediately, not wait out `LANE_STAMP_MAX_AGE_MS`.
 *  - probe inconclusive (the fetch itself threw — same "unknown, not
 *    broken" semantics as the public-url check) → *this route* leaves the
 *    stamp exactly as it was; `mutateWorkspaceRecord` isn't even called. An
 *    on-demand recheck of an already-configured lane shouldn't punish a
 *    transient network blip by revoking something that was working.
 *
 * `laneId` is either a saved lane's id (`storageLanes[].id`) or the active
 * lane, named either by the literal `active` or by its own id
 * (`record.storageLaneId`). A shared (platform-owned, binding-mode) lane
 * 422s outright — its state comes from the hosted host's daily-probed KV
 * record (`./active-content-hosts.ts`), never a per-workspace stamp — and so
 * does a lane with no `publicBaseUrl` to probe at all.
 *
 * Per-lane cooldown (issue #929 adversarial review L-3): every call makes
 * this Worker fetch a URL the workspace's own admin chose, and the general
 * write budget (60/60s per workspace) is far too generous for a button. A
 * second check on the same lane inside {@link ACTIVE_CONTENT_CHECK_COOLDOWN_MS}
 * is a 429 (`active_content_check_cooldown`) raised *before* any probe — and
 * before the write limiter, so a rejected recheck doesn't spend the
 * workspace's write budget either. The clock (`storageActiveContentCheckedAt`)
 * records attempts, not passes, so a failing or inconclusive probe rate-limits
 * the next one exactly as a passing one does.
 */
export async function storageVerifyActiveContentHandler(c: Context<SettingsVars>) {
  const name = c.req.param("workspace") ?? "";
  const laneIdParam = c.req.param("laneId") ?? "";
  const record = await loadWorkspaceRecord(c.env, name);
  if (!record) throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
  if (!byoBucketAllowed(record)) {
    throw new ForbiddenError("BYO storage is not enabled for this workspace", {
      code: "byo_bucket_disabled",
    });
  }

  const target = resolveActiveContentLaneTarget(record, laneIdParam);
  if (!target) {
    throw new NotFoundError("storage lane not found", { code: "storage_lane_not_found" });
  }

  /** A 422 shaped like the check this route would have returned, so one client branch renders both. */
  const reject422 = (hint: string) =>
    c.json({ check: { id: "active-content-headers", ok: false, required: false, hint } }, 422);

  if (isSharedLane(target)) {
    return reject422(
      "hosted lanes are verified by the platform, not per workspace — see the hosted host's status instead",
    );
  }
  if (!target.publicBaseUrl) {
    return reject422("this lane has no public base URL to verify — add one first");
  }

  const cooldownKey = activeContentCooldownKey(record, laneIdParam);
  const lastCheckedAt = Date.parse(record.storageActiveContentCheckedAt?.[cooldownKey] ?? "");
  if (
    Number.isFinite(lastCheckedAt) &&
    Date.now() - lastCheckedAt < ACTIVE_CONTENT_CHECK_COOLDOWN_MS
  ) {
    throw new RateLimitedError("this lane was checked moments ago — try again shortly", {
      code: "active_content_check_cooldown",
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((ACTIVE_CONTENT_CHECK_COOLDOWN_MS - (Date.now() - lastCheckedAt)) / 1000),
      ),
    });
  }
  if (!(await allowWrite(c.env, name))) {
    throw new RateLimitedError("rate limit exceeded");
  }

  const check = await laneActiveContentCheck(c.env, target);
  const nowIso = new Date().toISOString();

  // One write, always — the cooldown clock has to advance even for an
  // inconclusive probe (an unreachable host is exactly the case that could
  // otherwise be retried in a tight loop). The verification *stamp* is a
  // separate question: inconclusive leaves it exactly as it was.
  const updated = await mutateWorkspaceRecord(
    c.env,
    name,
    (current) => {
      const next: WorkspaceRecord = {
        ...current,
        storageActiveContentCheckedAt: nextActiveContentCheckedAt(current, cooldownKey, nowIso),
      };
      if (isActiveLaneParam(current, laneIdParam)) {
        if (!check.inconclusive) {
          if (check.ok) next.storageActiveContentVerifiedAt = nowIso;
          else delete next.storageActiveContentVerifiedAt;
        }
        return next;
      }
      const freshTarget = (current.storageLanes ?? []).find((lane) => lane.id === laneIdParam);
      if (!freshTarget) {
        throw new ConflictError("storage lane no longer exists", {
          code: "storage_lane_not_found",
        });
      }
      if (check.inconclusive) return next;
      next.storageLanes = (current.storageLanes ?? []).map((lane) => {
        if (lane.id !== laneIdParam) return lane;
        const nextLane: StorageLane = { ...lane };
        if (check.ok) nextLane.activeContentVerifiedAt = nowIso;
        else delete nextLane.activeContentVerifiedAt;
        return nextLane;
      });
      return next;
    },
    { requireServing: true },
  );

  console.log(
    JSON.stringify({
      event: "workspace_storage_active_content_checked",
      workspace: name,
      laneId: laneIdParam,
      ok: check.ok,
      inconclusive: check.inconclusive === true,
    }),
  );

  const status = await withActiveContentStatus(
    c.env,
    updated,
    storageStatusResponse(updated, byoBucketAllowed(updated)),
  );
  return c.json({ check, status });
}

/** `GET /:workspace/summary` — member-gated: membership + usage + public URL, one payload. */
export async function summaryHandler(c: Context<SettingsVars>) {
  const name = c.req.param("workspace") ?? "";
  const ws = c.get("settingsWorkspace");

  const record = await loadWorkspaceRecord(c.env, name);
  if (!record) {
    throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
  }

  const publicBaseUrl = record.publicBaseUrl;
  let usage: ReturnType<typeof usageWithLimits> | null = null;
  try {
    usage = usageWithLimits(await getWorkspaceUsage(dbFor(c.env), name), record);
  } catch {
    usage = null;
  }

  return c.json({
    workspace: ws.workspace,
    organization: ws.organization,
    role: ws.role,
    hasPublicUrl: Boolean(publicBaseUrl),
    publicBaseUrl,
    usage,
  });
}

/**
 * `GET /:workspace/billing` — member-gated: plan metadata, resolved
 * effective limits, usage, and subscription state for the account billing
 * tab. `plan`/`available`/`planApplied`/`limits` reuse `workspace-plan.ts`'s
 * `planResponse` — the same attribution contract the admin plan surface
 * uses: a record with no `plan` field must never display free-plan default
 * caps it isn't actually enforcing, so `planApplied` is `false` and
 * `limits` mirrors enforcement (explicit-or-unlimited) rather than the plan
 * defaults.
 *
 * `planSource`/`subscription` are sourced from the auth D1 `subscription`
 * table over the AUTH service binding (`org-workspaces.ts`'s
 * `subscriptionForOrg`), the same internal-bridge pattern as every other org
 * lookup here. `subscriptionForOrg` never throws — an AUTH outage degrades
 * to `subscription: null` + `planSource: "none"`-or-"admin" (whichever
 * `planSourceFor` derives with a null subscription) rather than a 500.
 * `stripeCustomerId` is deliberately dropped here — it's an admin-ui-only
 * field (see `routes/admin-ui.ts`'s plan surface), never exposed to the
 * member-facing settings API. Preserving this redaction is a hard
 * requirement carried over unchanged from `routes/me.ts` (issue #613 phase
 * 3 brief).
 */
export async function billingHandler(c: Context<SettingsVars>) {
  const name = c.req.param("workspace") ?? "";
  const ws = c.get("settingsWorkspace");

  const record = await loadWorkspaceRecord(c.env, name);
  if (!record) {
    throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
  }

  const { plan, available, planApplied, limits } = planResponse(name, record);

  const [usage, authSubscription] = await Promise.all([
    getWorkspaceUsage(dbFor(c.env), name)
      .then((raw) => usageWithLimits(raw, record))
      .catch(() => null),
    subscriptionForOrg(c.env, ws.organization.slug),
  ]);

  const planSource = planSourceFor(record, authSubscription);
  const subscription = authSubscription
    ? {
        status: authSubscription.status,
        periodEnd: authSubscription.periodEnd,
        cancelAtPeriodEnd: authSubscription.cancelAtPeriodEnd,
      }
    : null;

  return c.json({
    workspace: ws.workspace,
    organization: ws.organization,
    plan,
    available,
    planApplied,
    limits,
    usage,
    planSource,
    subscription,
  });
}

/**
 * `GET /:workspace/comment-preview` — preview the production managed-comment
 * body against resolved comment settings (issue #307), moved verbatim from
 * `routes/me.ts` (issue #613 final phase). Admin/owner-gated like the
 * comment-settings/storage tier above: the response includes per-key source
 * attribution ("repo" | "workspace" | "auto"), which a plain member has no
 * reason to see. With no `repo` query param, resolution runs against
 * workspace defaults only (`repoConfig: null`) via the same
 * `resolveCommentOptions(null, ...)` entrypoint `resolveRepoCommentOptions`
 * wraps. With `repo`, it must already be linked to THIS workspace
 * (github-repo-links.ts) — otherwise 404, so a preview can't be used to
 * probe another workspace's repo binding or `.uploads.yml` contents.
 *
 * Renders from a page of the workspace's own `gh/`-prefixed attachments
 * (first page only, mirrors gatherAttachments's url/pageUrl mapping and its
 * `path`/`state` D1 metadata read, so captions and before/after pairing
 * preview the way the production comment renders). `listObjects` pages in
 * lexicographic key order, not upload recency, so this is a representative
 * sample rather than the "most recent" uploads. An empty workspace falls
 * back to `previewFixtureItems` so the preview is never blank.
 */
export async function commentPreviewHandler(c: Context<SettingsVars>) {
  const name = c.req.param("workspace") ?? "";
  const record = await loadWorkspaceRecord(c.env, name);
  if (!record) throw new NotFoundError("workspace not found", { code: "workspace_not_found" });

  const repo = c.req.query("repo");
  let resolved: ResolvedCommentOptions;
  let source: Record<keyof ResolvedCommentOptions, OptionSource>;
  let repoConfig: { found: boolean; path: string | null; warnings: string[] } | null = null;

  if (repo !== undefined) {
    if (!REPO_SHAPE_RE.test(repo)) {
      throw new ValidationError("repo must be in owner/name form", { code: "invalid_repo" });
    }
    const link = await findRepoLink(dbFor(c.env), repo);
    if (!link || link.workspaceName !== name) {
      throw new NotFoundError("repo not linked to this workspace", { code: "repo_not_linked" });
    }
    const resolvedRepo = await resolveRepoCommentOptions(c.env, record, repo);
    resolved = resolvedRepo.options;
    source = resolvedRepo.source;
    repoConfig = {
      found: resolvedRepo.fetch.found,
      path: resolvedRepo.fetch.path,
      warnings: resolvedRepo.fetch.warnings,
    };
  } else {
    const resolvedDefaults = resolveCommentOptions(null, workspaceCommentDefaults(record));
    resolved = resolvedDefaults.options;
    source = resolvedDefaults.source;
  }

  const { items: page } = await listObjects(c.env, record, { prefix: "gh/", limit: 8 });
  const linkToFilePage = resolved.linkToFilePage;
  let items: AttachmentItem[] = page.map((o) => ({
    key: o.key,
    url: o.url,
    embedUrl: o.embedUrl,
    pageUrl: linkToFilePage ? (o.pageUrl ?? null) : null,
    size: o.size,
    contentType: o.contentType,
  }));
  let sample: "workspace" | "fixtures" = "workspace";
  if (items.length === 0) {
    items = previewFixtureItems(c.env);
    sample = "fixtures";
  } else if (resolved.metaPath || resolved.metaState) {
    // Same narrow key set and skip condition as gatherAttachments — the
    // preview must caption and pair exactly like the production comment.
    const metaByKey = await getMetadataForKeys(
      dbFor(c.env),
      name,
      items.map((item) => item.key),
      { metaKeys: ["path", "state"] },
    );
    for (const item of items) {
      const meta = metaByKey.get(item.key);
      if (!meta) continue;
      const { path, state } = meta;
      if (path || state) {
        item.meta = { ...(path ? { path } : {}), ...(state ? { state } : {}) };
      }
    }
  }

  const body = attachmentsCommentBody(items, [], attachmentsMarker(name), {
    imageWidth: resolved.imageWidth,
    maxInlineImages: resolved.maxInlineImages,
    metaPath: resolved.metaPath,
    metaState: resolved.metaState,
    note: resolved.note,
  });

  return c.json({ resolved, source, repoConfig, body, sample });
}

export const workspaceSettings = new Hono<SettingsVars>()
  .get("/:workspace/summary", sessionMemberGate(), summaryHandler)
  .get("/:workspace/billing", sessionMemberGate(), billingHandler)
  .get("/:workspace/comment-settings", sessionAdminGate(), commentSettingsGetHandler)
  .patch("/:workspace/comment-settings", sessionAdminGate(), commentSettingsPatchHandler)
  .get("/:workspace/comment-preview", sessionAdminGate(), commentPreviewHandler)
  .get("/:workspace/storage", sessionAdminGate(), storageGetHandler)
  .post("/:workspace/storage/verify", sessionAdminGate(), storageVerifyHandler)
  .post("/:workspace/storage/buckets", sessionAdminGate(), storageBucketsHandler)
  .put("/:workspace/storage", sessionAdminGate(), storagePutHandler)
  .post("/:workspace/storage/activate", sessionAdminGate(), storageActivateHandler)
  .delete("/:workspace/storage", sessionAdminGate(), storageDeleteHandler)
  .post(
    "/:workspace/storage/lanes/:laneId/verify-active-content",
    sessionAdminGate(),
    storageVerifyActiveContentHandler,
  )
  .onError((err, c) => respondError(c, err));
