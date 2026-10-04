/**
 * Signed-in Files views (spec .context/2026-10-04-pr-first-workspace-and-live-links.md):
 * `GET /:workspace/pulls`, `GET /:workspace/repos`, and (Task 6)
 * `GET /:workspace/scope/:owner/:repo/files`, mounted at `/v1/workspaces`.
 * Dual-auth (session or bearer), `files:read`, tight read limiter: each
 * request fans out into one D1 scope query per row for thumbnails.
 */
import { ValidationError } from "@uploads/errors";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { boundedDataRead } from "../data-read-bounds";
import { dbFor } from "../db-session";
import { dualWorkspaceAuth, type DualAuthVars } from "../dual-workspace-auth";
import { respondError } from "../error-response";
import {
  countPrivateScopeItems,
  feedItemUrl,
  feedUrl,
  hydrateFeedItems,
  unwrapFeedMutation,
} from "../feed-service";
import { findFeedByScope, normalizeFeedNumber, normalizeFeedRepo } from "../feeds";
import {
  backfillPrActivityState,
  countOpenPullsByRepo,
  getPrActivityRow,
  isPrState,
  listPrActivityPage,
  type PrState,
} from "../github-pr-activity";
import { parseFileTypeQuery } from "../file-type-sql";
import { linkedRepoSet } from "../github-repo-links";
import { resolveTitles, withPublicTitleBudget, type TitleInfo } from "../github-titles";
import {
  decodeScopeCursor,
  encodeScopeCursor,
  listWorkspaceRepos,
  prScopeQuery,
  scanScopeKeys,
  SCOPE_DEFAULT_LIMIT,
  SCOPE_MAX_LIMIT,
} from "../pr-scope";
import { heavyReadRateLimit } from "../read-limits";
import { toThumbItem } from "../scope-service";
import type { PullsResponse, ReposResponse, ScopeFilesResponse } from "../scope-wire";
import { storageConfig } from "../storage";
import { requireScope } from "../workspace";

const PULLS_DEFAULT_LIMIT = 20;
const PULLS_MAX_LIMIT = 100;
/** `/pulls` shows PRs with media in this many days unless `all=1`. */
export const PULLS_DEFAULT_WINDOW_DAYS = 90;
const REPOS_DEFAULT_LIMIT = 20;
/** `countOpenPullsByRepo` binds one parameter per repo; D1 allows 100 per query. */
const REPOS_MAX_LIMIT = 50;
const THUMBNAIL_LIMIT = 4;

function scoped(scope: Parameters<typeof requireScope>[0]): MiddlewareHandler<DualAuthVars> {
  return requireScope(scope) as unknown as MiddlewareHandler<DualAuthVars>;
}
const heavyRead = heavyReadRateLimit as unknown as MiddlewareHandler<DualAuthVars>;

function parseLimit(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined) return fallback;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > max) {
    throw new ValidationError(`limit must be an integer between 1 and ${max}.`, {
      code: "invalid_limit",
    });
  }
  return limit;
}

function parseState(raw: string | undefined): PrState | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (isPrState(raw)) return raw;
  throw new ValidationError("state must be open, closed, or merged.", { code: "invalid_state" });
}

/** `?all=1` opts out of the recency window; any other value keeps it. */
function pullsSince(all: string | undefined, now: number = Date.now()): string | undefined {
  if (all === "1") return undefined;
  return new Date(now - PULLS_DEFAULT_WINDOW_DAYS * 86_400_000).toISOString();
}

/** Lowercased `owner/repo`; 400 `feed_invalid_field` otherwise. */
function parseRepo(raw: string): string {
  return unwrapFeedMutation(normalizeFeedRepo(raw)).value;
}

/**
 * Signed-in title lookup for PR rows (member audience, #1065): private titles
 * resolve only for repos linked to this workspace; every other ref uses the
 * public ladder. Under the public title budget so a slow GitHub never stalls
 * the list (stored titles of linked repos fill in on timeout).
 */
async function resolvePullTitles(
  env: Env,
  refs: string[],
  linkedRepos: ReadonlySet<string>,
): Promise<Record<string, TitleInfo | null>> {
  if (refs.length === 0) return {};
  return (
    (await withPublicTitleBudget(resolveTitles(env, refs, { audience: "member", linkedRepos }))) ??
    {}
  );
}

export async function pullsHandler(c: Context<DualAuthVars>) {
  const workspace = c.get("workspaceName");
  const db = dbFor(c.env);
  const limit = parseLimit(c.req.query("limit"), PULLS_DEFAULT_LIMIT, PULLS_MAX_LIMIT);
  const state = parseState(c.req.query("state"));
  const repoParam = c.req.query("repo");
  const repo = repoParam ? parseRepo(repoParam) : undefined;
  // Narrows thumbnails only: a PR with no media of this type stays listed.
  const type = parseFileTypeQuery(c.req.query("type"));
  const cursor = decodeScopeCursor(c.req.query("cursor"));
  // Recency window instead of a row cap: only PRs with media in the last 90
  // days unless `all=1` (the Files list's "Show older pull requests").
  const since = pullsSince(c.req.query("all"));

  const page = await boundedDataRead(
    c,
    () => listPrActivityPage(db, workspace, { repo, state, since, cursor, limit }),
    { name: "d1_pulls_list" },
  );
  const linkedRepos = await linkedRepoSet(db, workspace);
  const titles = await resolvePullTitles(
    c.env,
    page.rows.map((row) => row.ref),
    linkedRepos,
  );
  // Every resolved title here came from the member audience built from this
  // workspace's own links, and the UPDATE is scoped to this workspace's rows.
  await backfillPrActivityState(
    db,
    workspace,
    page.rows.flatMap((row) => {
      const info = titles[row.ref];
      return info && (info.title !== row.title || info.state !== row.state)
        ? [{ ref: row.ref, title: info.title, state: info.state }]
        : [];
    }),
  );
  const thumbs = await boundedDataRead(
    c,
    () =>
      Promise.all(
        page.rows.map((row) =>
          prScopeQuery(db, {
            workspace,
            repo: row.repo,
            number: row.prNumber,
            type,
            limit: THUMBNAIL_LIMIT,
          }),
        ),
      ),
    { name: "d1_pulls_thumbs" },
  );
  const cfg = await storageConfig(c.env, c.get("workspace"));

  const response: PullsResponse = {
    workspace,
    pulls: page.rows.map((row, index) => {
      const info = titles[row.ref];
      return {
        ref: row.ref,
        repo: row.repo,
        number: row.prNumber,
        branch: row.branch,
        // A stored title may predate a link change or a repo going private,
        // or come from another workspace that owned the row: serve it only
        // when this workspace may see the repo's private titles.
        title: info?.title ?? (linkedRepos.has(row.repo) ? row.title : null),
        state: info?.state ?? row.state,
        lastMediaAt: row.lastMediaAt,
        thumbnails: (thumbs[index]?.items ?? []).map((item) => toThumbItem(c.env, cfg, item)),
      };
    }),
    nextCursor: page.nextCursor ? encodeScopeCursor(page.nextCursor) : null,
  };
  return c.json(response);
}

export async function reposHandler(c: Context<DualAuthVars>) {
  const workspace = c.get("workspaceName");
  const db = dbFor(c.env);
  const limit = parseLimit(c.req.query("limit"), REPOS_DEFAULT_LIMIT, REPOS_MAX_LIMIT);
  // Narrows thumbnails only: every repo with GitHub-tagged media stays listed.
  const type = parseFileTypeQuery(c.req.query("type"));
  const cursor = decodeScopeCursor(c.req.query("cursor"));

  const page = await boundedDataRead(
    c,
    () => listWorkspaceRepos(db, workspace, { cursor, limit }),
    { name: "d1_repos_list" },
  );
  const repos = page.repos.map((row) => row.repo);
  const [openCounts, thumbs] = await boundedDataRead(
    c,
    () =>
      Promise.all([
        countOpenPullsByRepo(db, workspace, repos),
        Promise.all(
          repos.map((repo) => prScopeQuery(db, { workspace, repo, type, limit: THUMBNAIL_LIMIT })),
        ),
      ]),
    { name: "d1_repos_detail" },
  );
  const cfg = await storageConfig(c.env, c.get("workspace"));

  const response: ReposResponse = {
    workspace,
    repos: page.repos.map((row, index) => ({
      repo: row.repo,
      lastUpdatedAt: row.lastUpdatedAt,
      openPullCount: openCounts.get(row.repo) ?? 0,
      thumbnails: (thumbs[index]?.items ?? []).map((item) => toThumbItem(c.env, cfg, item)),
    })),
    nextCursor: page.nextCursor ? encodeScopeCursor(page.nextCursor) : null,
  };
  return c.json(response);
}

/**
 * One scope's files (a PR when `number` is set, else the whole repo), newest
 * first, hydrated like a live link for the owner audience. Owner and repo
 * are lowercased before matching. `privateCount` runs on the first page only
 * and reuses the page's HEADs; `liveLink` is the existing feed for exactly
 * this scope; `pull` is this workspace's rollup row for the PR.
 */
export async function scopeFilesHandler(c: Context<DualAuthVars>) {
  const workspace = c.get("workspaceName");
  const record = c.get("workspace");
  const db = dbFor(c.env);
  const repo = parseRepo(`${c.req.param("owner") ?? ""}/${c.req.param("repo") ?? ""}`);
  // Positive integer or absent; anything else is a 400 (`scopeFrom` would
  // silently drop a bad value and widen the scope to the whole repo).
  const number = unwrapFeedMutation(normalizeFeedNumber(c.req.query("number"))).value;
  const type = parseFileTypeQuery(c.req.query("type"));
  const cursor = decodeScopeCursor(c.req.query("cursor"));
  const limit = parseLimit(c.req.query("limit"), SCOPE_DEFAULT_LIMIT, SCOPE_MAX_LIMIT);
  const scope = { workspace, repo, ...(number > 0 ? { number } : {}) };

  const [page, pullRow] = await boundedDataRead(
    c,
    () =>
      Promise.all([
        prScopeQuery(db, { ...scope, type, cursor, limit }),
        number > 0 ? getPrActivityRow(db, workspace, repo, number) : Promise.resolve(null),
      ]),
    { name: "d1_scope_files" },
  );
  const privateKeys = new Set<string>();
  const items = await hydrateFeedItems(c.env, record, page.items, {
    audience: "owner",
    privateKeys,
  });
  const feed = await findFeedByScope(db, workspace, repo, "", number);
  if (feed) {
    for (const item of items) item.pageUrl = feedItemUrl(c.env, feed.id, item.id);
  }

  // First page only: the share confirm reads it before the first copy.
  let privateCount: number | null = null;
  if (!cursor) {
    const pageIsWholeScope = page.nextCursor === null && type === undefined;
    const keys = pageIsWholeScope
      ? page.items.map((item) => item.key)
      : (await boundedDataRead(c, () => scanScopeKeys(db, scope), { name: "d1_scope_scan" })).map(
          (item) => item.key,
        );
    privateCount = await countPrivateScopeItems(c.env, record, keys, {
      checked: new Set(page.items.map((item) => item.key)),
      privateKeys,
    });
  }

  // Same rule as /pulls: a stored title is served only for a repo linked to
  // this workspace. Otherwise `pull.title` is null and the PR page resolves
  // it through the member titles route (public ladder for unlinked repos).
  const titleVisible = pullRow?.title != null && (await linkedRepoSet(db, workspace)).has(repo);

  const response: ScopeFilesResponse = {
    repo,
    number: number > 0 ? number : null,
    items,
    nextCursor: page.nextCursor ? encodeScopeCursor(page.nextCursor) : null,
    privateCount,
    liveLink: feed ? { id: feed.id, url: feedUrl(c.env, feed.id), source: feed.source } : null,
    pull: pullRow
      ? {
          branch: pullRow.branch,
          title: titleVisible ? pullRow.title : null,
          state: pullRow.state,
        }
      : null,
  };
  return c.json(response);
}

export const workspaceScope = new Hono<DualAuthVars>()
  .get("/:workspace/pulls", dualWorkspaceAuth(), heavyRead, scoped("files:read"), pullsHandler)
  .get("/:workspace/repos", dualWorkspaceAuth(), heavyRead, scoped("files:read"), reposHandler)
  .get(
    "/:workspace/scope/:owner/:repo/files",
    dualWorkspaceAuth(),
    heavyRead,
    scoped("files:read"),
    scopeFilesHandler,
  )
  .onError((err, c) => respondError(c, err));
