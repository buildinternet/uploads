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
import { ForbiddenError, NotFoundError, RateLimitedError, ValidationError } from "@uploads/errors";
import { createFilesRouter, signedDownloadUrl } from "@uploads/storage";
import { Hono, type Context } from "hono";
import { usageWithLimits } from "../budget";
import {
  findObjectsByMetadata,
  getMetadataForKeys,
  validateMetadataFilters,
} from "../file-metadata";
import { badKey, listObjects, setObjectVisibility } from "../files-core";
import { listGalleries } from "../galleries";
import { gallerySummary } from "../gallery-service";
import { allowWrite } from "../guards";
import {
  membersForOrg,
  membershipsForUser,
  orgForWorkspace,
  workspacesForOrg,
} from "../org-workspaces";
import { requireSessionUser, sessionAuth, type SessionVars } from "../session-auth";
import { objectPublicUrls, publicUrl, storage, storageConfig } from "../storage";
import { getWorkspaceUsage } from "../usage";
import { sanitizeVisibility, VISIBILITY_VALUES } from "../visibility";
import { loadWorkspaceRecord } from "../workspace";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface MyWorkspace {
  workspace: string;
  organization: { id: string; slug: string; name: string };
  role: string;
  /** True for the communal, world-readable workspace (see isCommunal). */
  communal: boolean;
}

/**
 * The communal workspace — the shared public dumping ground — is identified by
 * name (the shared bucket hosts many prefixed workspaces, so the bucket can't
 * mark it). Configurable via the `DEFAULT_WORKSPACE` var; defaults to
 * "default". Member surfaces skip the personal galleries/files browser for it.
 */
export function isCommunal(env: Env, name: string): boolean {
  return name === (env.DEFAULT_WORKSPACE || "default");
}

/**
 * Every workspace the user's memberships map to, one entry per (workspace,
 * membership) pair — `workspacesForOrg` never assumes slug === workspace
 * name directly, so this is a small fan-out rather than a 1:1 zip.
 */
async function myWorkspaces(env: Env, userId: string): Promise<MyWorkspace[]> {
  const memberships = await membershipsForUser(env, userId);
  const out: MyWorkspace[] = [];
  for (const membership of memberships) {
    const [org, names] = await Promise.all([
      orgForWorkspace(env, membership.organizationSlug),
      workspacesForOrg(env, membership.organizationSlug),
    ]);
    for (const workspace of names) {
      out.push({
        workspace,
        organization: org ?? {
          id: membership.organizationId,
          slug: membership.organizationSlug,
          name: membership.organizationSlug,
        },
        role: membership.role,
        communal: isCommunal(env, workspace),
      });
    }
  }
  return out;
}

/**
 * The caller's membership entry for `name`, or a uniform 404. Authorization for
 * every `/workspaces/:name/*` route is this lookup: a workspace absent from the
 * caller's memberships 404s (`workspace_not_found`) rather than 403ing, so
 * membership can't be probed for workspace existence.
 */
async function memberWorkspaceOr404(env: Env, userId: string, name: string): Promise<MyWorkspace> {
  const workspaces = await myWorkspaces(env, userId);
  const ws = workspaces.find((w) => w.workspace === name);
  if (!ws) throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
  return ws;
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
  const workspaces = await myWorkspaces(env, userId);
  return workspaces.some((w) => w.workspace === name && w.role === "owner");
}

export const me = new Hono<SessionVars>()
  .use("/*", sessionAuth, requireSessionUser)

  // Workspaces the caller belongs to, via their org memberships. `hasPublicUrl`
  // lets the account UI decide, per workspace, whether opening a file should
  // navigate to the public /f/ page (issue #135) or resolve through the
  // signed-URL-capable /file-url endpoint (issue #123) — see
  // apps/web's AccountFileBrowser. Loaded here (not in `myWorkspaces`, which
  // every member-gated route calls for authorization) so the extra KV read
  // per workspace stays confined to this one listing endpoint.
  .get("/workspaces", async (c) => {
    const userId = c.get("sessionUser")?.id;
    if (!userId) throw new NotFoundError("no session user", { code: "workspace_not_found" });
    const workspaces = await myWorkspaces(c.env, userId);
    const withPublicUrl = await Promise.all(
      workspaces.map(async (ws) => {
        const publicBaseUrl = ws.communal
          ? undefined
          : (await loadWorkspaceRecord(c.env, ws.workspace))?.publicBaseUrl;
        // `hasPublicUrl` kept alongside the URL itself for existing consumers.
        return Object.assign({}, ws, { hasPublicUrl: Boolean(publicBaseUrl), publicBaseUrl });
      }),
    );
    return c.json({ workspaces: withPublicUrl });
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

  // People in one workspace — member-gated (any member may see who they share
  // the workspace with; only the fields a teammate needs, not the raw member
  // rows the admin panel gets). Communal is a shared public space with no real
  // team behind it — same branch-free `communal: true` shape as galleries.
  .get("/workspaces/:name/members", async (c) => {
    const name = c.req.param("name");
    const ws = await memberWorkspaceOr404(c.env, requireUserId(c), name);
    if (ws.communal) return c.json({ communal: true, members: [] });

    // `ws.organization` was already resolved by the membership lookup — no
    // second org fetch. Internal `id`/`userId` never reach teammates.
    const members = await membersForOrg(c.env, ws.organization.slug);
    return c.json({
      communal: false,
      members: members.map((m) => ({
        email: m.email ?? "",
        name: m.name ?? "",
        role: m.role ?? "member",
        createdAt: m.createdAt,
      })),
    });
  })

  // Galleries in one workspace — member-gated. The communal workspace is a
  // shared public dumping ground, so we don't enumerate it here; the response
  // stays branch-free for clients with `communal: true` and an empty list.
  .get("/workspaces/:name/galleries", async (c) => {
    const name = c.req.param("name");
    const ws = await memberWorkspaceOr404(c.env, requireUserId(c), name);
    if (ws.communal) return c.json({ communal: true, galleries: [] });

    const page = await listGalleries(c.env.DB, name, { limit: 50 });
    return c.json({
      communal: false,
      galleries: page.galleries.map((gallery) => gallerySummary(c.env, gallery)),
    });
  })

  // A page of a workspace's files (public URLs), folder-aware and hydrated
  // with D1 `gh.*` metadata — member-gated. Skipped for the communal
  // workspace for the same reason as galleries; returns `communal: true` with
  // an empty list rather than listing the shared bucket to a member. Query
  // params mirror the token-scoped `GET /v1/:workspace/files` (files.ts):
  // `prefix`/`cursor` pass straight through, `limit` defaults to 100 (clamped
  // inside `listObjects`), and `delimiter` (new here) enables S3-style
  // "folder" navigation — `listObjects` surfaces the resulting common
  // prefixes as `prefixes` for the settings-page file browser.
  .get("/workspaces/:name/files", async (c) => {
    const name = c.req.param("name");
    const ws = await memberWorkspaceOr404(c.env, requireUserId(c), name);
    if (ws.communal) return c.json({ communal: true, files: [] });

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

    return c.json({ communal: false, files, prefixes, cursor: nextCursor });
  })

  // Metadata search — the session-authed twin of the token route's
  // `GET /v1/:workspace/files?meta.*` (files.ts). Same AND-of-equality
  // semantics and shared validators; scoped to one workspace, member-gated.
  // Results carry no `visibility` (it isn't in the D1 index — accepted caveat).
  .get("/workspaces/:name/files/search", async (c) => {
    const name = c.req.param("name");
    const ws = await memberWorkspaceOr404(c.env, requireUserId(c), name);
    if (ws.communal) return c.json({ items: [], truncated: false });

    const record = await loadWorkspaceRecord(c.env, name);
    if (!record) {
      throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
    }

    const query = c.req.query();
    const metaParamKeys = Object.keys(query).filter((k) => k.startsWith("meta."));
    if (metaParamKeys.length === 0) {
      throw new ValidationError("at least one meta.* filter is required", {
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
    validateMetadataFilters(filters);

    const SEARCH_LIMIT = 100;
    const [cfg, matches] = await Promise.all([
      storageConfig(c.env, record),
      findObjectsByMetadata(c.env.DB, name, filters, {
        prefix: query.prefix,
        limit: SEARCH_LIMIT + 1,
      }),
    ]);
    const truncated = matches.length > SEARCH_LIMIT;
    const page = truncated ? matches.slice(0, SEARCH_LIMIT) : matches;
    return c.json({
      items: page.map((match) => {
        const urls = objectPublicUrls(c.env, cfg, match.key);
        return { key: match.key, url: urls.url, embedUrl: urls.embedUrl, metadata: match.metadata };
      }),
      truncated,
    });
  })

  // Resolve a selected browser item to a usable URL, by storage capability
  // (issue #123): the stable public URL when `publicBaseUrl` is configured;
  // otherwise a short-lived signed download URL when the provider can sign;
  // otherwise a typed error rather than a 200 with `url: null`. This is
  // separate from the gateway's `url` verb because its forced attachment
  // disposition requires signing, while binding-mode R2 uses publicBaseUrl.
  .get("/workspaces/:name/file-url", async (c) => {
    const name = c.req.param("name");
    const ws = await memberWorkspaceOr404(c.env, requireUserId(c), name);
    const key = c.req.query("key") ?? "";
    if (ws.communal || badKey(key)) throw new NotFoundError();
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
  .patch("/workspaces/:name/files/visibility", async (c) => {
    const name = c.req.param("name");
    const ws = await memberWorkspaceOr404(c.env, requireUserId(c), name);
    const key = c.req.query("key") ?? "";
    if (ws.communal || badKey(key)) throw new NotFoundError();

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
    const ws = await memberWorkspaceOr404(c.env, requireUserId(c), name);
    if (ws.communal) {
      throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
    }
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
    await adminWorkspaceOr403(c.env, userId, name);

    if (!(await allowWrite(c.env, name))) {
      throw new RateLimitedError("rate limit exceeded");
    }

    const org = await orgForWorkspace(c.env, name);
    if (!org) {
      throw new NotFoundError("no organization for this workspace — ask a site operator", {
        code: "org_not_found",
      });
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
        organizationSlug: org.slug,
        email,
        role,
        inviterUserId: userId,
      }),
    });
    const payload = (await response.json().catch(() => null)) as {
      invitation?: { id?: string };
      acceptUrl?: string;
    } | null;
    if (!response.ok) {
      if (response.status === 403) {
        throw new ForbiddenError("not authorized to invite to this workspace", {
          code: "inviter_not_authorized",
          details: payload,
        });
      }
      throw new ValidationError("failed to create invitation", { details: payload });
    }
    // Ensure acceptUrl even if an older auth worker omits it.
    const webOrigin = (c.env.WEB_ORIGIN || "https://uploads.sh").replace(/\/$/, "");
    const id = payload?.invitation?.id;
    const acceptUrl =
      payload?.acceptUrl ?? (id ? `${webOrigin}/accept-invitation/${id}` : undefined);
    return c.json({ ...payload, acceptUrl }, response.status === 200 ? 200 : 201);
  });
