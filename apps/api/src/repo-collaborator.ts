/**
 * Repo-scoped access for GitHub collaborators who aren't workspace members.
 *
 * Anyone with write access to a repo on GitHub (write, maintain or admin,
 * read through the App installation) may upload for that repo into the
 * workspace the repo is linked to, using their own personal token. It's the
 * same bar the claim gate (github-claim-authz.ts) uses, and the same access
 * a contributor needs to open the PR in the first place.
 *
 * The grant covers only the repo's own files and comment: keys under
 * `gh/<owner>/<name>/` or one of the repo's `gh/private/<id>/` prefixes, and
 * the GitHub routes whose body or query names the repo, and the list of
 * galleries that reference the repo's PRs and issues. Everything else in
 * the workspace stays members-only.
 */
import type { Context } from "hono";
import { isEntitledToClaimRepo } from "./github-claim-authz";
import { findRepoLink } from "./github-repo-links";
import { repoForPrefixId } from "./github-private-prefixes";
import { dbFor } from "./db-session";

/** Scopes a collaborator grant can carry, intersected with the token's own. */
export const COLLABORATOR_SCOPES = ["files:read", "files:write"] as const;

/** GitHub routes a collaborator may call, all of which name the repo in their body. */
const COLLABORATOR_GITHUB_POSTS = new Set([
  "comment",
  "promote",
  "branch-rename",
  "private-prefix",
]);

const WRITE_ACCESS_TTL = 300;
const NO_ACCESS_TTL = 60;
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * Whether `userId`'s linked GitHub login can write to `repo`. Cached in
 * GITHUB_CACHE for 5 minutes (1 minute for a no), since every request on the
 * collaborator path asks.
 */
export async function hasRepoWriteAccess(
  env: Env,
  repo: string,
  userId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const key = `repo-write:${repo.toLowerCase()}:${userId}`;
  try {
    const cached = await env.GITHUB_CACHE?.get(key);
    if (cached === "1") return true;
    if (cached === "0") return false;
  } catch {
    // A cache miss.
  }
  const ok = await isEntitledToClaimRepo(env, repo, userId, fetchImpl);
  try {
    await env.GITHUB_CACHE?.put(key, ok ? "1" : "0", {
      expirationTtl: ok ? WRITE_ACCESS_TTL : NO_ACCESS_TTL,
    });
  } catch {
    // Uncached is fine.
  }
  return ok;
}

/**
 * The repo a file key (or a list prefix, which may end in `/` and stop at
 * the repo's folder) belongs to, or null outside every repo's prefix.
 */
async function repoForKey(env: Env, key: string, isPrefix = false): Promise<string | null> {
  const segments = (isPrefix ? key.replace(/\/$/, "") : key).split("/");
  if (segments[0] !== "gh" || segments.length < (isPrefix ? 3 : 4)) return null;
  if (segments.some((s) => s === "" || s === "." || s === "..")) return null;
  if (segments[1] === "private") {
    try {
      return await repoForPrefixId(dbFor(env), segments[2]!);
    } catch {
      return null;
    }
  }
  const repo = `${segments[1]}/${segments[2]}`;
  return REPO_RE.test(repo) ? repo : null;
}

function decodeSegment(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/**
 * The repo this request acts on, when it's one a collaborator may make, else
 * null. `rest` is the path after the workspace segment, still encoded.
 */
async function repoForRequest(c: Context, rest: string[]): Promise<string | null> {
  const method = c.req.method;
  const [section, ...tail] = rest;

  if (section === "files") {
    // List or held list, narrowed to a prefix inside the repo.
    if (method === "GET" && (tail.length === 0 || (tail.length === 1 && tail[0] === "held"))) {
      const prefix = c.req.query("prefix");
      return prefix ? repoForKey(c.env, prefix, true) : null;
    }
    // Upload, dry run, head, or metadata for one key.
    if ((method === "PUT" || method === "GET") && tail.length > 0) {
      const decoded = tail.map(decodeSegment);
      if (decoded.some((s) => s === null)) return null;
      return repoForKey(c.env, decoded.join("/"));
    }
    return null;
  }

  // Galleries that reference one of the repo's PRs or issues (the comment lists them).
  if (section === "galleries" && method === "GET" && tail.length === 1) {
    if (tail[0] !== "by-reference" || c.req.query("provider") !== "github") return null;
    return c.req.query("coordinate")?.split("#")[0] ?? null;
  }

  if (section === "github" && tail.length === 1) {
    if (method === "GET" && tail[0] === "repo-link") return c.req.query("repo") ?? null;
    if (method === "POST" && COLLABORATOR_GITHUB_POSTS.has(tail[0]!)) {
      // Hono caches the parsed body, so the route reads it again for free.
      const body = await c.req.json<unknown>().catch(() => null);
      const repo = (body as { repo?: unknown } | null)?.repo;
      return typeof repo === "string" ? repo : null;
    }
  }
  return null;
}

/**
 * Whether the request is a repo-scoped one that `userId` may make in
 * `workspace` as a GitHub collaborator: it touches only one repo's files or
 * comment, that repo is linked to `workspace`, and the user can write to it.
 */
export async function isRepoCollaboratorRequest(
  c: Context,
  userId: string,
  workspace: string,
): Promise<boolean> {
  const parts = c.req.path.split("/").filter(Boolean);
  // `/v1/<ws>/…` or `/v1/workspaces/<ws>/…`.
  const at = parts[1] === "workspaces" ? 3 : 2;
  if (parts[at - 1] !== workspace) return false;
  const repo = await repoForRequest(c, parts.slice(at));
  if (!repo || !REPO_RE.test(repo)) return false;
  const link = await findRepoLink(dbFor(c.env), repo);
  if (link?.workspaceName !== workspace) return false;
  return hasRepoWriteAccess(c.env, repo, userId);
}
