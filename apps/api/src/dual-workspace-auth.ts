/**
 * Dual-auth workspace guard for the canonical `/v1/workspaces/:workspace/*`
 * surface (issue #613 phase 1). Resolves "who is this + can they touch this
 * workspace" from EITHER credential type and sets the same `WorkspaceVars`
 * either way, so downstream handlers — including `requireScope` — never need
 * to know which one arrived. See `routes/workspace-files.ts` for the first
 * vertical built on this.
 */
import { ForbiddenError, NotFoundError, UnauthorizedError } from "@uploads/errors";
import type { Context, MiddlewareHandler } from "hono";
import { type WorkspaceScope } from "./auth-db";
import { FILE_SCOPES } from "./auth-db";
import { adminWorkspaceOr403, memberWorkspaceOr404, membershipsForUser } from "./org-workspaces";
import {
  requireSessionUser,
  sessionAuth,
  type SessionUser,
  type SessionVars,
} from "./session-auth";
import {
  loadWorkspaceRecord,
  workspaceAuth,
  workspaceGovernanceAuth,
  type GovernanceVars,
  type WorkspaceVars,
} from "./workspace";

/** Combined context vars for routes reachable by either auth path. */
export type DualAuthVars = {
  Variables: WorkspaceVars["Variables"] &
    SessionVars["Variables"] & {
      /**
       * Session `userId` resolved by `dualWorkspaceAuth`'s session branch —
       * set only when `authSource === "session"`. Lets `requireSessionAdmin`
       * read the already-resolved id directly instead of calling
       * `resolveSessionUserId` a second time, which would otherwise either
       * harmlessly re-hit the `PRERESOLVED_USER` WeakMap on a forwarded/
       * preset request, or — on a DIRECT (non-forwarded) request, where
       * nothing preset the WeakMap — trigger a second, redundant
       * `sessionAuth`/`get-session` network round trip for the same request
       * (finding 2, `.context/613-api-consolidation-plan.md`).
       */
      sessionUserId?: string;
    };
  Bindings: Env;
};

/**
 * In-process handoff for a session `userId` already resolved upstream of
 * `dualWorkspaceAuth` (issue #613 phase 1 follow-up, CodeRabbit finding on
 * PR #615). Keyed on the exact `Request` object so it can never leak across
 * requests. Trust argument: this map is only ever populated from inside this
 * process by `presetResolvedSessionUser` — an external caller has no way to
 * insert into it, so a request reaching `dualWorkspaceAuth` from outside
 * (e.g. the public `/v1/workspaces/...` mount) can never carry a forged
 * pre-resolved identity. This is why the handoff is a WeakMap and not a
 * header: a header on an inbound request is indistinguishable from one an
 * external caller sent themselves.
 */
const PRERESOLVED_USER = new WeakMap<Request, string>();

/**
 * Records that `request`'s session user was already resolved (its `userId`)
 * by an in-process caller — e.g. `me.ts`'s `forwardToWorkspaceFiles`, which
 * re-dispatches a request whose session was already verified by `me.ts`'s
 * own `sessionAuth` middleware. Call this on the exact `Request` instance
 * that will reach `dualWorkspaceAuth`, before dispatching it.
 */
export function presetResolvedSessionUser(request: Request, userId: string): void {
  PRERESOLVED_USER.set(request, userId);
}

/**
 * Whether `request` already carries a pre-resolved session `userId` via the
 * `PRERESOLVED_USER` handoff above. Exposed so a guard that needs to decide
 * "session path or bearer/token path" — `dualWorkspaceAuth` here,
 * `dualGovernanceAuth` below, and `routes/workspace-members.ts`'s
 * `sessionMemberGate` — can give a preset unconditional priority, BEFORE
 * ever branching on whatever `Authorization` header happens to still be
 * riding along on the forwarded `Request` (a forwarded `/me` request keeps
 * its original headers verbatim — see `me.ts`'s `forwardTo*` helpers). Fixes
 * issue #613 phase 3 review finding 1: a Better Auth bearer-session caller
 * (no cookie) whose session `me.ts` already validated was being rejected a
 * second time by a bearer-branch that ran before the preset was ever
 * consulted.
 */
export function hasPreresolvedSession(request: Request): boolean {
  return PRERESOLVED_USER.has(request);
}

/**
 * Resolves the calling session's `userId`, honoring the `presetResolvedUser`
 * WeakMap handoff (see above) before falling back to a real `sessionAuth` +
 * `requireSessionUser` round trip. Shared by `dualWorkspaceAuth` and
 * `dualGovernanceAuth` (and any session-only-but-bearer-aware guard a
 * canonical vertical wants to build) so "resolve the session exactly once
 * per forwarded request" stays true everywhere, not just on the files
 * vertical. Throws (via `requireSessionUser`) on no session — same as before
 * this was extracted.
 */
export async function resolveSessionUserId(c: Context<SessionVars>): Promise<string> {
  const preresolvedUserId = PRERESOLVED_USER.get(c.req.raw);
  if (preresolvedUserId !== undefined) return preresolvedUserId;
  await sessionAuth(c, async () => {});
  await requireSessionUser(c, async () => {});
  return (c.get("sessionUser") as SessionUser).id;
}

/**
 * Guards a `/…/:workspace/…` route with EITHER a bearer token (resolution
 * identical to `workspaceAuth`) OR a session cookie (membership check
 * identical to `me.ts`'s `memberWorkspaceOr404`).
 *
 * A presented bearer credential is authoritative — mirrors
 * `workspaceManageAuth` (`routes/workspaces.ts`): an explicit token is judged
 * on its own merits and never silently falls back to a session cookie that
 * might also ride the request. A session caller is granted every
 * `FILE_SCOPES`: membership is all-or-nothing on the file plane, same as
 * every existing `/me` file route, none of which consult `authScopes`.
 * `authSource: "session"` distinguishes the path taken without changing how
 * `requireScope` behaves (it only ever reads `authScopes`).
 *
 * A pre-resolved session (`hasPreresolvedSession`, e.g. a forwarded `/me`
 * request) always takes the session path unconditionally, BEFORE the bearer
 * check — a forwarded request's original `Authorization` header (a Better
 * Auth bearer session, say) must never re-route an already-validated caller
 * into the token path and 401 them a second time. Absent a preset, a bearer
 * stays authoritative exactly as before: this guard's token path accepts
 * both legacy hash tokens and D1 tokens (see `workspaceAuth`), so — unlike
 * `dualGovernanceAuth`/`workspaceManageAuth` — it cannot narrow the bearer
 * branch to an `up_`-prefixed shape without breaking legacy-token support.
 */
export function dualWorkspaceAuth(): MiddlewareHandler<DualAuthVars> {
  return async (c, next) => {
    const authorization = c.req.header("Authorization");
    if (!hasPreresolvedSession(c.req.raw) && authorization?.startsWith("Bearer ")) {
      return workspaceAuth(c as unknown as Parameters<typeof workspaceAuth>[0], next);
    }

    const userId = await resolveSessionUserId(c as unknown as Context<SessionVars>);

    const name = c.req.param("workspace");
    if (!name) throw new UnauthorizedError();
    await memberWorkspaceOr404(c.env, userId, name);

    const record = await loadWorkspaceRecord(c.env, name);
    if (!record) throw new NotFoundError("workspace not found", { code: "workspace_not_found" });

    c.set("workspace", record);
    c.set("workspaceName", name);
    c.set("authScopes", [...FILE_SCOPES]);
    c.set("authSource", "session");
    // A bearer token's `mintingUserId` names the Better Auth user whose
    // linked GitHub identity `isEntitledToClaimRepo` checks (see
    // `github-claim-authz.ts`) — for a session caller, that's simply the
    // authenticated session user, not `null`. Leaving this `null` on the
    // session path silently forced every session-admin repo claim through
    // `github/link` to fail with `not_authorized`, since
    // `isEntitledToClaimRepo` treats a null minting user as "not entitled"
    // by construction (CodeRabbit PR #617 review finding 3).
    c.set("mintingUserId", userId);
    c.set("sessionUserId", userId);
    await next();
  };
}

/**
 * Session-only admin|owner tier gate, layered AFTER `dualWorkspaceAuth()` for
 * verticals whose bearer analog is scope-gated but whose SESSION analog needs
 * a stricter tier than plain membership — first built for the github vertical
 * (issue #613 phase 3: link/health/activity require admin/owner for a session
 * caller, matching `routes/me.ts`'s `adminWorkspaceOr403` posture for the
 * pre-existing `/me/workspaces/:name/repo-links` route). Reusable as-is by
 * any later vertical with the same "bearer keeps its scope, session needs
 * admin/owner" posture — e.g. invites/members (see
 * `.context/613-api-consolidation-plan.md`).
 *
 * A no-op for a bearer credential (`authSource !== "session"`): bearer's only
 * gate stays whatever `requireScope` the route already applies — this
 * middleware never tightens or loosens bearer behavior.
 *
 * For a session caller, `dualWorkspaceAuth` has already proven membership
 * (non-member 404s before this middleware is ever reached), so a member who
 * isn't admin/owner gets a 403 here, not a 404 — "not allowed", not "doesn't
 * exist", same reasoning as `workspace-usage.ts`'s `requireToken` guard.
 * Deliberately re-resolves the membership role via its own `membershipsForUser`
 * call rather than threading a role through `DualAuthVars` — `dualWorkspaceAuth`
 * only ever needed to prove membership existed, not carry the role forward,
 * and adding a role field to `WorkspaceVars` would leak a session-only concept
 * into the bearer-shared type. Costs one extra round trip on session admin
 * routes only, same as `me.ts`'s own `memberWorkspaceOr404` -> `adminWorkspaceOr403`
 * double-lookup shape.
 *
 * Reads the caller's id off `sessionUserId` — set by `dualWorkspaceAuth`'s
 * session branch on EVERY session-path request, preset-fast-path or not —
 * rather than `c.get("sessionUser")`, which is only ever set by a real
 * `sessionAuth` round trip and stays unset on the preset fast path (issue
 * #613 phase 3 review finding 2: composing `dualWorkspaceAuth()` +
 * `requireSessionAdmin()` on a forwarded/preset request used to 401 an
 * already-authenticated caller because of exactly that gap). This also
 * avoids a second `resolveSessionUserId` call here, which would otherwise
 * either be a harmless redundant WeakMap hit (preset path) or a genuinely
 * redundant `get-session` network round trip (direct path, since
 * `dualWorkspaceAuth` already paid for one).
 */
export function requireSessionAdmin(): MiddlewareHandler<DualAuthVars> {
  return async (c, next) => {
    if (c.get("authSource") === "session") {
      const userId = c.get("sessionUserId");
      const name = c.get("workspaceName");
      if (!userId || !name) throw new UnauthorizedError();
      const [membership] = await membershipsForUser(c.env, userId, { slug: name });
      const role = membership?.role;
      if (role !== "admin" && role !== "owner") {
        throw new ForbiddenError("workspace admin or owner role required", {
          code: "workspace_admin_required",
        });
      }
    }
    await next();
  };
}

/** Combined context vars for a `dualGovernanceAuth`-guarded route. */
export type GovernanceSessionVars = {
  Variables: GovernanceVars["Variables"] & SessionVars["Variables"];
  Bindings: Env;
};

/**
 * Dual-auth guard for the workspace-*governance* scope namespace (issue #613
 * phase 3, invites/members vertical) — distinct from `dualWorkspaceAuth`,
 * which grants a session caller every `FILE_SCOPES`. Governance scopes
 * (`workspace:invite`/`workspace:manage`/etc., see `auth-db.ts`) are a
 * separate D1 token shape (`workspaceGovernanceAuth`) with no file-plane
 * analog, so a session caller here is never "granted a scope" — they're held
 * to the same admin/owner org-role tier the pre-existing `/me` governance-
 * adjacent routes (`adminWorkspaceOr403` in `routes/me.ts`) already require.
 *
 * A presented bearer credential is authoritative and delegates straight to
 * `workspaceGovernanceAuth(requiredScope)` — verbatim, so a governance-token
 * caller's behavior is provably unchanged by introducing this guard (see
 * `routes/workspace-governance-invite.test.ts`, still green against
 * `POST /v1/workspaces/:name/invites` after it was upgraded to use this
 * function in place of a bare `workspaceGovernanceAuth("workspace:invite")`).
 *
 * Bearer discrimination (issue #613 phase 3 review finding 1): a preset
 * (`hasPreresolvedSession`, e.g. a forwarded `/me` request whose session
 * `me.ts` already validated) always wins over any bearer header riding along
 * on the same forwarded request — never re-branch an already-authenticated
 * caller into the token path. Absent a preset, only an `up_`-shaped bearer is
 * treated as a governance token — the same discrimination `workspaceManageAuth`
 * (`routes/workspaces.ts`) already uses to tell a real workspace token apart
 * from a Better Auth bearer session (`bearer()` plugin, `apps/auth/src/auth.ts`)
 * riding the same `Authorization` header. Any other bearer (or none) falls
 * through to `resolveSessionUserId`, which forwards the `Authorization` header
 * to `get-session` as-is and validates a Better Auth session bearer exactly
 * like a cookie (`session-auth.ts`'s `resolveSessionUser`) — this is what
 * lets a bearer-session caller with no cookie succeed here.
 *
 * With no (non-`up_`) bearer: resolves the session, 404s a non-member
 * (uniform, no existence probe) via `adminWorkspaceOr403` — identical
 * codes/ordering to `me.ts`'s pre-#613 `adminWorkspaceOr403` call
 * (`memberWorkspaceOr404` -> role check), so a session caller's behavior is
 * provably unchanged by the swap. Sets `governanceMintingUserId` to the
 * session `userId` (mirroring what a bearer token's `minting_user_id`
 * represents — "who does this governance action act as") so a handler
 * written against `GovernanceVars` (e.g. the invite-creation handler in
 * `routes/workspaces.ts`) needs zero changes to work from either auth path.
 */
export function dualGovernanceAuth(
  requiredScope: WorkspaceScope,
): MiddlewareHandler<GovernanceSessionVars> {
  return async (c, next) => {
    const authorization = c.req.header("Authorization");
    const rawToken = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    if (!hasPreresolvedSession(c.req.raw) && rawToken?.startsWith("up_")) {
      return workspaceGovernanceAuth(requiredScope)(
        c as unknown as Parameters<ReturnType<typeof workspaceGovernanceAuth>>[0],
        next,
      );
    }

    const userId = await resolveSessionUserId(c as unknown as Context<SessionVars>);
    const name = c.req.param("name") ?? c.req.param("workspace");
    if (!name) throw new UnauthorizedError();

    await adminWorkspaceOr403(c.env, userId, name);

    c.set("governanceMintingUserId", userId);
    await next();
  };
}
