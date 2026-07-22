/**
 * `GET /public/github/avatars/:owner` — unauthenticated, edge-cached proxy
 * for a GitHub user/org avatar (repo owner from `gh.repo`).
 */
import { Hono } from "hono";
import { defaultAvatarCache, normalizeGithubOwner, resolveGithubAvatar } from "../github-avatars";
import type { WorkspaceVars } from "../workspace";

export const publicGithubAvatars = new Hono<WorkspaceVars>().get("/:owner", async (c) => {
  const owner = normalizeGithubOwner(c.req.param("owner"));
  if (!owner) {
    return new Response(null, {
      status: 400,
      headers: { "X-Content-Type-Options": "nosniff" },
    });
  }

  // Case-normalize so `BuildInternet` and `buildinternet` share one cache entry.
  const cacheUrl = new URL(c.req.url);
  cacheUrl.pathname = `/public/github/avatars/${owner}`;
  cacheUrl.search = "";

  return resolveGithubAvatar(owner, {
    cacheKeyUrl: cacheUrl.toString(),
    cache: defaultAvatarCache(),
  });
});
