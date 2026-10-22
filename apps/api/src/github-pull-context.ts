/**
 * Server-side stand-in for the CLI's git/gh context (issue #700 parity) for
 * callers with no checkout, like the hosted MCP: find the open PR for a
 * branch and the PR/issue title, through the GitHub App. Only for repos
 * bound to the calling workspace, so a workspace never learns PR numbers or
 * titles of a repo that isn't its own. Every failure resolves to "unknown".
 */
import { githubFetch, githubHeaders, repoInstallationToken } from "./github-app";
import { deriveRepoBinding, findRepoLink } from "./github-repo-links";
import { resolveTitles } from "./github-titles";

const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** Whether `repo` is bound to `workspaceName` (the gate for every lookup here). */
export async function repoBoundToWorkspace(
  env: Env,
  repo: string,
  workspaceName: string,
): Promise<boolean> {
  if (!REPO_RE.test(repo)) return false;
  return deriveRepoBinding(await findRepoLink(env.DB, repo), workspaceName) === "self";
}

/**
 * The single open PR whose head is `branch` in `repo` itself (not a fork),
 * or null when there is none, more than one, or GitHub can't be asked.
 * Callers check the repo binding first.
 */
export async function findOpenPullForBranch(
  env: Env,
  repo: string,
  branch: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number | null> {
  if (!REPO_RE.test(repo) || branch.length === 0) return null;
  try {
    const token = await repoInstallationToken(env, repo, fetchImpl);
    if (!token) return null;
    const owner = repo.split("/")[0]!;
    const head = encodeURIComponent(`${owner}:${branch}`);
    const res = await githubFetch(
      fetchImpl,
      `https://api.github.com/repos/${repo}/pulls?state=open&head=${head}&per_page=2`,
      { headers: githubHeaders(token) },
    );
    if (!res.ok) return null;
    const pulls = (await res.json().catch(() => null)) as { number?: unknown }[] | null;
    if (!Array.isArray(pulls) || pulls.length !== 1) return null;
    const num = pulls[0]?.number;
    return typeof num === "number" && Number.isSafeInteger(num) && num > 0 ? num : null;
  } catch {
    return null;
  }
}

/** PR/issue title via the shared member title cache, or null when unknown. */
export async function pullTitle(
  env: Env,
  repo: string,
  num: number,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const normalized = repo.toLowerCase();
  const ref = `${normalized}#${num}`;
  const titles = await resolveTitles(
    env,
    [ref],
    { audience: "member", linkedRepos: new Set([normalized]) },
    fetchImpl,
  ).catch(() => null);
  return titles?.[ref]?.title ?? null;
}
