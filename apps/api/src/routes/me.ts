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
import { ForbiddenError, NotFoundError, RateLimitedError, ValidationError } from "@uploads/errors";
import { createFilesRouter, signedDownloadUrl } from "@uploads/storage";
import { Hono, type Context } from "hono";
import { usageWithLimits } from "../budget";
import { throwForInviteError } from "../invite-error";
import { parseExternalReference } from "../external-references";
import {
  facetKeys,
  facetValues,
  findObjectsByMetadata,
  getMetadataForKeys,
  META_KEY_RE,
  validateMetadataFilters,
} from "../file-metadata";
import { badKey, listObjects, setObjectVisibility } from "../files-core";
import { listGalleries } from "../galleries";
import { galleryListSummaries } from "../gallery-service";
import { githubInstallStatus, type GithubInstallStatus } from "../github-install-status";
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
import { objectPublicUrls, publicUrl, storage, storageConfig } from "../storage";
import { getWorkspaceUsage } from "../usage";
import { sanitizeVisibility, VISIBILITY_VALUES } from "../visibility";
import { loadWorkspaceRecord } from "../workspace";
import { planResponse, planSourceFor } from "../workspace-plan";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Max characters accepted in a `?name=` filename search term. */
const SEARCH_NAME_MAX = 128;

/**
 * Validate and normalize a `?name=` term. Lowercased here so the substring
 * comparison against object keys needs no per-row casing work. Always passed
 * to files-sdk as a `substring` pattern, never `glob` or `regex`: glob would
 * make `*` and `?` silently meaningful in a box where people type filenames,
 * and a user-supplied regex would be a denial-of-service vector.
 */
function normalizeSearchName(raw: string): string {
  const term = raw.trim();
  if (term.length === 0 || term.length > SEARCH_NAME_MAX) {
    throw new ValidationError("name must be 1–128 characters", {
      code: "file_search_invalid_name",
    });
  }
  return term.toLowerCase();
}

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
  // `GET /v1/:workspace/files?meta.*` (files.ts). Same AND-of-equality
  // semantics and shared validators; scoped to one workspace, member-gated.
  // Results carry no `visibility` (it isn't in the D1 index — accepted caveat).
  .get("/workspaces/:name/files/search", async (c) => {
    const name = c.req.param("name");
    await memberWorkspaceOr404(c.env, requireUserId(c), name);

    const record = await loadWorkspaceRecord(c.env, name);
    if (!record) {
      throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
    }

    const query = c.req.query();
    const metaParamKeys = Object.keys(query).filter((k) => k.startsWith("meta."));
    const rawName = c.req.query("name");
    const nameTerm = rawName === undefined ? undefined : normalizeSearchName(rawName);

    if (metaParamKeys.length === 0 && nameTerm === undefined) {
      throw new ValidationError("at least one meta.* filter or name is required", {
        code: "file_metadata_invalid_key",
      });
    }

    const filters: Record<string, string> = {};
    for (const param of metaParamKeys) {
      const key = param.slice("meta.".length);
      const values = c.req.queries(param) ?? [];
      if (values.length > 1) {
        throw new ValidationError(`repeated metadata filter for key: ${key}`, {
          code: "file_metadata_duplicate_filter",
          details: { key },
        });
      }
      filters[key] = values[0] ?? query[param];
    }
    if (metaParamKeys.length > 0) validateMetadataFilters(filters);

    const SEARCH_LIMIT = 100;
    const cfg = await storageConfig(c.env, record);

    // Two paths. With metadata filters the D1 index is the selective one and
    // already caps at SEARCH_LIMIT, so a name term narrows those rows in
    // memory and storage is never walked. Name alone has no index to use, so
    // it walks via files-sdk `search()` — `maxResults` stops the walk as soon
    // as the cap is reached rather than traversing the whole workspace.
    //
    // `truncated` must reflect whether the *underlying* query hit its cap,
    // not the post-filter match count: on the metadata path, a `?name=` term
    // narrows the D1 result set in memory, and a cap hit there can still
    // leave a name-matching count at or below SEARCH_LIMIT even though rows
    // beyond the D1 window (in object_key order) were never fetched at all.
    let matches: Array<{ key: string; metadata: Record<string, string> }>;
    let truncated: boolean;
    if (metaParamKeys.length > 0) {
      const found = await findObjectsByMetadata(c.env.DB, name, filters, {
        prefix: query.prefix,
        limit: SEARCH_LIMIT + 1,
      });
      // The name-filtered set is a subset of `found`, which is capped at
      // SEARCH_LIMIT + 1, so this subsumes checking the post-filter count.
      truncated = found.length > SEARCH_LIMIT;
      matches = nameTerm
        ? found.filter((match) => match.key.toLowerCase().includes(nameTerm))
        : found;
    } else {
      const store = await storage(c.env, record);
      const keys: string[] = [];
      for await (const file of store.search(nameTerm!, {
        match: "substring",
        caseInsensitive: true,
        maxResults: SEARCH_LIMIT + 1,
        ...(query.prefix ? { prefix: query.prefix } : {}),
      })) {
        keys.push(file.key);
      }
      const metaByKey = await getMetadataForKeys(c.env.DB, name, keys);
      matches = keys.map((key) => ({ key, metadata: metaByKey.get(key) ?? {} }));
      truncated = matches.length > SEARCH_LIMIT;
    }

    const page = truncated ? matches.slice(0, SEARCH_LIMIT) : matches;
    return c.json({
      items: page.map((match) => {
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

    const key = c.req.query("key");
    if (key === undefined) {
      return c.json(await facetKeys(c.env.DB, name));
    }
    if (!META_KEY_RE.test(key)) {
      throw new ValidationError(`invalid metadata key: ${key}`, {
        code: "file_metadata_invalid_key",
        details: { key },
      });
    }
    const { values, truncated } = await facetValues(c.env.DB, name, key);
    return c.json({ key, values, truncated });
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
  });
