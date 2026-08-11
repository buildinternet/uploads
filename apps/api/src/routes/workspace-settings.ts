/**
 * Canonical comment-settings, storage, and billing/summary verticals (issue
 * #613 phase 3): `/:workspace/comment-settings`, `/:workspace/storage`,
 * `/:workspace/storage/verify`, `/:workspace/summary`, `/:workspace/billing`,
 * mounted at `/v1/workspaces` in `index.ts` so its public paths are
 * `/v1/workspaces/:workspace/...`. Same self-contained-router shape as
 * `workspace-members.ts`/`workspace-github.ts`: own auth, own `.onError()`,
 * `.fetch()`-able directly by an alias with no parent-mount dependency for
 * its `:workspace` param.
 *
 * Posture (`.context/613-api-consolidation-plan.md`, "comment-settings",
 * "storage", "billing/summary"):
 *
 *  - `GET/PATCH /comment-settings`, `GET/POST-verify/PUT/DELETE /storage` —
 *    **session-only, admin/owner tier**. A bearer `Authorization` header
 *    403s `settings_requires_session` on every route in this tier — neither
 *    vertical has a bearer analog today (comment-settings: no
 *    `/v1/:workspace/github/comment-settings` exists; storage is
 *    credential-adjacent and a token was never in scope for it), and this PR
 *    mints no new bearer capability for either. Flat 5-key comment-settings
 *    envelope (`imageWidth`/`maxInlineImages`/`showMetadata`/
 *    `linkToFilePage`/`note`) preserved EXACTLY — the admin-ui operator
 *    surface's prefixed 6-key naming (`/admin-ui/workspaces/:name/settings`)
 *    is a different privilege tier entirely and stays untouched. Storage's
 *    masked `storageStatusResponse` projection (never credential values) is
 *    likewise preserved exactly — see `workspace-storage.ts`.
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
import { NOTE_MAX_CHARS } from "@uploads/comment-config";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RateLimitedError,
  ValidationError,
} from "@uploads/errors";
import { type R2Jurisdiction } from "@uploads/storage";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { usageWithLimits } from "../budget";
import { resolveSessionUserId } from "../dual-workspace-auth";
import { respondError } from "../error-response";
import { allowWrite } from "../guards";
import {
  adminWorkspaceOr403,
  memberWorkspaceOr404,
  subscriptionForOrg,
  type MyWorkspace,
} from "../org-workspaces";
import { sealCredentialFieldsStrict } from "../secrets";
import { selfServeWorkspaceRecord } from "../self-serve-defaults";
import type { SessionVars } from "../session-auth";
import { getWorkspaceUsage } from "../usage";
import { byoBucketAllowed, loadWorkspaceRecord, type WorkspaceRecord } from "../workspace";
import { mutateWorkspaceRecord } from "../workspace-mutate";
import { planResponse, planSourceFor } from "../workspace-plan";
import {
  candidateFromBody,
  storageReconcile,
  storageStatusResponse,
  storageVerify,
} from "./workspace-storage";

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
    if (c.req.header("Authorization")?.startsWith("Bearer ")) {
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
    if (c.req.header("Authorization")?.startsWith("Bearer ")) {
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
 * `PUT /:workspace/storage` — persists a verified BYO config. Never trusts a
 * client-side "verified" claim — re-runs the same pipeline server-side
 * against the request body, and only writes on a pass. On a fail, responds
 * with the verify result (422) so the UI can render the same checklist the
 * standalone verify route would have. `mutateWorkspaceRecord` (with
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

  // No migration of populated workspaces in v1 (plan's global constraints):
  // attaching a BYO bucket to a workspace that already holds files would
  // orphan them on the shared bucket. Checked against the D1 usage ledger
  // *before* the mutation — a KV-only read inside the callback can't see
  // this — accepting the narrow race where a concurrent upload lands
  // between this check and the write (the callback's `requireServing`
  // re-check guards the record itself, not usage).
  const usage = await getWorkspaceUsage(c.env.DB, name);
  if (usage.objects > 0 && candidate.adoptExistingContents !== true) {
    throw new ConflictError(
      "this workspace already has files — BYO storage can only be attached to an empty workspace",
      { code: "workspace_storage_not_empty" },
    );
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
      const next: WorkspaceRecord = { ...current };
      delete next.prefix;
      delete next.binding;
      next.bucket = candidate.bucket;
      next.accountId = candidate.accountId;
      next.accessKeyId = sealed.accessKeyId;
      next.secretAccessKey = sealed.secretAccessKey;
      if (candidate.publicBaseUrl) next.publicBaseUrl = candidate.publicBaseUrl;
      else delete next.publicBaseUrl;
      // Cast is safe: `storageVerify` above already ran the shape check
      // (storage-verify.ts) that 422s on anything outside R2_JURISDICTIONS.
      if (candidate.jurisdiction) next.jurisdiction = candidate.jurisdiction as R2Jurisdiction;
      else delete next.jurisdiction;
      next.storageConfiguredAt = nowIso;
      next.storageVerifiedAt = nowIso;
      next.storageConfiguredBy = userId;
      // Display fragment for the settings UI, captured from the plaintext
      // before sealing — `next.accessKeyId` is ciphertext from here on.
      next.storageAccessKeyIdLast4 = candidate.accessKeyId.slice(-4);
      return next;
    },
    { requireServing: true },
  );

  console.log(JSON.stringify({ event: "workspace_storage_configured", workspace: name, userId }));

  // `adoptExistingContents` bypassed the emptiness guard, so the D1 usage
  // ledger still describes the old backing storage while the adopted
  // bucket's contents are what this workspace now serves. Rebuild the
  // ledger from the new bucket so it's honest immediately (it's dormant for
  // `maxStorageBytes` while BYO is active — `storageBudgetApplies` — but
  // powers the settings UI and becomes authoritative again on detach).
  // Best-effort: the config write above already succeeded, and reconcile
  // can be re-run any time.
  if (candidate.adoptExistingContents === true) {
    await storageReconcile(c.env, updated, name).catch((err) =>
      console.error("workspace storage attach: usage reconcile failed for", name, err),
    );
  }

  return c.json({ ...storageStatusResponse(updated, true), verify: result });
}

/**
 * `DELETE /:workspace/storage` — detach BYO storage and restore
 * shared-bucket defaults. Never touches the customer's bucket or its
 * objects — only the platform's own KV record. Blocked unless the
 * workspace's usage ledger reports zero objects, or the caller explicitly
 * passes `force` (query `?force=true` or a JSON body `{ "force": true }`) —
 * mirrors the empty-workspace guard on PUT above, in the opposite
 * direction. Shared-bucket fields (bucket/binding/prefix/publicBaseUrl)
 * come from `selfServeWorkspaceRecord` so this can't drift from what a
 * brand-new self-serve workspace actually gets; everything else on the
 * record (limits, github links, comment settings, plan, other flags) is
 * preserved untouched.
 */
export async function storageDeleteHandler(c: Context<SettingsVars>) {
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

  const queryForce = c.req.query("force");
  const bodyForce = await c.req
    .json<{ force?: unknown }>()
    .then((b) => b?.force === true)
    .catch(() => false);
  const force = queryForce === "true" || queryForce === "1" || bodyForce;

  if (!force) {
    const usage = await getWorkspaceUsage(c.env.DB, name);
    if (usage.objects > 0) {
      throw new ConflictError(
        "this workspace still has files on its BYO bucket — pass force to detach anyway",
        { code: "workspace_storage_not_empty" },
      );
    }
  }

  const updated = await mutateWorkspaceRecord(
    c.env,
    name,
    (current) => {
      const shared = selfServeWorkspaceRecord({
        name,
        userId: current.createdByUserId ?? userId,
        now: new Date(),
      });
      const next: WorkspaceRecord = { ...current };
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

export const workspaceSettings = new Hono<SettingsVars>()
  .get("/:workspace/summary", sessionMemberGate(), summaryHandler)
  .get("/:workspace/billing", sessionMemberGate(), billingHandler)
  .get("/:workspace/comment-settings", sessionAdminGate(), commentSettingsGetHandler)
  .patch("/:workspace/comment-settings", sessionAdminGate(), commentSettingsPatchHandler)
  .get("/:workspace/storage", sessionAdminGate(), storageGetHandler)
  .post("/:workspace/storage/verify", sessionAdminGate(), storageVerifyHandler)
  .put("/:workspace/storage", sessionAdminGate(), storagePutHandler)
  .delete("/:workspace/storage", sessionAdminGate(), storageDeleteHandler)
  .onError((err, c) => respondError(c, err));
