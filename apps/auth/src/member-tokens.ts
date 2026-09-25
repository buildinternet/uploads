/**
 * Revoke workspace API tokens when their minter loses the membership (or
 * role) that let them mint.
 *
 * POST /v1/tokens (apps/api `routes/tokens.ts`) requires org membership to
 * mint and admin/owner for `workspace:*` scopes, but apps/api's bearer auth
 * (`workspace.ts`) only resolves the `auth_tokens` row — it never re-checks
 * that `minting_user_id` is still a member. Checking membership per request
 * would add auth-worker/D1 work to every bearer call, so tokens are revoked
 * here instead, at every place a `member` row is deleted or demoted
 * (`internal-routes.ts` and the organization hooks in `auth.ts`).
 *
 * `auth_tokens` is apps/api's table, but both workers share one D1 database
 * (issue #754), so this writes it directly. Workspace name == org slug (the
 * 1:1 mapping `org-workspaces.ts` documents). Tokens with a null
 * `minting_user_id` (legacy/enrollment rows) have no member to tie them to
 * and are left alone, same as `revokeTokensForMintingUser` in apps/api.
 */

/**
 * Soft-revoke every active token `userId` minted for `workspace`. Returns the
 * number of rows revoked.
 */
export async function revokeMemberWorkspaceTokens(
  db: D1Database,
  workspace: string,
  userId: string,
  now = new Date(),
): Promise<number> {
  if (!workspace || !userId) return 0;
  const result = await db
    .prepare(
      `UPDATE auth_tokens SET revoked_at = ?
       WHERE minting_user_id = ? AND workspace = ? AND revoked_at IS NULL`,
    )
    .bind(now.toISOString(), userId, workspace)
    .run();
  return result.meta?.changes ?? 0;
}

/**
 * Soft-revoke `userId`'s active tokens for `workspace` that carry any
 * `workspace:*` scope — minting those needs admin/owner, so a demotion must
 * take them back. File-only tokens stay valid. `scopes` is the JSON array
 * `JSON.stringify` writes, so each scope appears as a quoted string.
 */
export async function revokeMemberWorkspaceGovernanceTokens(
  db: D1Database,
  workspace: string,
  userId: string,
  now = new Date(),
): Promise<number> {
  if (!workspace || !userId) return 0;
  const result = await db
    .prepare(
      `UPDATE auth_tokens SET revoked_at = ?
       WHERE minting_user_id = ? AND workspace = ? AND revoked_at IS NULL
         AND scopes LIKE '%"workspace:%'`,
    )
    .bind(now.toISOString(), userId, workspace)
    .run();
  return result.meta?.changes ?? 0;
}

/**
 * Soft-revoke every active token `userId` minted, in any workspace — for
 * user deletion, which drops all of the user's memberships at once via the
 * `member.user_id` cascade. Mirrors apps/api's `revokeTokensForMintingUser`.
 */
export async function revokeAllTokensForMintingUser(
  db: D1Database,
  userId: string,
  now = new Date(),
): Promise<number> {
  if (!userId) return 0;
  const result = await db
    .prepare(
      `UPDATE auth_tokens SET revoked_at = ?
       WHERE minting_user_id = ? AND revoked_at IS NULL`,
    )
    .bind(now.toISOString(), userId)
    .run();
  return result.meta?.changes ?? 0;
}

/** True when an org role (single or comma-separated/array) can mint `workspace:*` scopes. */
export function isWorkspaceManagerRole(role: string | string[] | null | undefined): boolean {
  const roles = Array.isArray(role) ? role : (role ?? "").split(",");
  return roles.some((r) => {
    const trimmed = r.trim();
    return trimmed === "admin" || trimmed === "owner";
  });
}
