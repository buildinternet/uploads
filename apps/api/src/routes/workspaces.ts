/**
 * POST /v1/workspaces (spec 2026-07-14): self-serve workspace creation.
 * Session-authed; requires a GitHub-linked account; creates the backing org
 * (with the caller as owner) over the AUTH binding, then writes the KV
 * ws:<name> record with the self-serve limit template. Org first, KV second,
 * with a compensating org delete when the KV write fails.
 */
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RateLimitedError,
  ValidationError,
} from "@uploads/errors";
import { Hono, type MiddlewareHandler } from "hono";
import { adminWorkspaceOr403, isCommunal } from "./me";
import {
  isFileScope,
  isOperatorScope,
  isWorkspaceScope,
  listTokens,
  revokeToken,
} from "../auth-db";
import { allowWorkspaceCreate, allowWrite } from "../guards";
import {
  deleteOrg,
  isGithubLinked,
  membershipsForUser,
  orgForWorkspace,
  provisionOrg,
} from "../org-workspaces";
import { selfServeWorkspaceRecord } from "../self-serve-defaults";
import { requireSessionUser, sessionAuth, type SessionVars } from "../session-auth";
import { validateSlug } from "../slug-policy";
import {
  isPastGrace,
  isPurgedTombstone,
  loadWorkspaceRecord,
  loadWorkspaceRecordRaw,
  stampRestore,
  stampSoftDelete,
  workspaceGovernanceAuth,
  workspaceNameFromToken,
  type GovernanceVars,
} from "../workspace";

const HASH_PREFIX_LEN = 8;

/** Combined context vars for routes reachable by either auth path (issue #262 Task 3). */
type ManageAuthVars = {
  Variables: SessionVars["Variables"] & GovernanceVars["Variables"];
  Bindings: Env;
};

/**
 * Dual auth for self-serve token governance (#262 Task 3): EITHER a session
 * user holding org role admin/owner in `:name` (mirrors `adminWorkspaceOr403`
 * in `./me.ts`) OR a D1 `workspace:manage`-scoped token bound to `:name`
 * (`workspaceGovernanceAuth`, see `../workspace.ts`). The bearer value itself
 * picks the path — `up_<workspace>_…` shaped tokens go through the
 * governance guard; anything else (including Better Auth bearer sessions,
 * which also ride the Authorization header — see workspaces.test.ts) falls
 * back to session-cookie/bearer auth.
 *
 * Deliberately fail-closed: when an `up_`-shaped bearer is presented it is
 * authoritative — an invalid one (revoked/expired/foreign/wrong-scope) is
 * rejected outright, with NO fallback to a session cookie that may also be
 * on the request. An explicitly presented credential is judged on its own
 * merits; silently escalating a bad token to the caller's session would mask
 * revocation and make "is this token still valid?" unanswerable from the
 * response.
 */
function workspaceManageAuth(): MiddlewareHandler<ManageAuthVars> {
  return async (c, next) => {
    const authHeader = c.req.header("Authorization");
    const rawToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
    if (rawToken && workspaceNameFromToken(rawToken) !== undefined) {
      // Sub-middleware Contexts differ only in which Variables key they
      // touch; Hono's `Set` is invariant on Variables so a structural cast
      // is needed at each hand-off (both directions, below).
      await workspaceGovernanceAuth("workspace:manage")(
        c as unknown as Parameters<ReturnType<typeof workspaceGovernanceAuth>>[0],
        next,
      );
      return;
    }

    const sessionC = c as unknown as Parameters<typeof sessionAuth>[0];
    await sessionAuth(sessionC, async () => {});
    await requireSessionUser(sessionC, async () => {});
    const name = c.req.param("name")!;
    const user = c.get("sessionUser")!;
    await adminWorkspaceOr403(c.env, user.id, name);
    c.set("governanceMintingUserId", user.id);
    await next();
  };
}

/** Redacted scope list for display — never surfaces unrecognized/garbage entries. */
function parseAnyScopes(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (v): v is string => isFileScope(v) || isOperatorScope(v) || isWorkspaceScope(v),
    );
  } catch {
    return [];
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const WS_NAME_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

function requireWorkspaceName(name: string): void {
  if (!WS_NAME_RE.test(name)) {
    throw new ValidationError("invalid workspace", { code: "invalid_workspace" });
  }
}

const MAX_BODY_BYTES = 1024;
export const MAX_SELF_SERVE_WORKSPACES = 3;

export const workspaces = new Hono<SessionVars>().post(
  "/",
  sessionAuth,
  requireSessionUser,
  async (c) => {
    const bytes = await c.req.arrayBuffer();
    if (bytes.byteLength > MAX_BODY_BYTES) {
      throw new ValidationError("request body too large", { code: "invalid_request" });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new ValidationError("request body must be valid JSON", { code: "invalid_request" });
    }
    const name =
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? String((parsed as Record<string, unknown>).name ?? "").trim()
        : "";

    const verdict = validateSlug(name);
    if (!verdict.ok) {
      throw new ValidationError("workspace name is invalid or unavailable", {
        code: verdict.code,
      });
    }

    const user = c.get("sessionUser")!;

    // Rate-limit before the GitHub round-trip so unthrottled probes can't
    // hammer the auth worker. Dedicated strict limiter (3/60s, matching the
    // create cap) rather than the shared WRITE_LIMITER — that keeps
    // concurrent requests from racing past the per-user cap check below.
    if (!(await allowWorkspaceCreate(c.env, user.id))) {
      throw new RateLimitedError("workspace creation rate limit exceeded");
    }

    if (!(await isGithubLinked(c.env, user.id))) {
      throw new ForbiddenError("connect a GitHub account to create workspaces", {
        code: "github_required",
      });
    }

    // Cap counts only self-serve workspaces the user OWNS — BYO/operator
    // workspaces (no selfServe flag) never burn the allowance.
    const memberships = await membershipsForUser(c.env, user.id);
    const owned = memberships.filter((m) => m.role === "owner");
    const records = await Promise.all(
      owned.map((m) => loadWorkspaceRecord(c.env, m.organizationSlug)),
    );
    const selfServeCount = records.filter((r) => r?.selfServe === true).length;
    if (selfServeCount >= MAX_SELF_SERVE_WORKSPACES) {
      throw new ForbiddenError(`workspace limit reached (${MAX_SELF_SERVE_WORKSPACES})`, {
        code: "workspace_cap_reached",
      });
    }

    // Direct KV read (no cacheTtl) — a 60s-stale cached miss here could let a
    // just-taken name through to the org 409 instead, which is fine, but a
    // stale HIT must not block a genuinely free name.
    const existing = await c.env.REGISTRY.get(`ws:${name}`);
    if (existing !== null) {
      throw new ConflictError("workspace name is taken", { code: "workspace_name_taken" });
    }

    // Org first (owns uniqueness via UNIQUE slug), KV second, compensate on failure.
    await provisionOrg(c.env, { slug: name, ownerUserId: user.id });
    const record = selfServeWorkspaceRecord({ name, userId: user.id, now: new Date() });
    try {
      await c.env.REGISTRY.put(`ws:${name}`, JSON.stringify(record));
    } catch (err) {
      // Best-effort rollback; if this also fails the org is inert (no KV
      // record → no storage access) and an admin can clean it up. Log loudly
      // so a failed rollback isn't silently swallowed — an orphaned org row
      // needs a human to notice and clean up.
      await deleteOrg(c.env, name).catch((rollbackErr) =>
        console.error("self-serve rollback failed: org", name, "may be orphaned", rollbackErr),
      );
      throw err;
    }

    return c.json(
      { workspace: { name, publicBaseUrl: record.publicBaseUrl, selfServe: true } },
      201,
    );
  },
);

/**
 * Loads the raw record for `:name` and checks that the session user owns it
 * via self-serve (`selfServe === true` and `createdByUserId` matches). Shared
 * by the delete and restore handlers below.
 *
 * 404 for unknown/purged-tombstone names (uniform with every other
 * not-found path); 403 for a workspace that exists but isn't a self-serve
 * workspace this user owns — including the communal workspace, which is
 * excluded outright regardless of its record shape.
 */
async function loadOwnedSelfServeRecord(c: { env: Env }, name: string, userId: string) {
  if (isCommunal(c.env, name)) {
    throw new ForbiddenError("cannot delete the communal workspace", {
      code: "protected_workspace",
    });
  }
  const raw = await loadWorkspaceRecordRaw(c.env, name);
  if (!raw || isPurgedTombstone(raw)) {
    throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
  }
  if (raw.selfServe !== true || raw.createdByUserId !== userId) {
    throw new ForbiddenError("you do not own this workspace", { code: "not_owner" });
  }
  return raw;
}

/**
 * Self-serve workspace deletion (#249), following on from #244's admin
 * break-glass path. Soft-delete ONLY: stamps `deletedAt`/`purgeAt` via the
 * shared `stampSoftDelete` helper (see `../workspace.ts`) and puts the
 * record back — never a hard/force mode, never slug-freeing. See
 * docs/deletion.md: member-facing deletes are soft, always.
 */
workspaces.delete("/:name", sessionAuth, requireSessionUser, async (c) => {
  const name = c.req.param("name");
  requireWorkspaceName(name);
  if (!(await allowWrite(c.env, name))) {
    throw new RateLimitedError("rate limit exceeded");
  }
  const user = c.get("sessionUser")!;

  const record = await loadOwnedSelfServeRecord(c, name, user.id);
  if (record.deletedAt) {
    throw new ConflictError("workspace is already deleted", {
      code: "already_deleted",
      details: { deletedAt: record.deletedAt, purgeAt: record.purgeAt },
    });
  }

  const updated = stampSoftDelete(record);
  await c.env.REGISTRY.put(`ws:${name}`, JSON.stringify(updated));

  console.log(
    JSON.stringify({
      event: "workspace_deleted",
      workspace: name,
      mode: "soft",
      actor: "self_serve",
      purgeAt: updated.purgeAt,
    }),
  );

  return c.json({
    ok: true,
    workspace: name,
    mode: "soft",
    deletedAt: updated.deletedAt,
    purgeAt: updated.purgeAt,
  });
});

/**
 * Self-serve restore, mirroring the admin restore semantics exactly (see
 * `routes/admin.ts`'s `/workspaces/:name/restore`): 409 `not_deleted` if the
 * workspace isn't currently soft-deleted, 410 `grace_expired` once `purgeAt`
 * has passed (restorability must not depend on cron timing), and an
 * unparseable/missing `purgeAt` is treated as still-restorable.
 */
workspaces.post("/:name/restore", sessionAuth, requireSessionUser, async (c) => {
  const name = c.req.param("name");
  requireWorkspaceName(name);
  if (!(await allowWrite(c.env, name))) {
    throw new RateLimitedError("rate limit exceeded");
  }
  const user = c.get("sessionUser")!;

  const record = await loadOwnedSelfServeRecord(c, name, user.id);
  if (!record.deletedAt) {
    throw new ConflictError("workspace is not deleted", { code: "not_deleted" });
  }
  if (isPastGrace(record.purgeAt)) {
    throw new AppError({
      type: "conflict",
      code: "grace_expired",
      message: "grace period has expired",
      status: 410,
    });
  }

  const rest = stampRestore(record);
  await c.env.REGISTRY.put(`ws:${name}`, JSON.stringify(rest));

  console.log(
    JSON.stringify({ event: "workspace_restored", workspace: name, actor: "self_serve" }),
  );

  return c.json({ ok: true, workspace: name });
});

/**
 * Token-authed invite (issue #262) — mirrors `POST /me/workspaces/:name/invites`
 * but is bearer-token-authed with a D1 `workspace:invite`-scoped token
 * (`workspaceGovernanceAuth`, see `../workspace.ts`) instead of a session
 * cookie. Per the plan's invite-attribution rule, the invite acts as the
 * token's `minting_user_id` — the auth worker's internal invite route
 * independently re-checks that user's org admin/owner role server-side
 * (`apps/auth/src/internal-routes.ts`), so a minter who lost their org role
 * can no longer invite with an old token even though the token itself is
 * still active.
 */
workspaces.post("/:name/invites", workspaceGovernanceAuth("workspace:invite"), async (c) => {
  const name = c.req.param("name");
  requireWorkspaceName(name);

  const mintingUserId = c.get("governanceMintingUserId");
  if (!mintingUserId) {
    // Enrollment-code-derived or pre-migration tokens have no minting user
    // to attribute the invite to (and thus nothing for the auth worker's
    // org-role re-check to run against) — treat as unauthorized.
    throw new ForbiddenError("token has no attributable minting user", {
      code: "no_minting_user",
    });
  }

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
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const role = typeof body.role === "string" ? body.role.trim() : "member";
  if (!email || !EMAIL_RE.test(email)) {
    throw new ValidationError("invalid email address", { code: "invalid_email" });
  }
  if (role !== "member" && role !== "admin") {
    throw new ValidationError("role must be member or admin", { code: "invalid_role" });
  }

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
      inviterUserId: mintingUserId,
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
  const webOrigin = (c.env.WEB_ORIGIN || "https://uploads.sh").replace(/\/$/, "");
  const id = payload?.invitation?.id;
  const acceptUrl = payload?.acceptUrl ?? (id ? `${webOrigin}/accept-invitation/${id}` : undefined);
  return c.json({ ...payload, acceptUrl }, response.status === 200 ? 200 : 201);
});

/**
 * Self-serve token list (issue #262 Task 3) — dual-authed via
 * `workspaceManageAuth`. Mirrors the redacted shape of `GET /admin/tokens`
 * in `routes/admin.ts`: labels, scopes, created/expiry, hash prefix — NEVER
 * token values. Active D1 tokens only (revoked tokens don't need self-serve
 * visibility; the admin surface covers full history).
 */
workspaces.get("/:name/tokens", workspaceManageAuth(), async (c) => {
  const name = c.req.param("name");
  requireWorkspaceName(name);

  const tokens = (await listTokens(c.env.DB, name))
    .filter((token) => token.revoked_at === null)
    .map((token) => ({
      label: token.label,
      createdAt: token.created_at,
      hashPrefix: token.token_hash.slice(0, HASH_PREFIX_LEN),
      scopes: parseAnyScopes(token.scopes),
      expiresAt: token.expires_at,
    }));

  return c.json({ workspace: name, tokens });
});

/**
 * Self-serve token revoke (issue #262 Task 3) — dual-authed via
 * `workspaceManageAuth`. Mirrors the `DELETE /admin/tokens` contract:
 * revoke by `hashPrefix` or `label`, 404 for no match, 409 for an ambiguous
 * selector. `revokeToken` already scopes its lookup to `name` and to active
 * (non-revoked) tokens.
 */
workspaces.delete("/:name/tokens", workspaceManageAuth(), async (c) => {
  const name = c.req.param("name");
  requireWorkspaceName(name);

  const body = await c.req
    .json<{ hashPrefix?: string; label?: string }>()
    .catch(() => ({}) as { hashPrefix?: string; label?: string });
  const hashPrefix = body.hashPrefix?.trim();
  const label = body.label?.trim();
  if (!hashPrefix && !label) {
    throw new ValidationError("hashPrefix or label required", {
      code: "hash_prefix_or_label_required",
    });
  }

  const result = await revokeToken(c.env.DB, name, { hashPrefix, label });
  if (result.ambiguous) {
    throw new ConflictError("selector matches multiple tokens");
  }
  if (!result.match) {
    throw new NotFoundError("no matching token");
  }

  return c.json({
    workspace: name,
    revoked: {
      label: result.match.label,
      hashPrefix: result.match.token_hash.slice(0, HASH_PREFIX_LEN),
    },
  });
});
