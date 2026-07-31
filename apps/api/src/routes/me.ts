/**
 * Session-authenticated, read-only usage surface for signed-in users (issue
 * #107 — follow-on to /admin-ui/*'s Phase 3 pattern). Gated by
 * `requireSessionUser` only — NOT `requireAdminUser` — so any signed-in user
 * can see their own workspace memberships and usage, not just admins.
 *
 * Authorization for `/workspaces/:name/usage` is the membership lookup
 * itself: a workspace not present in the caller's own memberships 404s
 * (`workspace_not_found`) rather than 403ing, so membership can't be probed
 * for workspace existence any more precisely than for any other workspace.
 */
import { resolveWorkspaceCreateQuota } from "@uploads/billing";
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
import { createFilesRouter, signedDownloadUrl } from "@uploads/storage";
import { Hono, type Context } from "hono";
import { usageWithLimits } from "../budget";
import { sealCredentialFieldsStrict } from "../secrets";
import { throwForInviteError } from "../invite-error";
import { parseExternalReference } from "../external-references";
import { previewFixtureItems } from "../comment-preview-fixtures";
import { getMetadataForKeys, listFacets } from "../file-metadata";
import {
  normalizeSearchName,
  parseMetaQueryFilters,
  searchFilesByNameAndMeta,
} from "../file-search";
import { badKey, deleteObject, listObjects, setObjectVisibility } from "../files-core";
import { listGalleries } from "../galleries";
import { galleryListSummaries } from "../gallery-service";
import {
  attachmentsCommentBody,
  attachmentsMarker,
  type AttachmentItem,
} from "../github-comment-render";
import { githubInstallStatus, type GithubInstallStatus } from "../github-install-status";
import { findRepoLink, listRepoLinksForWorkspace } from "../github-repo-links";
import { resolveRepoCommentOptions, workspaceCommentDefaults } from "../repo-comment-config";
import { resolveTitles } from "../github-titles";
import { allowWrite } from "../guards";
import {
  invitesForOrg,
  membersForOrg,
  membershipsForUser,
  removeMember,
  revokeInvite,
  subscriptionForOrg,
  updateMemberRole,
  workspacesFromMembership,
  type Membership,
  type OrgMember,
} from "../org-workspaces";
import { requireSessionUser, sessionAuth, type SessionVars } from "../session-auth";
import { selfServeWorkspaceRecord } from "../self-serve-defaults";
import { objectPublicUrls, publicUrl, storage, storageConfig } from "../storage";
import { getWorkspaceUsage } from "../usage";
import { sanitizeVisibility, VISIBILITY_VALUES } from "../visibility";
import { byoBucketAllowed, loadWorkspaceRecord, type WorkspaceRecord } from "../workspace";
import { mutateWorkspaceRecord } from "../workspace-mutate";
import { planResponse, planSourceFor } from "../workspace-plan";
import {
  candidateFromBody,
  storageReconcile,
  storageStatusResponse,
  storageVerify,
} from "./workspace-storage";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** `imageWidth` bounds (issue #307): "full" or an integer clamp width in px. */
const COMMENT_IMAGE_WIDTH_MIN = 160;
const COMMENT_IMAGE_WIDTH_MAX = 1000;
/** `maxInlineImages` bounds (issue #307). */
const COMMENT_MAX_INLINE_IMAGES_MIN = 1;
const COMMENT_MAX_INLINE_IMAGES_MAX = 48;

/** The five workspace-level comment-defaults fields (issue #307). */
const COMMENT_SETTINGS_KEYS = [
  "imageWidth",
  "maxInlineImages",
  "showMetadata",
  "linkToFilePage",
  "note",
] as const;
type CommentSettingsKey = (typeof COMMENT_SETTINGS_KEYS)[number];

/** Record field each API key writes to. */
const COMMENT_SETTINGS_RECORD_FIELD: Record<CommentSettingsKey, keyof WorkspaceRecord> = {
  imageWidth: "githubCommentImageWidth",
  maxInlineImages: "githubCommentMaxInlineImages",
  showMetadata: "githubCommentShowMetadata",
  linkToFilePage: "githubCommentLinkToFilePage",
  note: "githubCommentNote",
};

type CommentSettingsValue = string | number | boolean;
type CommentSettingsPatch = Partial<Record<CommentSettingsKey, CommentSettingsValue | null>>;

/**
 * Validates a PATCH body for the workspace-level managed-comment defaults
 * (issue #307). This is the single enforcement point for the bounds the
 * resolver itself does not clamp (a review finding on the Task 1 parser):
 * imageWidth "full" or an integer 160–1000, maxInlineImages an integer
 * 1–48, and note trimmed, non-empty, and at most `NOTE_MAX_CHARS`. Reject-
 * all-or-apply-all — the whole body is checked before any record mutation,
 * so an invalid field never partially applies. An omitted key means "leave
 * unchanged"; an explicit `null` clears the field. Unknown keys are
 * ignored, mirroring `validateGithubCommentSettingsPatch` (admin-ui.ts) and
 * `validateLimitsPatch` (workspace-limits.ts), the two sibling workspace-
 * record PATCH validators in this codebase.
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
  };
}

/** `?repo=` shape for the comment preview endpoint: exactly one `/`, no empty segments. */
const REPO_SHAPE_RE = /^[^/\s]+\/[^/\s]+$/;

interface MyWorkspace {
  workspace: string;
  organization: { id: string; slug: string; name: string };
  role: string;
}

function myWorkspaceFromMembership(membership: Membership, workspace: string): MyWorkspace {
  return {
    workspace,
    organization: {
      id: membership.organizationId,
      slug: membership.organizationSlug,
      name: membership.organizationName || membership.organizationSlug,
    },
    role: membership.role,
  };
}

function canManageRole(role: string): boolean {
  return role === "admin" || role === "owner";
}

/** Sanitize org members for the account people UI (opaque `id` only for managers). */
function projectMembers(members: OrgMember[], canManage: boolean) {
  return members.map((m) => {
    const row: {
      id?: string;
      email: string;
      name: string;
      role: string;
      createdAt?: string;
    } = {
      email: m.email ?? "",
      name: m.name ?? "",
      role: m.role ?? "member",
      createdAt: m.createdAt,
    };
    if (canManage) row.id = m.id;
    return row;
  });
}

/**
 * Every workspace the user's memberships map to. Memberships already include
 * org id/slug/name from AUTH, so this is one service call — not N org
 * lookups. Workspace names come from `workspacesFromMembership` (today 1:1).
 */
async function myWorkspaces(env: Env, userId: string): Promise<MyWorkspace[]> {
  const memberships = await membershipsForUser(env, userId);
  const out: MyWorkspace[] = [];
  for (const membership of memberships) {
    for (const workspace of workspacesFromMembership(membership)) {
      out.push(myWorkspaceFromMembership(membership, workspace));
    }
  }
  return out;
}

/**
 * Caller's membership for `name`, or a uniform 404 (not 403 — no existence
 * probe). Slug-scoped membership query (one AUTH join), not the full list.
 */
async function memberWorkspaceOr404(env: Env, userId: string, name: string): Promise<MyWorkspace> {
  // 1:1 today: workspace name === org slug. Multi-workspace orgs would expand
  // via workspacesFromMembership over the full list instead.
  const [membership] = await membershipsForUser(env, userId, { slug: name });
  if (!membership || !workspacesFromMembership(membership).includes(name)) {
    throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
  }
  return myWorkspaceFromMembership(membership, name);
}

function requireUserId(c: Context<SessionVars>): string {
  // requireSessionUser guarantees a session user; the guard is belt-and-braces
  // and keeps the 404 (not 401) shape uniform with the not-a-member case.
  const userId = c.get("sessionUser")?.id;
  if (!userId) throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
  return userId;
}

/**
 * Membership admin|owner for this workspace — 404 if not a member, 403 if
 * member but not privileged. Exported for reuse by the self-serve token
 * governance dual-auth guard (`workspaces.ts`, issue #262 Task 3).
 */
export async function adminWorkspaceOr403(
  env: Env,
  userId: string,
  name: string,
): Promise<MyWorkspace> {
  const ws = await memberWorkspaceOr404(env, userId, name);
  if (ws.role !== "admin" && ws.role !== "owner") {
    throw new ForbiddenError("workspace admin or owner role required", {
      code: "workspace_admin_required",
    });
  }
  return ws;
}

/**
 * True iff the user holds org role `owner` (not `admin`) for workspace
 * `name`, resolved via the same org<->workspace mapping as
 * `adminWorkspaceOr403`/`memberWorkspaceOr404` (issue #265 — extends the
 * #249 self-serve deletion gate from creator-only to creator OR org owner).
 * Non-throwing: a non-member or unknown workspace is simply `false`, not a
 * 404 — callers combine this with other ownership checks and want a uniform
 * "not authorized" outcome rather than a membership-probing 404.
 */
export async function isWorkspaceOwner(env: Env, userId: string, name: string): Promise<boolean> {
  try {
    const ws = await memberWorkspaceOr404(env, userId, name);
    return ws.role === "owner";
  } catch (err) {
    if (err instanceof NotFoundError) return false;
    throw err;
  }
}

export const me = new Hono<SessionVars>()
  .use("/*", sessionAuth, requireSessionUser)

  // Workspaces the caller belongs to, via their org memberships. `hasPublicUrl`
  // lets the account UI decide, per workspace, whether opening a file should
  // navigate to the public /f/ page (issue #135) or resolve through the
  // signed-URL-capable /file-url endpoint (issue #123) — see
  // apps/web's AccountFileBrowser. `plan` (issue #365 follow-up, purely
  // additive) is the same catalog-id string `planResponse` returns for the
  // billing tab — "free" whenever the record has no plan applied (getPlan's
  // fail-open-to-free contract), so a legacy/unapplied record can never read
  // as "pro" here either. Lets the nav/list surfaces show a small Pro badge
  // without a per-workspace billing round trip. Both fields are loaded here
  // (not in `myWorkspaces`, which every member-gated route calls for
  // authorization) so the extra KV read per workspace stays confined to this
  // one listing endpoint.
  .get("/workspaces", async (c) => {
    const userId = c.get("sessionUser")?.id;
    if (!userId) throw new NotFoundError("no session user", { code: "workspace_not_found" });
    const workspaces = await myWorkspaces(c.env, userId);
    const loaded = await Promise.all(
      workspaces.map(async (ws) => {
        const record = await loadWorkspaceRecord(c.env, ws.workspace);
        const publicBaseUrl = record?.publicBaseUrl;
        const plan = record ? planResponse(ws.workspace, record).plan : "free";
        // `hasPublicUrl` kept alongside the URL itself for existing consumers.
        return {
          record,
          entry: Object.assign({}, ws, {
            hasPublicUrl: Boolean(publicBaseUrl),
            publicBaseUrl,
            plan,
          }),
        };
      }),
    );
    // Creation quota (spec 2026-07-24) so the account UI can stop offering a
    // create affordance the API would refuse. Free rider on the records this
    // handler already loaded — no extra KV reads. Advisory only: `POST
    // /v1/workspaces` remains the enforcement point.
    const quota = resolveWorkspaceCreateQuota(
      loaded.filter(({ entry }) => entry.role === "owner").map(({ record }) => record),
    );
    return c.json({ workspaces: loaded.map(({ entry }) => entry), workspaceCreate: quota });
  })

  // Usage + limits for one workspace — 404s unless the caller is a member.
  .get("/workspaces/:name/usage", async (c) => {
    const name = c.req.param("name");
    await memberWorkspaceOr404(c.env, requireUserId(c), name);

    const record = await loadWorkspaceRecord(c.env, name);
    if (!record) {
      throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
    }

    const usage = await getWorkspaceUsage(c.env.DB, name);
    return c.json(usageWithLimits(usage, record));
  })

  // Workspace shell for the account rail: membership + public URL + usage.
  .get("/workspaces/:name/summary", async (c) => {
    const name = c.req.param("name");
    const ws = await memberWorkspaceOr404(c.env, requireUserId(c), name);

    const record = await loadWorkspaceRecord(c.env, name);
    if (!record) {
      throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
    }

    const publicBaseUrl = record.publicBaseUrl;
    let usage: ReturnType<typeof usageWithLimits> | null = null;
    if (record) {
      try {
        usage = usageWithLimits(await getWorkspaceUsage(c.env.DB, name), record);
      } catch {
        usage = null;
      }
    }

    return c.json({
      workspace: ws.workspace,
      organization: ws.organization,
      role: ws.role,
      hasPublicUrl: Boolean(publicBaseUrl),
      publicBaseUrl,
      usage,
    });
  })

  // Plan metadata, resolved effective limits, usage, and subscription state
  // for the account billing tab — 404s unless the caller is a member.
  // `plan`/`available`/`planApplied`/`limits` reuse workspace-plan.ts's
  // `planResponse` — the same attribution contract the admin plan surface
  // uses (Task 5's Critical fix): a record with no `plan` field must never
  // display free-plan default caps it isn't actually enforcing, so
  // `planApplied` is `false` and `limits` mirrors enforcement
  // (explicit-or-unlimited) rather than the plan defaults.
  //
  // `planSource`/`subscription` (issue #445, purely additive to the shape
  // above — a billing-tab lane builds its UI against this) are sourced from
  // the auth D1 `subscription` table over the AUTH service binding
  // (org-workspaces.ts's `subscriptionForOrg`), the same internal-bridge
  // pattern as every other org lookup here. `subscriptionForOrg` never
  // throws — an AUTH outage degrades to `subscription: null` +
  // `planSource: "none"`-or-"admin" (whichever `planSourceFor` derives with a
  // null subscription) rather than a 500. `stripeCustomerId` is deliberately
  // dropped here — it's an admin-ui-only field (see routes/admin-ui.ts's
  // plan surface), never exposed to the member-facing /me API.
  .get("/workspaces/:name/billing", async (c) => {
    const name = c.req.param("name");
    const ws = await memberWorkspaceOr404(c.env, requireUserId(c), name);

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
  })

  // People in one workspace — member-gated (teammate fields only, not admin raw rows).
  .get("/workspaces/:name/members", async (c) => {
    const name = c.req.param("name");
    const ws = await memberWorkspaceOr404(c.env, requireUserId(c), name);
    const canManage = canManageRole(ws.role);
    const members = await membersForOrg(c.env, ws.organization.slug);
    return c.json({
      members: projectMembers(members, canManage),
    });
  })

  // People tab: members + (for admins) pending invites + role in one authz pass.
  .get("/workspaces/:name/people", async (c) => {
    const name = c.req.param("name");
    const ws = await memberWorkspaceOr404(c.env, requireUserId(c), name);
    const canManage = canManageRole(ws.role);
    const [members, invites] = await Promise.all([
      membersForOrg(c.env, ws.organization.slug),
      canManage ? invitesForOrg(c.env, ws.organization.slug) : Promise.resolve([]),
    ]);

    return c.json({
      role: ws.role,
      canManage,
      organization: ws.organization,
      members: projectMembers(members, canManage),
      invites: canManage ? invites : [],
    });
  })

  // Galleries in one workspace — member-gated.
  .get("/workspaces/:name/galleries", async (c) => {
    const name = c.req.param("name");
    await memberWorkspaceOr404(c.env, requireUserId(c), name);
    const page = await listGalleries(c.env.DB, name, { limit: 50 });
    return c.json({
      galleries: await galleryListSummaries(c.env, name, page.galleries),
    });
  })

  // A page of a workspace's files (public URLs), folder-aware and hydrated
  // with D1 `gh.*` metadata — member-gated. Query
  // params mirror the token-scoped `GET /v1/:workspace/files` (files.ts):
  // `prefix`/`cursor` pass straight through, `limit` defaults to 100 (clamped
  // inside `listObjects`), and `delimiter` (new here) enables S3-style
  // "folder" navigation — `listObjects` surfaces the resulting common
  // prefixes as `prefixes` for the settings-page file browser.
  .get("/workspaces/:name/files", async (c) => {
    const name = c.req.param("name");
    await memberWorkspaceOr404(c.env, requireUserId(c), name);
    const record = await loadWorkspaceRecord(c.env, name);
    if (!record) {
      throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
    }

    const { prefix, delimiter, cursor } = c.req.query();
    const limit = Number(c.req.query("limit") ?? 100) || 100;
    const {
      items,
      cursor: nextCursor,
      prefixes,
    } = await listObjects(c.env, record, {
      prefix,
      delimiter,
      limit,
      cursor,
    });

    const metaByKey = await getMetadataForKeys(
      c.env.DB,
      name,
      items.map((item) => item.key),
    );
    const files = items.map((item) => ({ ...item, metadata: metaByKey.get(item.key) }));

    return c.json({ files, prefixes, cursor: nextCursor });
  })

  // Metadata search — the session-authed twin of the token route's
  // `GET /v1/:workspace/files?meta.*` / `?name=` (files.ts). Same AND-of-
  // equality semantics and shared helpers; scoped to one workspace, member-
  // gated. Results carry no `visibility` (it isn't in the D1 index — accepted
  // caveat). Always returns `truncated` (session contract differs from the
  // token meta-only envelope).
  .get("/workspaces/:name/files/search", async (c) => {
    const name = c.req.param("name");
    await memberWorkspaceOr404(c.env, requireUserId(c), name);

    const record = await loadWorkspaceRecord(c.env, name);
    if (!record) {
      throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
    }

    const query = c.req.query();
    const rawName = c.req.query("name");
    const nameTerm = rawName === undefined ? undefined : normalizeSearchName(rawName);
    const filters = parseMetaQueryFilters(query, (param) => c.req.queries(param));
    const hasMeta = Object.keys(filters).length > 0;

    if (!hasMeta && nameTerm === undefined) {
      throw new ValidationError("at least one meta.* filter or name is required", {
        code: "file_metadata_invalid_key",
      });
    }

    // Session search keeps a fixed page of 100 (same as before #528).
    const SEARCH_LIMIT = 100;
    const cfg = await storageConfig(c.env, record);
    const { matches, truncated } = await searchFilesByNameAndMeta(c.env, record, name, {
      filters: hasMeta ? filters : undefined,
      nameTerm,
      prefix: query.prefix,
      pageSize: SEARCH_LIMIT,
    });

    return c.json({
      items: matches.map((match) => {
        const urls = objectPublicUrls(c.env, cfg, match.key);
        return { key: match.key, url: urls.url, embedUrl: urls.embedUrl, metadata: match.metadata };
      }),
      truncated,
    });
  })

  // Facet discovery for the files-tab filter bar: which metadata keys this
  // workspace actually contains, and (with `?key=`) that key's values. The
  // filter bar cannot otherwise tell a user what is filterable — keys are
  // user- and agent-defined, not a schema. Member-gated exactly as the
  // sibling search route is, and gated the same way on the workspace record
  // so a soft-deleted (or tombstoned) workspace 404s here too, even though
  // this route reads only D1 — the record load is the deletion gate, not a
  // storage-config lookup.
  .get("/workspaces/:name/files/facets", async (c) => {
    const name = c.req.param("name");
    await memberWorkspaceOr404(c.env, requireUserId(c), name);

    const record = await loadWorkspaceRecord(c.env, name);
    if (!record) {
      throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
    }

    return c.json(await listFacets(c.env.DB, name, c.req.query("key")));
  })

  // Resolve a selected browser item to a usable URL, by storage capability
  // (issue #123): the stable public URL when `publicBaseUrl` is configured;
  // otherwise a short-lived signed download URL when the provider can sign;
  // otherwise a typed error rather than a 200 with `url: null`. This is
  // separate from the gateway's `url` verb because its forced attachment
  // disposition requires signing, while binding-mode R2 uses publicBaseUrl.
  .get("/workspaces/:name/file-url", async (c) => {
    const name = c.req.param("name");
    await memberWorkspaceOr404(c.env, requireUserId(c), name);
    const key = c.req.query("key") ?? "";
    if (badKey(key)) throw new NotFoundError();
    const record = await loadWorkspaceRecord(c.env, name);
    if (!record) throw new NotFoundError();
    const store = await storage(c.env, record);
    if (!(await store.exists(key))) throw new NotFoundError();

    const cfg = await storageConfig(c.env, record);
    const url = publicUrl(cfg, key);
    if (url) return c.json({ url });

    const signed = await signedDownloadUrl(store, key);
    if (signed) return c.json({ url: signed });

    throw new ValidationError(
      "no public or signed URL available for this workspace's storage configuration",
      { code: "file_url_unavailable" },
    );
  })

  // Toggle a file's `visibility` custom-metadata flag — member-gated, same key
  // convention as `file-url` (key via query param; embedding it in the path
  // segment fights Hono's routing for keys containing `/`). Storage mechanics
  // (head/size-cap/download/re-upload) live in files-core's
  // `setObjectVisibility`; this route keeps auth, key validation, body
  // validation, and error mapping.
  //
  // Wire value stays "public" | "private" (issue #166: renaming the field
  // would be a breaking API change), but the semantics are "unlisted," not
  // byte-private: `visibility: "private"` hides an object from the public
  // file listing and 401-gates `/public/files/...` + the `/f/…` page
  // (public-files.ts). On a workspace with `publicBaseUrl` the raw object URL
  // still serves bytes unsigned to anyone who has it — this endpoint never
  // controlled that. Document that distinction anywhere this field is
  // surfaced to API consumers; don't call it "private" in a byte-privacy
  // sense.
  .patch("/workspaces/:name/files/visibility", async (c) => {
    const name = c.req.param("name");
    await memberWorkspaceOr404(c.env, requireUserId(c), name);
    const key = c.req.query("key") ?? "";
    if (badKey(key)) throw new NotFoundError();

    // Throttle rewrites per workspace — checked only after the membership
    // gate, so a non-member can't burn a workspace's write budget. Same
    // WRITE_LIMITER the token-scoped mutating routes use (see guards.ts).
    if (!(await allowWrite(c.env, name))) {
      throw new RateLimitedError("rate limit exceeded");
    }

    const body = await c.req.json().catch(() => null);
    const requested = (body as { visibility?: unknown } | null)?.visibility;
    if (
      typeof requested !== "string" ||
      !(VISIBILITY_VALUES as readonly string[]).includes(requested)
    ) {
      throw new ValidationError('visibility must be "public" or "private"', {
        code: "invalid_visibility",
      });
    }

    const record = await loadWorkspaceRecord(c.env, name);
    if (!record) throw new NotFoundError();
    const store = await storage(c.env, record);

    await setObjectVisibility(store, key, requested as "public" | "private");

    return c.json({ key, visibility: sanitizeVisibility(requested) ?? "public" });
  })

  // Delete a file — member-gated web administration (spec 2026-07-30). Same
  // key convention and gate ordering as the visibility route above; all
  // storage/D1/ledger mechanics live in files-core's deleteObject (shared
  // with the token-authed DELETE /v1/:workspace/files/:key). Any member may
  // delete — parity with the CLI, where any member token can `uploads delete`.
  .delete("/workspaces/:name/files", async (c) => {
    const name = c.req.param("name");
    await memberWorkspaceOr404(c.env, requireUserId(c), name);
    const key = c.req.query("key") ?? "";
    if (badKey(key)) throw new NotFoundError();

    if (!(await allowWrite(c.env, name))) {
      throw new RateLimitedError("rate limit exceeded");
    }

    const record = await loadWorkspaceRecord(c.env, name);
    if (!record) throw new NotFoundError();

    return c.json(await deleteObject(c.env, record, key, name));
  })

  // files-sdk's folder-aware browser gateway. Authorization happens before a
  // storage instance is constructed; readonly plus this operation allow-list
  // independently prevent member UI requests from mutating storage.
  .all("/workspaces/:name/file-browser", async (c) => {
    const name = c.req.param("name");
    await memberWorkspaceOr404(c.env, requireUserId(c), name);
    const record = await loadWorkspaceRecord(c.env, name);
    if (!record) {
      throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
    }
    const router = createFilesRouter({
      files: (await storage(c.env, record)).readonly(),
      operations: ["list"],
      maxListLimit: 100,
      // files-sdk resolves a signing secret even when signing operations are
      // disabled. This value is intentionally non-secret and cannot authorize
      // anything on this list-only, authenticated gateway.
      secret: `readonly-list:${name}`,
    });
    return router.handle(c.req.raw);
  })

  // Invite an email to the org backing this workspace (Better Auth invitation).
  // Workspace org admin|owner only. Returns acceptUrl so self-hosted installs
  // without Email Sending can still hand the invitee a link.
  .post("/workspaces/:name/invites", async (c) => {
    const name = c.req.param("name");
    const userId = requireUserId(c);
    // Membership already carries org slug (1:1 mapping) — no second org fetch.
    const ws = await adminWorkspaceOr403(c.env, userId, name);

    if (!(await allowWrite(c.env, name))) {
      throw new RateLimitedError("rate limit exceeded");
    }

    const body = await c.req
      .json<{ email?: unknown; role?: unknown }>()
      .catch(() => ({}) as { email?: unknown; role?: unknown });
    // Account UI always invites as member; API still accepts role for CLI.
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const role = typeof body.role === "string" ? body.role.trim() : "member";
    if (!email || !EMAIL_RE.test(email)) {
      throw new ValidationError("invalid email address", { code: "invalid_email" });
    }
    if (role !== "member" && role !== "admin") {
      throw new ValidationError("role must be member or admin", { code: "invalid_role" });
    }

    // Per-recipient rate limit when the binding is configured (hosted always;
    // self-hosted opt-in via wrangler). Absent binding = no RL (same as other
    // optional limiters).
    const limiter = c.env.INVITE_LIMITER;
    if (limiter) {
      const { success } = await limiter.limit({ key: `invite:email:${email}` });
      if (!success) throw new RateLimitedError("invite rate limit exceeded");
    }

    const response = await c.env.AUTH.fetch("https://auth.internal/internal/invite", {
      method: "POST",
      headers: { "content-type": "application/json", "x-uploads-internal": "1" },
      body: JSON.stringify({
        organizationSlug: ws.organization.slug,
        email,
        role,
        inviterUserId: userId,
      }),
    });
    const payload = (await response.json().catch(() => null)) as {
      invitation?: { id?: string };
      acceptUrl?: string;
    } | null;
    if (!response.ok) throwForInviteError(response.status, payload);
    // Ensure acceptUrl even if an older auth worker omits it.
    const webOrigin = (c.env.WEB_ORIGIN || "https://uploads.sh").replace(/\/$/, "");
    const id = payload?.invitation?.id;
    const acceptUrl =
      payload?.acceptUrl ?? (id ? `${webOrigin}/accept-invitation/${id}` : undefined);
    return c.json({ ...payload, acceptUrl }, response.status === 200 ? 200 : 201);
  })

  // Pending invites for this workspace — admin/owner only (they can revoke).
  .get("/workspaces/:name/invites", async (c) => {
    const name = c.req.param("name");
    const ws = await adminWorkspaceOr403(c.env, requireUserId(c), name);
    const invites = await invitesForOrg(c.env, ws.organization.slug);
    return c.json({ invites });
  })

  // Revoke a pending invite — admin/owner only.
  .delete("/workspaces/:name/invites/:id", async (c) => {
    const name = c.req.param("name");
    const userId = requireUserId(c);
    const ws = await adminWorkspaceOr403(c.env, userId, name);
    if (!(await allowWrite(c.env, name))) throw new RateLimitedError("rate limit exceeded");
    await revokeInvite(c.env, ws.organization.slug, c.req.param("id"), userId);
    return c.json({ ok: true });
  })

  // Remove a member (by opaque member id) — admin/owner only; matrix enforced in auth worker.
  .delete("/workspaces/:name/members/:memberId", async (c) => {
    const name = c.req.param("name");
    const userId = requireUserId(c);
    const ws = await adminWorkspaceOr403(c.env, userId, name);
    if (!(await allowWrite(c.env, name))) throw new RateLimitedError("rate limit exceeded");
    await removeMember(c.env, ws.organization.slug, c.req.param("memberId"), userId);
    return c.json({ ok: true });
  })

  // Change a member's role (admin↔member); auth worker enforces the matrix.
  .patch("/workspaces/:name/members/:memberId", async (c) => {
    const name = c.req.param("name");
    const userId = requireUserId(c);
    const ws = await adminWorkspaceOr403(c.env, userId, name);
    if (!(await allowWrite(c.env, name))) throw new RateLimitedError("rate limit exceeded");
    const body = await c.req.json<{ role?: unknown }>().catch(() => ({}) as { role?: unknown });
    const role = typeof body.role === "string" ? body.role.trim() : "";
    if (role !== "admin" && role !== "member") {
      throw new ValidationError("role must be admin or member", { code: "invalid_role" });
    }
    const member = await updateMemberRole(
      c.env,
      ws.organization.slug,
      c.req.param("memberId"),
      role,
      userId,
    );
    return c.json({ member });
  })

  // Batch PR/issue titles for the connected-work rail (issue #267). Member-
  // gated: title text for private repos is sensitive, and membership scoping
  // keeps this from becoming a public title oracle for whatever repos the
  // App can read. Per-ref failures are nulls — the endpoint never fails the
  // batch wholesale.
  .get("/workspaces/:name/github-titles", async (c) => {
    const name = c.req.param("name");
    await memberWorkspaceOr404(c.env, requireUserId(c), name);

    const raw = (c.req.query("refs") ?? "").split(",").filter((s) => s.length > 0);
    if (raw.length === 0) {
      throw new ValidationError("refs query parameter required", { code: "refs_required" });
    }
    if (raw.length > 20) {
      throw new ValidationError("at most 20 refs per request", { code: "too_many_refs" });
    }
    const normalized = raw.map((coordinate) => {
      const parsed = parseExternalReference("github", coordinate);
      if (!parsed.ok) {
        throw new ValidationError(`invalid ref: ${coordinate}`, { code: "invalid_ref" });
      }
      // normalizedKey carries a `github:item:` provider prefix — the gh.ref
      // metadata shape (and this response's keys) is bare
      // `owner/repo#number`, so derive it from the locator instead.
      const { owner, repository, number } = parsed.value.locator;
      return `${owner}/${repository}#${number}`;
    });

    const titles = await resolveTitles(c.env, [...new Set(normalized)]);
    return c.json({ refs: titles });
  })

  // Whether this workspace already has the GitHub App installed (issue #492),
  // so the rail's `install github app` CTA can stop nagging workspaces that
  // installed it. Member-gated like the sibling `/github-titles`: the answer
  // is derived from the workspace's repo bindings, which aren't public.
  // Never fails — see `githubInstallStatus` for the degrade-to-false rule.
  .get("/workspaces/:name/github-status", async (c) => {
    const name = c.req.param("name");
    await memberWorkspaceOr404(c.env, requireUserId(c), name);
    return c.json<GithubInstallStatus>(await githubInstallStatus(c.env, name));
  })

  // Repos this workspace has linked (issue #307, Task 7) — feeds the comment
  // settings preview panel's repo picker. Admin/owner-gated like the
  // comment-settings/preview routes below (same audience: whoever can edit
  // the defaults is whoever should see which repos they apply to). This is
  // the session-authed counterpart to admin-ui's operator-only
  // `/admin-ui/workspaces/:name/github-links` — that route needs
  // `ADMIN_TOKEN`, which the web app's Better Auth session can't produce.
  // Repo names only: the web client has no use for installationId/source/
  // createdAt, and trimming them keeps this from becoming a second surface
  // to keep in sync with `repoLinkResponse` in admin-ui.ts.
  .get("/workspaces/:name/repo-links", async (c) => {
    const name = c.req.param("name");
    await adminWorkspaceOr403(c.env, requireUserId(c), name);
    const links = await listRepoLinksForWorkspace(c.env.DB, name);
    return c.json({ repos: links.map((link) => link.repo) });
  })

  // Workspace-level managed-comment defaults (issue #307): image width,
  // inline-image cap, the two legacy booleans, and a short note. Admin/owner
  // only — these are workspace-wide defaults every repo comment inherits
  // unless a repo's `.uploads.yml` overrides them.
  .get("/workspaces/:name/comment-settings", async (c) => {
    const name = c.req.param("name");
    await adminWorkspaceOr403(c.env, requireUserId(c), name);
    const record = await loadWorkspaceRecord(c.env, name);
    if (!record) throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
    return c.json(commentSettingsResponse(record));
  })

  // Patch the defaults above. Validated in full before any write (reject-
  // all-or-apply-all — see `validateCommentSettingsPatch`); an omitted key
  // leaves the field unchanged, an explicit `null` clears it.
  .patch("/workspaces/:name/comment-settings", async (c) => {
    const name = c.req.param("name");
    const userId = requireUserId(c);
    await adminWorkspaceOr403(c.env, userId, name);
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
  })

  // Preview the production managed-comment body against resolved comment
  // settings (issue #307). Admin/owner-gated like the settings routes above:
  // the response includes per-key source attribution ("repo" | "workspace" |
  // "auto"), which a plain member has no reason to see. With no `repo` query
  // param, resolution runs against workspace defaults only (`repoConfig:
  // null`) via the same `resolveCommentOptions(null, ...)` entrypoint
  // `resolveRepoCommentOptions` wraps. With `repo`, it must already be
  // linked to THIS workspace (github-repo-links.ts) — otherwise 404, so a
  // preview can't be used to probe another workspace's repo binding or
  // `.uploads.yml` contents.
  //
  // Renders from a page of the workspace's own `gh/`-prefixed attachments
  // (first page only, mirrors gatherAttachments's url/pageUrl mapping but
  // skips the D1 metadata read — the preview needs no per-item meta beyond
  // what the static fixtures already carry). `listObjects` pages in
  // lexicographic key order, not upload recency, so this is a representative
  // sample rather than the "most recent" uploads. An empty workspace falls
  // back to `previewFixtureItems` so the preview is never blank.
  .get("/workspaces/:name/comment-preview", async (c) => {
    const name = c.req.param("name");
    await adminWorkspaceOr403(c.env, requireUserId(c), name);
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
    }

    const body = attachmentsCommentBody(items, [], attachmentsMarker(name), {
      imageWidth: resolved.imageWidth,
      maxInlineImages: resolved.maxInlineImages,
      metaPath: resolved.metaPath,
      metaState: resolved.metaState,
      note: resolved.note,
    });

    return c.json({ resolved, source, repoConfig, body, sample });
  })

  // Self-serve BYO R2 bucket (issue #583 Task 1.1): read/verify/write/detach
  // of a workspace's storage config. Same audience as the comment-settings
  // triple above (admin/owner only) — storage config is workspace-wide and
  // security sensitive. Readable regardless of `byoBucketEnabled` (the
  // settings UI needs the flag value to decide whether to show the panel at
  // all); verify/write/detach 403 when the flag is off (fail-closed, see
  // `byoBucketAllowed` in workspace.ts). Never returns credential values —
  // `storageStatusResponse` (workspace-storage.ts) projects masked/presence
  // fields only, same posture as `GET /admin/workspaces/:name` (admin.ts).
  .get("/workspaces/:name/storage", async (c) => {
    const name = c.req.param("name");
    await adminWorkspaceOr403(c.env, requireUserId(c), name);
    const record = await loadWorkspaceRecord(c.env, name);
    if (!record) throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
    return c.json(storageStatusResponse(record, byoBucketAllowed(record)));
  })

  // Runs the verify pipeline (storage-verify.ts) against the request body —
  // never saved state — so an admin can iterate on credentials before
  // anything is persisted. Rate-limited via `allowWrite` like every other
  // mutating-adjacent route here: each call does real remote I/O (auth
  // probe + a write/read/delete round-trip against the candidate bucket).
  .post("/workspaces/:name/storage/verify", async (c) => {
    const name = c.req.param("name");
    const userId = requireUserId(c);
    await adminWorkspaceOr403(c.env, userId, name);
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
  })

  // Persist a verified BYO config. Never trusts a client-side "verified"
  // claim — re-runs the same pipeline server-side against the request body,
  // and only writes on a pass. On a fail, responds with the verify result
  // (422) so the UI can render the same checklist the standalone verify
  // route would have. `mutateWorkspaceRecord` (with `requireServing`) both
  // re-checks the workspace hasn't been soft-deleted since the request
  // started and gives us the read-immediately-before-write window issue #387
  // exists for; sealing happens *inside* that callback (precedent:
  // `reencrypt-registry.ts`), never on data read earlier in the request.
  .put("/workspaces/:name/storage", async (c) => {
    const name = c.req.param("name");
    const userId = requireUserId(c);
    await adminWorkspaceOr403(c.env, userId, name);
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
    // ledger from the new bucket so it's honest immediately (it's dormant
    // for `maxStorageBytes` while BYO is active — `storageBudgetApplies` —
    // but powers the settings UI and becomes authoritative again on detach).
    // Best-effort: the config write above already succeeded, and reconcile
    // can be re-run any time.
    if (candidate.adoptExistingContents === true) {
      await storageReconcile(c.env, updated, name).catch((err) =>
        console.error("workspace storage attach: usage reconcile failed for", name, err),
      );
    }

    return c.json({ ...storageStatusResponse(updated, true), verify: result });
  })

  // Detach BYO storage and restore shared-bucket defaults. Never touches the
  // customer's bucket or its objects — only the platform's own KV record.
  // Blocked unless the workspace's usage ledger reports zero objects, or the
  // caller explicitly passes `force` (query `?force=true` or a JSON body
  // `{ "force": true }`) — mirrors the empty-workspace guard on PUT above,
  // in the opposite direction. Shared-bucket fields (bucket/binding/prefix/
  // publicBaseUrl) come from `selfServeWorkspaceRecord` so this can't drift
  // from what a brand-new self-serve workspace actually gets; everything
  // else on the record (limits, github links, comment settings, plan, other
  // flags) is preserved untouched.
  .delete("/workspaces/:name/storage", async (c) => {
    const name = c.req.param("name");
    const userId = requireUserId(c);
    await adminWorkspaceOr403(c.env, userId, name);
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
        delete next.storageConfiguredAt;
        delete next.storageVerifiedAt;
        delete next.storageConfiguredBy;
        delete next.storageAccessKeyIdLast4;
        return next;
      },
      { requireServing: true },
    );

    console.log(JSON.stringify({ event: "workspace_storage_detached", workspace: name, userId }));

    // `force` bypassed the emptiness guard, so the ledger still describes
    // the detached BYO bucket — but `maxStorageBytes` enforcement resumes on
    // the shared bucket the moment this record is restored, and stale counts
    // could leave the workspace permanently over-budget with nothing to
    // delete. Rebuild from the restored shared-bucket prefix (best-effort,
    // same rationale as the attach path above).
    if (force) {
      await storageReconcile(c.env, updated, name).catch((err) =>
        console.error("workspace storage detach: usage reconcile failed for", name, err),
      );
    }

    return c.json(storageStatusResponse(updated, byoBucketAllowed(updated)));
  });
