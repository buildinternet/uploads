/**
 * Workspace settings routes under `/v1/workspaces/:workspace`: comment,
 * poster and classifier settings, comment preview, storage, summary, and
 * billing. A self-contained router with its own auth and `.onError()`.
 *
 * All routes are session-only; a bearer header 403s. Settings, preview and
 * storage need admin/owner (`settings_requires_session`); summary and
 * billing need membership (`billing_requires_session`). None has a bearer
 * analog, so this uses local gates rather than `dualWorkspaceAuth` (which
 * grants file scopes) or `dualGovernanceAuth` (which accepts tokens).
 */
import {
  NOTE_MAX_CHARS,
  UI_PATH_MAX_CHARS,
  UI_PATHS_MAX,
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
import { classificationAllowed } from "../classifier";
import { dbFor } from "../db-session";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { usageWithLimits } from "../budget";
import { previewFixtureItems } from "../comment-preview-fixtures";
import { hasPreresolvedSession, resolveSessionUserId } from "../dual-workspace-auth";
import { respondError } from "../error-response";
import { listObjects } from "../files-core";
import { addCommentMetadata, dropHiddenAttachments } from "../github-comment";
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
import { webOrigin } from "../web-url";
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
 * Usage reconcile after the response, so a lane switch isn't pushed past
 * the browser's timeout. Awaited when there's no execution context (tests).
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
 * Session-only member gate: a bearer header 403s, non-members get a uniform
 * 404.
 */
function sessionMemberGate(): MiddlewareHandler<SettingsVars> {
  return async (c, next) => {
    // Preset first: a forwarded `/me` request keeps its original headers, so
    // a bearer-session caller must not be re-rejected here.
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
 * Session-only admin/owner gate, with its own error code. Non-members 404,
 * non-admin members 403.
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

/** `imageWidth` bounds: "full" or an integer clamp width in px. */
const COMMENT_IMAGE_WIDTH_MIN = 160;
const COMMENT_IMAGE_WIDTH_MAX = 1000;
/** `maxInlineImages` bounds. */
const COMMENT_MAX_INLINE_IMAGES_MIN = 1;
const COMMENT_MAX_INLINE_IMAGES_MAX = 48;

/** The workspace-level comment-defaults fields. */
const COMMENT_SETTINGS_KEYS = [
  "imageWidth",
  "maxInlineImages",
  "showMetadata",
  "linkToFilePage",
  "note",
  "ingestGithubAttachments",
  "noUploadsComment",
  "uiPaths",
  "requireUploads",
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
  noUploadsComment: "githubNoUploadsComment",
  uiPaths: "githubUiPaths",
  requireUploads: "githubRequireUploads",
};

type CommentSettingsValue = string | number | boolean | string[];
type CommentSettingsPatch = Partial<Record<CommentSettingsKey, CommentSettingsValue | null>>;

/**
 * Validates a comment-defaults PATCH: imageWidth "full" or 160–1000,
 * maxInlineImages 1–48, note trimmed and non-empty up to `NOTE_MAX_CHARS`.
 * All-or-nothing; omitted keys are unchanged, `null` clears, unknown keys
 * are ignored.
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

  if ("noUploadsComment" in record) {
    const value = record.noUploadsComment;
    if (value !== null && typeof value !== "boolean") {
      throw new ValidationError("noUploadsComment must be a boolean or null", {
        code: "invalid_settings",
        details: { field: "noUploadsComment" },
      });
    }
    patch.noUploadsComment = value;
  }

  if ("requireUploads" in record) {
    const value = record.requireUploads;
    if (value !== null && typeof value !== "boolean") {
      throw new ValidationError("requireUploads must be a boolean or null", {
        code: "invalid_settings",
        details: { field: "requireUploads" },
      });
    }
    patch.requireUploads = value;
  }

  // uiPaths: a list of globs, trimmed; blank entries dropped. An empty list
  // clears the field, like `null`.
  if ("uiPaths" in record) {
    const value = record.uiPaths;
    const fail = () => {
      throw new ValidationError(
        `uiPaths must be a list of up to ${UI_PATHS_MAX} paths of at most ${UI_PATH_MAX_CHARS} characters, or null`,
        { code: "invalid_settings", details: { field: "uiPaths" } },
      );
    };
    if (value === null) {
      patch.uiPaths = null;
    } else if (Array.isArray(value) && value.every((p) => typeof p === "string")) {
      const paths = (value as string[]).map((p) => p.trim()).filter((p) => p.length > 0);
      if (paths.length > UI_PATHS_MAX || paths.some((p) => p.length > UI_PATH_MAX_CHARS)) fail();
      patch.uiPaths = paths.length > 0 ? paths : null;
    } else {
      fail();
    }
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

/** Wire type for `/:workspace/comment-settings`, imported by apps/web. Type-only. */
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
    noUploadsComment: record.githubNoUploadsComment ?? null,
    uiPaths: record.githubUiPaths ?? null,
    requireUploads: record.githubRequireUploads ?? null,
  };
}

/** `GET /:workspace/comment-settings` — admin/owner only. */
export async function commentSettingsGetHandler(c: Context<SettingsVars>) {
  const name = c.req.param("workspace") ?? "";
  const record = await loadWorkspaceRecord(c.env, name);
  if (!record) throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
  return c.json(commentSettingsResponse(record));
}

/** `PATCH /:workspace/comment-settings` — admin/owner only. See `validateCommentSettingsPatch`. */
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
 * A settings vertical of on/off workspace switches. Absent means on; only an
 * explicit `false` is off, matching the gates that read them. A PATCH is
 * partial and stores booleans as given. Saving never consults Flagship, so a
 * switch can be saved while its platform flag is off.
 */
function switchSettings<K extends SwitchKey>(
  keys: readonly K[],
  extra?: (env: Env, record: WorkspaceRecord, name: string) => Promise<Record<string, unknown>>,
) {
  const response = (record: WorkspaceRecord) =>
    Object.fromEntries(keys.map((key) => [key, record[key] !== false])) as Record<K, boolean>;

  function validate(body: unknown): Partial<Record<K, boolean>> {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new ValidationError("request body must be a JSON object", {
        code: "invalid_settings",
      });
    }
    const input = body as Record<string, unknown>;
    const patch: Partial<Record<K, boolean>> = {};
    for (const key of keys) {
      if (!(key in input)) continue;
      const value = input[key];
      if (typeof value !== "boolean") {
        throw new ValidationError(`${key} must be a boolean`, {
          code: "invalid_settings",
          details: { field: key },
        });
      }
      patch[key] = value;
    }
    return patch;
  }

  const respond = async (c: Context<SettingsVars>, record: WorkspaceRecord, name: string) =>
    c.json({ ...response(record), ...(extra ? await extra(c.env, record, name) : {}) });

  return {
    response,
    async get(c: Context<SettingsVars>) {
      const name = c.req.param("workspace") ?? "";
      const record = await loadWorkspaceRecord(c.env, name);
      if (!record) throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
      return respond(c, record, name);
    },
    async patch(c: Context<SettingsVars>) {
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
      const patch = validate(body);
      const record = await mutateWorkspaceRecord(
        c.env,
        name,
        (current) => {
          const next = { ...current };
          for (const key of keys) {
            const value = patch[key];
            if (value !== undefined) next[key] = value;
          }
          return next;
        },
        { requireServing: true },
      );
      return respond(c, record, name);
    },
  };
}

type SwitchKey =
  | "pdfPosterEnabled"
  | "videoPosterEnabled"
  | "classifyUploads"
  | "holdFlaggedUploads";

/** `GET`/`PATCH /:workspace/poster-settings` — admin/owner only. */
const posterSettings = switchSettings(["pdfPosterEnabled", "videoPosterEnabled"] as const);
export const posterSettingsGetHandler = posterSettings.get;
export const posterSettingsPatchHandler = posterSettings.patch;

/** Wire type for `/:workspace/poster-settings`. Type-only. */
export type PosterSettingsResponse = ReturnType<typeof posterSettings.response>;

/**
 * `GET`/`PATCH /:workspace/classifier-settings` — admin/owner only.
 * `classifyUploads` and `holdFlaggedUploads` (`upload-hold.ts`); `available`
 * says whether the classifier runs for this workspace at all.
 */
const classifierSettings = switchSettings(
  ["classifyUploads", "holdFlaggedUploads"] as const,
  async (env, record, name) => ({
    available: await classificationAllowed(env, { ...record, classifyUploads: true }, name),
  }),
);
export const classifierSettingsGetHandler = classifierSettings.get;
export const classifierSettingsPatchHandler = classifierSettings.patch;

/** Wire type for `/:workspace/classifier-settings`. Type-only. */
export type ClassifierSettingsResponse = ReturnType<typeof classifierSettings.response> & {
  available: boolean;
};

/**
 * `GET /:workspace/storage` — admin/owner only, readable regardless of
 * `byoBucketEnabled` so the UI can decide whether to show the panel. Never
 * returns credential values.
 */
export async function storageGetHandler(c: Context<SettingsVars>) {
  const name = c.req.param("workspace") ?? "";
  const record = await loadWorkspaceRecord(c.env, name);
  if (!record) throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
  const status = storageStatusResponse(record, byoBucketAllowed(record));
  return c.json(await withActiveContentStatus(c.env, record, status));
}

/**
 * Replaces the projection's stamps with what SVG/XML acceptance actually
 * allows now. The active lane's row comes from `activeContentStatus`, the
 * gate itself, so the page can't say "Verified" about a lane the gate has
 * closed. Other lanes are judged on their own evidence: a shared lane by its
 * host's daily-probed record, a BYO lane by its stamp's freshness. Host
 * records are read once per distinct host.
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
 * `POST /:workspace/storage/verify` — runs the verify pipeline against the
 * request body without saving. 403s `byo_bucket_disabled` when the flag is
 * off. Write rate-limited: each call does real remote I/O.
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

/** Body for `POST /:workspace/storage/buckets`. Never persisted. */
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
 * `POST /:workspace/storage/buckets` — the wizard's bucket picker, via S3
 * `ListBuckets`. Always 200s; `access_denied` (bucket-scoped tokens) is the
 * common case and tells the wizard to fall back to a bucket-name field.
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
  // R2 only: `ListBuckets` is account-level with no generic S3 equivalent.
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
 * `PUT /:workspace/storage` — re-verifies a BYO config server-side and saves
 * it as a standby lane; a failure returns the verify result (422). Saving
 * never changes routing, so there's no not-empty guard; switching is
 * `POST .../storage/activate`. Saving the same bucket+accountId replaces
 * that lane in place.
 *
 * Exception: matching the active BYO lane is a credential rotation, so the
 * active fields update in place. A standby would leave the stale credentials
 * live.
 *
 * Sealing happens inside the `mutateWorkspaceRecord` callback, never on
 * data read earlier in the request.
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
  // Absent unless the active-content check passed. A save always decides
  // fresh, so inconclusive clears the stamp (unlike the on-demand verify
  // route, which leaves it).
  const activeContentVerifiedAt = activeContentStampFromVerify(result, nowIso);
  const updated = await mutateWorkspaceRecord(
    c.env,
    name,
    async (current) => {
      const sealed = await sealCredentialFieldsStrict(c.env.WORKSPACE_SECRETS_KEY, {
        accessKeyId: candidate.accessKeyId,
        secretAccessKey: candidate.secretAccessKey,
      });
      // Prefer an explicit jurisdiction (already shape-checked by verify),
      // else the one the verify probe found live.
      const jurisdiction =
        (candidate.jurisdiction as R2Jurisdiction | undefined) ?? result.jurisdiction;
      // From the plaintext, before sealing.
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
        // The rotation just passed verify, so clear any unhealthy flag now.
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
        // r2 and s3 credential fields are never both on one lane.
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
 * `POST /:workspace/storage/activate` — make a saved lane (`{ laneId }`) the
 * write lane. Requires `byoBucketAllowed` unless the target is the shared
 * lane, so switching back survives flag revocation.
 *
 * A BYO target whose `verifiedAt` is stale is re-verified with its decrypted
 * credentials first and 422s on failure. The swap is one
 * `mutateWorkspaceRecord`: demote the active fields to a lane, promote the
 * target. The demoted lane keeps serving pre-switch files.
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
  // Carried forward unless the re-verify below settles it fresh.
  let activeContentVerifiedAt = target.activeContentVerifiedAt;
  // A health-flagged lane is re-verified however fresh its stamp:
  // `promoteLane` clears the flag, so a broken lane would read healthy again.
  if (!isSharedLane(target) && (isLaneVerifyStale(target.verifiedAt) || target.unhealthyAt)) {
    const result = await verifyLaneForActivate(c.env, target);
    if (!result.ok) {
      return c.json(result, 422);
    }
    verifiedAt = nowIso;
    // A fresh determination, so inconclusive clears the stamp (as on save).
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

  // The promoted lane may hold objects the ledger never walked; rebuild.
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
 * `DELETE /:workspace/storage` — remove a saved lane, or with no `laneId`
 * detach the active BYO lane. Never touches the customer's bucket.
 *
 * With `laneId`: a standby lane is always removable. A former active lane may
 * hold objects, so it 409s `workspace_storage_not_empty` unless `force`,
 * which knowingly orphans them.
 *
 * Without `laneId`: blocked unless the ledger shows zero objects or `force`.
 * Detach works even after `byoBucketEnabled` is revoked. A non-empty BYO
 * config is kept as a fallback lane so its files keep resolving. Shared
 * fields come from `selfServeWorkspaceRecord`; the rest of the record is
 * untouched.
 */
export async function storageDeleteHandler(c: Context<SettingsVars>) {
  const name = c.req.param("workspace") ?? "";
  const userId = c.get("settingsUserId");
  const record = await loadWorkspaceRecord(c.env, name);
  if (!record) throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
  // Detach must survive flag revocation, or the workspace is stranded on the
  // customer bucket.
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
      // Resolve only the target lane, so an active-lane problem can't block
      // this removal. A lane that can't resolve is unreachable anyway, so it
      // counts as empty.
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
      // Objects in the ledger (only reachable via `force`): keep the outgoing
      // BYO config as a fallback lane so they keep resolving.
      const keepAsFallback = usage.objects > 0 && isByoRecord(current);
      const storageLanes = keepAsFallback
        ? upsertDemotedLane(current.storageLanes, demoteActiveLane(current, nowIso))
        : current.storageLanes;

      const next: WorkspaceRecord = { ...current, storageLanes };
      // Shared fields from `selfServeWorkspaceRecord` so they can't drift.
      // No `id` until a future activate demotes it.
      promoteLane(
        next,
        {
          provider: shared.provider,
          bucket: shared.bucket,
          binding: shared.binding,
          prefix: shared.prefix,
          publicBaseUrl: shared.publicBaseUrl,
        },
        // A shared lane's active-content state comes from host records.
        {},
      );
      return next;
    },
    { requireServing: true },
  );

  console.log(JSON.stringify({ event: "workspace_storage_detached", workspace: name, userId }));

  // `force` skipped the emptiness guard, so the ledger still describes the
  // BYO bucket. Rebuild from the shared prefix or the workspace could stay
  // over budget with nothing to delete.
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

/** True when `laneIdParam` is `"active"` or the active lane's own id. */
function isActiveLaneParam(record: WorkspaceRecord, laneIdParam: string): boolean {
  return (
    laneIdParam === "active" || (!!record.storageLaneId && laneIdParam === record.storageLaneId)
  );
}

/** The target lane as a `StorageLane`: the active fields or a saved entry. `null` when nothing matches. */
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
 * Minimum gap between on-demand active-content checks of one lane. A person
 * pressing "Check now" never hits it; a script driving Worker fetches at an
 * arbitrary host does.
 */
export const ACTIVE_CONTENT_CHECK_COOLDOWN_MS = 60_000;

/** Cooldown key for a lane. `active` and the active lane's id share one. */
function activeContentCooldownKey(record: WorkspaceRecord, laneIdParam: string): string {
  return isActiveLaneParam(record, laneIdParam) ? (record.storageLaneId ?? "active") : laneIdParam;
}

/** The cooldown map with `key` stamped, pruned to lanes that still exist. */
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
 * `POST /:workspace/storage/lanes/:laneId/verify-active-content` — runs only
 * the SVG/XML sandboxing-CSP probe against one lane, then stamps the result.
 * Pass sets the stamp; fail clears it immediately; inconclusive (the fetch
 * threw) leaves it as it was, so a network blip doesn't revoke a working
 * lane. Saves and activations handle inconclusive differently.
 *
 * `laneId` is a saved lane's id, `active`, or the active lane's id. A shared
 * lane (state comes from host records) or one with no `publicBaseUrl` 422s.
 *
 * Each call makes the Worker fetch an admin-chosen URL, so a second check
 * of the same lane within the cooldown 429s before any probe or write-limit
 * spend. The clock records attempts, not passes.
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

  // Always write: the cooldown clock advances even when inconclusive. The
  // stamp itself is left alone in that case.
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
 * `GET /:workspace/billing` — member-gated plan, effective limits, usage and
 * subscription. `planResponse` keeps the attribution contract: a record with
 * no `plan` never shows free-plan caps it doesn't enforce. The subscription
 * comes from the auth D1 over AUTH and degrades to null on an outage.
 * `stripeCustomerId` is admin-only and must never be returned here.
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
 * `GET /:workspace/comment-preview` — the managed-comment body rendered with
 * resolved settings. Admin/owner-gated because it exposes per-key source
 * attribution. With `repo`, the repo must be linked to this workspace (else
 * 404), so a preview can't probe another workspace's binding or config.
 *
 * Renders the first page of the workspace's own `gh/` attachments with the
 * same filters and metadata reads as the real comment. Key order isn't
 * recency, so it's a sample. An empty workspace uses `previewFixtureItems`.
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
  items = await dropHiddenAttachments(c.env, name, items);
  let sample: "workspace" | "fixtures" = "workspace";
  if (items.length === 0) {
    items = previewFixtureItems(c.env);
    sample = "fixtures";
  } else if (resolved.metaPath || resolved.metaState) {
    await addCommentMetadata(c.env, record, name, items);
  }

  const body = attachmentsCommentBody(
    items,
    [],
    attachmentsMarker(name),
    {
      imageWidth: resolved.imageWidth,
      maxInlineImages: resolved.maxInlineImages,
      metaPath: resolved.metaPath,
      metaState: resolved.metaState,
      note: resolved.note,
    },
    undefined,
    // No PR here, so the sample line links to the live-link docs.
    { liveLinkUrl: linkToFilePage ? `${webOrigin(c.env)}/docs/feeds` : null },
  );

  return c.json({ resolved, source, repoConfig, body, sample });
}

export const workspaceSettings = new Hono<SettingsVars>()
  .get("/:workspace/summary", sessionMemberGate(), summaryHandler)
  .get("/:workspace/billing", sessionMemberGate(), billingHandler)
  .get("/:workspace/comment-settings", sessionAdminGate(), commentSettingsGetHandler)
  .patch("/:workspace/comment-settings", sessionAdminGate(), commentSettingsPatchHandler)
  .get("/:workspace/poster-settings", sessionAdminGate(), posterSettingsGetHandler)
  .patch("/:workspace/poster-settings", sessionAdminGate(), posterSettingsPatchHandler)
  .get("/:workspace/classifier-settings", sessionAdminGate(), classifierSettingsGetHandler)
  .patch("/:workspace/classifier-settings", sessionAdminGate(), classifierSettingsPatchHandler)
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
