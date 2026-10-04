/**
 * Local `gh` fallback parity with the server's `applyPrFeedPageUrls`
 * (apps/api/src/github-comment.ts): ensure the PR/issue live link exists
 * (idempotent create, the same call `uploads feed create --pr` makes), point
 * every item whose OWN metadata is in the feed's scope at `/c/<id>/<item>`,
 * and return the live link URL for the comment's header line.
 *
 * Sends no `source` (the API ignores one anyway): bearer-created feeds are
 * `user`, and PR/issue-scoped feeds are uncapped (only repo-scoped user feeds
 * cap, at 50, and the fallback never creates one). Any failure (older
 * server, network) returns null and leaves every pageUrl
 * untouched, so the comment renders exactly as it did before live links.
 */
import type { CreateFeedOptions, Feed } from "./client.js";
import { feedItemIdFor, isInFeedScope } from "./comment-render-scope.generated.js";
import type { AttachmentItem, GhTarget } from "./github.js";

export interface LocalFeedClient {
  createFeed(opts: CreateFeedOptions): Promise<Feed>;
}

export async function applyLocalFeedLinks(
  client: Partial<LocalFeedClient>,
  target: GhTarget,
  items: AttachmentItem[],
  metadataByKey: ReadonlyMap<string, Record<string, string>>,
): Promise<string | null> {
  if (items.length === 0 || typeof client.createFeed !== "function") return null;
  let feed: Feed;
  try {
    feed = await client.createFeed({
      repo: target.repo,
      ...(target.kind === "pull" ? { pr: target.num } : { issue: target.num }),
    });
  } catch {
    return null;
  }
  // A PR/issue create never carries a path; anything else is not this scope.
  // An unexpected shape (older server) degrades instead of throwing.
  if (!feed?.url || typeof feed.repo !== "string" || feed.path) return null;
  const scope = {
    repo: feed.repo.toLowerCase(),
    ...(feed.number ? { number: feed.number } : {}),
  };
  const base = feed.url.replace(/\/+$/, "");
  const pageUrls = await Promise.all(
    items.map(async (item) => {
      const meta = metadataByKey.get(item.key);
      if (!meta || !isInFeedScope(meta, scope)) return null;
      return `${base}/${encodeURIComponent(await feedItemIdFor(item.key))}`;
    }),
  );
  items.forEach((item, index) => {
    const pageUrl = pageUrls[index];
    if (pageUrl) item.pageUrl = pageUrl;
  });
  return feed.url;
}
