/**
 * "Does this workspace already have the GitHub App?" — the session-authenticated
 * install signal the workspace rail's `install github app` CTA needs to
 * self-suppress (issue #492).
 *
 * Why this exists at all: `/v1/:workspace/github/health` answers a different
 * question (is the *App* configured and subscribed to the right events) and is
 * workspace-token auth, while the repo-links listing is admin-only. The web app
 * holds a Better Auth session, so neither is reachable from it.
 *
 * The answer is derived, not stored: a workspace's bound repos come from
 * `github_repo_links` (D1), and each repo's installation is the existing App-JWT
 * lookup, KV-cached under `ghinst:` — so the steady state for a workspace that
 * has installed (and for one that hasn't) is a D1 read plus KV hits, no GitHub
 * traffic.
 *
 * Every failure degrades to `installed: false`, which shows the CTA. Nagging a
 * workspace that already installed is a small cost; hiding the CTA from one
 * that hasn't is the failure that actually matters.
 */

import { githubAppConfig, installationForRepo } from "./github-app";
import { listRepoLinksForWorkspace } from "./github-repo-links";

export interface GithubInstallStatus {
  /** false when the App env isn't configured on this worker — the integration is off entirely. */
  configured: boolean;
  /** true only when at least one repo bound to this workspace has the App installed. */
  installed: boolean;
  /** How many bound repos were probed (0 means the workspace has claimed no repos yet). */
  checkedRepos: number;
}

/**
 * Most bound repos probed per request. A workspace with dozens of claimed
 * repos still answers in a bounded number of subrequests, and the answer is a
 * single boolean — the first installed repo settles it, so the cap only ever
 * matters for a workspace whose *newest* repos are all uninstalled.
 */
export const GITHUB_STATUS_REPO_CAP = 10;

/**
 * Install status for `workspaceName`. Never throws: a D1 outage, a missing
 * App config, or a failed installation lookup all report "not installed".
 */
export async function githubInstallStatus(
  env: Env,
  workspaceName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GithubInstallStatus> {
  const cfg = githubAppConfig(env);
  if (!cfg) return { configured: false, installed: false, checkedRepos: 0 };

  let repos: string[];
  try {
    const links = await listRepoLinksForWorkspace(env.DB, workspaceName);
    repos = links.slice(0, GITHUB_STATUS_REPO_CAP).map((link) => link.repo);
  } catch (err) {
    console.error(
      JSON.stringify({
        message: "github install status link lookup failed",
        workspace: workspaceName,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return { configured: true, installed: false, checkedRepos: 0 };
  }

  // Sequential with an early exit: the common case is one or two bound repos,
  // and the first hit ends the walk before any further KV/GitHub work.
  for (const repo of repos) {
    const installationId = await installationForRepo(env, cfg, repo, fetchImpl);
    if (installationId !== null) {
      return { configured: true, installed: true, checkedRepos: repos.length };
    }
  }
  return { configured: true, installed: false, checkedRepos: repos.length };
}
