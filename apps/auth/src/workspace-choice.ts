/**
 * Per-grant workspace choice (issue #231, auth side). Today
 * `customAccessTokenClaims` (src/auth.ts) always bakes the OLDEST org
 * membership into the JWT `workspace` claim — multi-workspace users get no
 * say. This file adds:
 *
 *  - `resolveWorkspaceChoiceReferenceId`: the `postLogin.consentReferenceId`
 *    hook (wired in src/auth.ts's `oauthProvider()` options). The plugin
 *    recomputes this at authorize-time AND filters its `oauth_consent`
 *    lookup by the returned string, and threads it through the auth code
 *    into access/refresh token rows and into every
 *    `customAccessTokenClaims({ referenceId, ... })` call (verified in the
 *    plugin dist — see oauth-D74mBkw6.d.mts). Returning `undefined` for
 *    single-workspace users keeps today's null-referenceId behavior — no
 *    re-consent churn for the common case.
 *  - `workspaceChoicePlugin`: a Better Auth plugin (pattern:
 *    src/local-demo.ts) exposing `POST /oauth2/workspace-choice`, which lets
 *    a signed-in multi-workspace user record which workspace they want an
 *    OAuth grant to operate on. The web-side picker UI (issue #231's other
 *    half) calls this before/at `/oauth/consent`.
 *
 * The picker UI lives on apps/web's /oauth/consent page — this file is only
 * the AS-side plumbing.
 */
import { createAuthEndpoint, sessionMiddleware, APIError } from "better-auth/api";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

/** Prefix distinguishing our workspace-scoped consent references from any other reference_id shape. */
export const WORKSPACE_REFERENCE_PREFIX = "ws:";

type Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * `member` ⋈ `organization` slugs for a user, oldest membership first.
 * Deliberately the same join + ordering as `resolveWorkspaceClaims` in
 * src/auth.ts (kept as a separate query here rather than imported, since the
 * two files evolve independently — this one only ever needs slugs, not the
 * `{workspace, workspaces}` claims shape).
 */
async function membershipSlugs(db: Db, userId: string): Promise<string[]> {
  const rows = await db
    .select({ slug: schema.organization.slug })
    .from(schema.member)
    .innerJoin(schema.organization, eq(schema.member.organizationId, schema.organization.id))
    .where(eq(schema.member.userId, userId))
    .orderBy(asc(schema.member.createdAt), asc(schema.member.id));
  return rows.map((r) => r.slug);
}

/**
 * The `postLogin.consentReferenceId` hook. Exported for direct unit testing
 * (see workspace-choice.test.ts), same rationale as `resolveWorkspaceClaims`
 * in src/auth.ts — driving the full authorize→consent→token flow through the
 * plugin to exercise this is comparatively heavy.
 *
 * - 0 or 1 memberships: returns `undefined` — single-workspace users keep
 *   today's null-referenceId behavior, no picker, no re-consent churn.
 * - 2+ memberships: returns `ws:<slug>`, where `<slug>` is the stored choice
 *   if one exists AND is still a live membership, otherwise the oldest
 *   membership. This deliberately forces one re-consent for existing
 *   multi-workspace users the first time this ships (no stored choice yet),
 *   which is when they see the picker for the first time.
 */
export async function resolveWorkspaceChoiceReferenceId(
  db: Db,
  userId: string | undefined,
): Promise<string | undefined> {
  if (!userId) return undefined;
  const slugs = await membershipSlugs(db, userId);
  if (slugs.length <= 1) return undefined;
  return `${WORKSPACE_REFERENCE_PREFIX}${await effectiveWorkspaceSlug(db, userId, slugs)}`;
}

/**
 * The slug the AS would bake into a token minted right now: the stored
 * choice if it's still a live membership, else the oldest membership. Shared
 * by the consentReferenceId hook above and the GET endpoint below — the
 * consent page's picker defaults to THIS value (fetched via GET) rather than
 * guessing client-side, so an untouched picker never overwrites the stored
 * choice or shifts the token's workspace.
 *
 * The choice row is deliberately keyed by user alone, not per client/grant:
 * `postLogin.consentReferenceId` receives only `{user, session, scopes}` —
 * no client id, no request context — so a per-client row could never be read
 * back at authorize-time. Per-grant scoping still holds where it matters:
 * the returned `ws:<slug>` is persisted on the consent row and baked into
 * that grant's token rows, so concurrent grants don't share state after
 * consent. The accepted residual is a same-user race across two
 * simultaneously open consent tabs (seconds-wide, self-inflicted,
 * recoverable via re-consent).
 */
async function effectiveWorkspaceSlug(db: Db, userId: string, slugs: string[]): Promise<string> {
  const [stored] = await db
    .select({ workspace: schema.oauthWorkspaceChoice.workspace })
    .from(schema.oauthWorkspaceChoice)
    .where(eq(schema.oauthWorkspaceChoice.userId, userId))
    .limit(1);

  return stored?.workspace && slugs.includes(stored.workspace) ? stored.workspace : slugs[0];
}

/**
 * If `referenceId` is one of ours (`ws:<slug>`) and `<slug>` is one of the
 * claims' known `workspaces`, override `workspace` with it. Used by
 * `customAccessTokenClaims` in src/auth.ts. Defensive by construction: a
 * referenceId for a workspace the user is no longer a member of (or isn't
 * one of ours) is silently ignored rather than overriding anything — a token
 * must always issue, and the caller's existing oldest-membership fallback
 * still applies.
 */
export function applyWorkspaceChoice<T extends { workspace: string | null; workspaces: string[] }>(
  claims: T,
  referenceId: string | undefined,
): T {
  if (!referenceId || !referenceId.startsWith(WORKSPACE_REFERENCE_PREFIX)) return claims;
  const slug = referenceId.slice(WORKSPACE_REFERENCE_PREFIX.length);
  if (!claims.workspaces.includes(slug)) return claims;
  return { ...claims, workspace: slug };
}

/**
 * `POST /oauth2/workspace-choice` (mounted under the worker's `/api/auth`
 * basePath, so the full path is `/api/auth/oauth2/workspace-choice`).
 * Session-required. Body `{ workspace: string }`. Validates the slug is one
 * of the signed-in user's org memberships (member ⋈ organization, same query
 * as `resolveWorkspaceClaims`/`membershipSlugs` above); on success upserts
 * the user's `oauth_workspace_choice` row and returns `{ status: true }`. A
 * non-membership slug (or a malformed body) 400s with
 * `code: "invalid_workspace"` rather than silently recording a workspace the
 * user can't actually use.
 *
 * No zod body schema here — apps/auth has no direct `zod` dependency (only a
 * transitive one via better-call/oauth-provider), so the body is validated
 * by hand instead of pulling in a new direct dependency for one field.
 */
export function workspaceChoicePlugin(db: Db) {
  return {
    id: "uploads-oauth-workspace-choice",
    endpoints: {
      /**
       * `GET /oauth2/workspace-choice` — the server-resolved effective
       * workspace (`{ workspace: string | null }`): stored choice if still a
       * live membership, else oldest membership, null for zero memberships.
       * The consent page's picker defaults its selection to this so an
       * untouched Allow round-trips the AS's own resolution instead of a
       * client-side guess.
       */
      oauthWorkspaceChoiceGet: createAuthEndpoint(
        "/oauth2/workspace-choice",
        {
          method: "GET",
          use: [sessionMiddleware],
        },
        async (ctx) => {
          const userId = ctx.context.session.user.id;
          const slugs = await membershipSlugs(db, userId);
          if (slugs.length === 0) return ctx.json({ workspace: null });
          return ctx.json({ workspace: await effectiveWorkspaceSlug(db, userId, slugs) });
        },
      ),
      oauthWorkspaceChoice: createAuthEndpoint(
        "/oauth2/workspace-choice",
        {
          method: "POST",
          use: [sessionMiddleware],
        },
        async (ctx) => {
          const userId = ctx.context.session.user.id;
          const rawWorkspace = (ctx.body as { workspace?: unknown } | undefined)?.workspace;
          if (typeof rawWorkspace !== "string" || rawWorkspace.length === 0) {
            throw new APIError("BAD_REQUEST", {
              code: "invalid_workspace",
              message: "`workspace` must be a non-empty string.",
            });
          }
          const workspace = rawWorkspace;

          const slugs = await membershipSlugs(db, userId);
          if (!slugs.includes(workspace)) {
            throw new APIError("BAD_REQUEST", {
              code: "invalid_workspace",
              message: "You are not a member of that workspace.",
            });
          }

          const now = new Date();
          const [existing] = await db
            .select({ userId: schema.oauthWorkspaceChoice.userId })
            .from(schema.oauthWorkspaceChoice)
            .where(eq(schema.oauthWorkspaceChoice.userId, userId))
            .limit(1);

          if (existing) {
            await db
              .update(schema.oauthWorkspaceChoice)
              .set({ workspace, updatedAt: now })
              .where(eq(schema.oauthWorkspaceChoice.userId, userId));
          } else {
            await db.insert(schema.oauthWorkspaceChoice).values({
              userId,
              workspace,
              createdAt: now,
              updatedAt: now,
            });
          }

          return ctx.json({ status: true });
        },
      ),
    },
  };
}
