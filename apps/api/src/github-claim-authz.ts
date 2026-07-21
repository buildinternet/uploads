/**
 * Cross-tenant claim authorization (issue #297): gates a workspace's FIRST
 * implicit claim of an unbound repo in `github_repo_links` (see
 * `github-repo-links.ts`). Consulted only when a repo has no existing link —
 * once bound, `routes/github-comment.ts`'s per-request check (compare the
 * calling workspace against the existing link) is the only gate, and existing
 * rows are never re-validated against this module (grandfathered).
 *
 * The gap this closes: the App is installed org-wide across every customer
 * org, so `installationForRepo` resolves *any* org's installation for *any*
 * workspace's token. Nothing previously stopped workspace A from being the
 * first to call `/github/comment` or `/github/promote` for org B's repo and
 * silently becoming its bound workspace.
 *
 * Signal chosen: the calling token's minting Better Auth user must have a
 * linked GitHub account (issue #340/#344 attribution) whose login holds
 * push/maintain/admin permission on the target repo, verified via the App's
 * own installation token (`GET /repos/:repo/collaborators/:login/permission`)
 * — GitHub's own authorization data, not anything self-reported by the
 * workspace or its org. This is the strongest signal available today:
 * `WorkspaceRecord` carries no GitHub org/owner field, and the org<->workspace
 * mapping (`org-workspaces.ts`) is a Better Auth organization slug — a
 * workspace's org membership says nothing about which GitHub repos its
 * members can actually touch.
 *
 * Degrade-safe by construction: any missing signal (App not configured, App
 * not installed on the repo, no linked GitHub account, login lookup failure,
 * collaborator lookup failure) resolves to "not entitled". This also means a
 * legacy/shared/enrollment token — including the communal `default`
 * workspace's tokens, the widest exposure called out in issue #297 — can
 * never claim a NEW repo, though it can still act on repos already bound to
 * it (grandfathered).
 */
import { collaboratorPermission, githubAppConfig, installationForRepo } from "./github-app";
import { resolveUploaderLogin } from "./uploader-identity";

const WRITE_PERMISSIONS = new Set(["admin", "write", "maintain"]);

/**
 * Whether the calling workspace (identified only by its minting user, if
 * any) is entitled to claim `repo` for the first time. `mintingUserId` is
 * `null` for legacy/enrollment tokens and for D1-minted tokens with no
 * tracked minting user — both degrade to "not entitled".
 *
 * `knownInstallationId`, when supplied, skips the redundant
 * `installationForRepo` round-trip for callers that already resolved it
 * (`routes/github-comment.ts` needs it either way to decide
 * `app_unconfigured`/`not_installed` before this gate runs — GITHUB_CACHE
 * makes the extra lookup cheap either way, but passing it through avoids two
 * KV reads for one request).
 */
export async function isEntitledToClaimRepo(
  env: Env,
  repo: string,
  mintingUserId: string | null,
  fetchImpl: typeof fetch = fetch,
  knownInstallationId?: number,
): Promise<boolean> {
  if (!mintingUserId) return false;
  const cfg = githubAppConfig(env);
  if (!cfg) return false;
  const installationId =
    knownInstallationId ?? (await installationForRepo(env, cfg, repo, fetchImpl));
  if (installationId === null) return false;
  const login = await resolveUploaderLogin(env, mintingUserId, repo, fetchImpl);
  if (!login) return false;
  const permission = await collaboratorPermission(env, cfg, installationId, repo, login, fetchImpl);
  return permission !== null && WRITE_PERMISSIONS.has(permission);
}
