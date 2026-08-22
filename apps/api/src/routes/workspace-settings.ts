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
import { createStorage, type R2Jurisdiction } from "@uploads/storage";
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
import { storageConfig as laneConfig } from "../storage";
import { getWorkspaceUsage } from "../usage";
import {
  byoBucketAllowed,
  newLaneId,
  loadWorkspaceRecord,
  type StorageLane,
  type WorkspaceRecord,
} from "../workspace";
import { mutateWorkspaceRecord } from "../workspace-mutate";
import { planResponse, planSourceFor } from "../workspace-plan";
import {
  candidateFromBody,
  isByoRecord,
  isLaneVerifyStale,
  storageReconcile,
  storageStatusResponse,
  storageVerify,
  upsertDemotedLane,
  upsertStandbyLane,
  verifyLaneForActivate,
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
  return c.json(storageStatusResponse(record, byoBucketAllowed(record)));
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

/**
 * `PUT /:workspace/storage` — verifies a candidate BYO config and saves it
 * as a **standby lane** (spec: "Configure, then switch"). Never trusts a
 * client-side "verified" claim — re-runs the same pipeline server-side
 * against the request body, and only writes on a pass. On a fail, responds
 * with the verify result (422) so the UI can render the same checklist the
 * standalone verify route would have.
 *
 * Saving a config never changes routing — the top-level (active-lane) fields
 * are never touched here, so there is no `workspace_storage_not_empty` guard
 * on this path: attaching a config to a populated workspace is always safe
 * because nothing about where uploads land has changed yet. Switching lanes
 * is `POST .../storage/activate`'s job. Saving again for the same
 * bucket+accountId replaces that lane in place (`upsertStandbyLane`) rather
 * than appending a duplicate. `mutateWorkspaceRecord` (with
 * `requireServing`) both re-checks the workspace hasn't been soft-deleted
 * since the request started and gives us the read-immediately-before-write
 * window issue #387 exists for; sealing happens *inside* that callback
 * (precedent: `reencrypt-registry.ts`), never on data read earlier in the
 * request.
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
  const updated = await mutateWorkspaceRecord(
    c.env,
    name,
    async (current) => {
      const sealed = await sealCredentialFieldsStrict(c.env.WORKSPACE_SECRETS_KEY, {
        accessKeyId: candidate.accessKeyId,
        secretAccessKey: candidate.secretAccessKey,
      });
      const lane: StorageLane = {
        id: newLaneId(),
        provider: "r2",
        bucket: candidate.bucket,
        accountId: candidate.accountId,
        accessKeyId: sealed.accessKeyId,
        secretAccessKey: sealed.secretAccessKey,
        publicBaseUrl: candidate.publicBaseUrl,
        // Cast is safe: `storageVerify` above already ran the shape check
        // (storage-verify.ts) that 422s on anything outside R2_JURISDICTIONS.
        jurisdiction: candidate.jurisdiction as R2Jurisdiction | undefined,
        verifiedAt: nowIso,
        storageConfiguredAt: nowIso,
        storageConfiguredBy: userId,
        // Display fragment for the settings UI, captured from the plaintext
        // before sealing — `lane.accessKeyId` is ciphertext from here on.
        storageAccessKeyIdLast4: candidate.accessKeyId.slice(-4),
      };
      return { ...current, storageLanes: upsertStandbyLane(current.storageLanes, lane) };
    },
    { requireServing: true },
  );

  console.log(JSON.stringify({ event: "workspace_storage_saved", workspace: name, userId }));

  return c.json({ ...storageStatusResponse(updated, true), verify: result });
}

/**
 * Builds the `StorageLane` object for demoting the record's *current*
 * top-level (active-lane) fields, shared by `storageActivateHandler` — the
 * outgoing active config becomes a fallback lane the moment a new one takes
 * over, so pre-switch objects keep resolving (spec: "Configure, then
 * switch"). Reuses the record's own `storageLaneId` as the demoted lane's id
 * when one exists (a record that has switched before); mints a fresh one for
 * a record on its first-ever switch (the implicit original/shared lane never
 * had an id).
 */
function demoteActiveLane(current: WorkspaceRecord, nowIso: string): StorageLane {
  return {
    id: current.storageLaneId ?? newLaneId(),
    provider: "r2",
    bucket: current.bucket,
    binding: current.binding,
    prefix: current.prefix,
    publicBaseUrl: current.publicBaseUrl,
    accountId: current.accountId,
    accessKeyId: current.accessKeyId,
    secretAccessKey: current.secretAccessKey,
    jurisdiction: current.jurisdiction,
    lastActiveAt: nowIso,
    verifiedAt: current.storageVerifiedAt,
    storageConfiguredAt: current.storageConfiguredAt,
    storageConfiguredBy: current.storageConfiguredBy,
    storageAccessKeyIdLast4: current.storageAccessKeyIdLast4,
  };
}

/**
 * Promotes `lane`'s fields onto `next`'s top level (the active-lane fields) —
 * shared by `storageActivateHandler`'s target promotion. Deletes fields the
 * incoming lane doesn't carry so a switch between a binding-mode and an
 * HTTP-credential-mode lane never leaves the other mode's stale fields
 * behind (e.g. switching shared → BYO must drop `binding`/`prefix`;
 * BYO → shared must drop the credential fields).
 */
function promoteLane(next: WorkspaceRecord, lane: StorageLane, verifiedAt: string | undefined) {
  next.provider = "r2";
  next.bucket = lane.bucket;
  if (lane.binding) next.binding = lane.binding;
  else delete next.binding;
  if (lane.prefix) next.prefix = lane.prefix;
  else delete next.prefix;
  if (lane.publicBaseUrl) next.publicBaseUrl = lane.publicBaseUrl;
  else delete next.publicBaseUrl;
  if (lane.accountId) next.accountId = lane.accountId;
  else delete next.accountId;
  if (lane.accessKeyId) next.accessKeyId = lane.accessKeyId;
  else delete next.accessKeyId;
  if (lane.secretAccessKey) next.secretAccessKey = lane.secretAccessKey;
  else delete next.secretAccessKey;
  if (lane.jurisdiction) next.jurisdiction = lane.jurisdiction;
  else delete next.jurisdiction;
  next.storageLaneId = lane.id;
  if (lane.storageConfiguredAt) next.storageConfiguredAt = lane.storageConfiguredAt;
  else delete next.storageConfiguredAt;
  if (lane.storageConfiguredBy) next.storageConfiguredBy = lane.storageConfiguredBy;
  else delete next.storageConfiguredBy;
  if (lane.storageAccessKeyIdLast4) next.storageAccessKeyIdLast4 = lane.storageAccessKeyIdLast4;
  else delete next.storageAccessKeyIdLast4;
  if (verifiedAt) next.storageVerifiedAt = verifiedAt;
  else delete next.storageVerifiedAt;
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

  const targetIsBindingMode = Boolean(target.binding);
  if (!targetIsBindingMode && !byoBucketAllowed(record)) {
    throw new ForbiddenError("BYO storage is not enabled for this workspace", {
      code: "byo_bucket_disabled",
    });
  }
  if (!(await allowWrite(c.env, name))) {
    throw new RateLimitedError("rate limit exceeded");
  }

  const nowIso = new Date().toISOString();
  let verifiedAt = target.verifiedAt;
  if (!targetIsBindingMode && isLaneVerifyStale(target.verifiedAt)) {
    const result = await verifyLaneForActivate(c.env, target);
    if (!result.ok) {
      return c.json(result, 422);
    }
    verifiedAt = nowIso;
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
      promoteLane(next, freshTarget, verifiedAt);
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
  // walked — rebuild totals/shared-subset now so `maxStorageBytes`
  // enforcement and the settings UI are honest immediately. Best-effort,
  // same rationale as the legacy attach/detach reconcile calls.
  await storageReconcile(c.env, updated, name).catch((err) =>
    console.error("workspace storage activate: usage reconcile failed for", name, err),
  );

  return c.json(storageStatusResponse(updated, byoBucketAllowed(updated)));
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
    return c.json(storageStatusResponse(updated, byoBucketAllowed(updated)));
  }

  const usage = await getWorkspaceUsage(c.env.DB, name);
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
      next.bucket = shared.bucket;
      next.binding = shared.binding;
      next.prefix = shared.prefix;
      if (shared.publicBaseUrl) next.publicBaseUrl = shared.publicBaseUrl;
      else delete next.publicBaseUrl;
      delete next.accountId;
      delete next.accessKeyId;
      delete next.secretAccessKey;
      delete next.jurisdiction;
      delete next.storageConfiguredAt;
      delete next.storageVerifiedAt;
      delete next.storageConfiguredBy;
      delete next.storageAccessKeyIdLast4;
      // The restored shared lane has no id until a future activate demotes
      // it again — clear it regardless of whether the outgoing BYO config
      // was kept as a fallback lane.
      delete next.storageLaneId;
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
    await storageReconcile(c.env, updated, name).catch((err) =>
      console.error("workspace storage detach: usage reconcile failed for", name, err),
    );
  }

  return c.json(storageStatusResponse(updated, byoBucketAllowed(updated)));
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
    usage = usageWithLimits(await getWorkspaceUsage(c.env.DB, name), record);
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
    getWorkspaceUsage(c.env.DB, name)
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
    const link = await findRepoLink(c.env.DB, repo);
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
  }));
  let sample: "workspace" | "fixtures" = "workspace";
  if (items.length === 0) {
    items = previewFixtureItems(c.env);
    sample = "fixtures";
  } else if (resolved.metaPath || resolved.metaState) {
    // Same narrow key set and skip condition as gatherAttachments — the
    // preview must caption and pair exactly like the production comment.
    const metaByKey = await getMetadataForKeys(
      c.env.DB,
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
  .put("/:workspace/storage", sessionAdminGate(), storagePutHandler)
  .post("/:workspace/storage/activate", sessionAdminGate(), storageActivateHandler)
  .delete("/:workspace/storage", sessionAdminGate(), storageDeleteHandler)
  .onError((err, c) => respondError(c, err));
