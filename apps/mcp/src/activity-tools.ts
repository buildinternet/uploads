/**
 * Hosted reads of the Files views. Both tools call the same D1 queries the
 * signed-in pages use (`listPrActivityPage`, `listWorkspaceRepos`,
 * `prScopeQuery`) and skip the page decoration: thumbnail fan-out, live
 * GitHub titles, per-object HEAD, and the private-file scan.
 *
 * Rows are tagged files, not a bucket listing. `updatedAt` / `lastMediaAt`
 * are metadata times, not the object's `uploaded-at`. Neither tool creates
 * a public feed.
 */
import { fileTypeClassFromKey, parseFileTypeQuery } from "@uploads/api/file-type-sql";
import { normalizeFeedNumber, normalizeFeedPath, normalizeFeedRepo } from "@uploads/api/feeds";
import { unwrapFeedMutation } from "@uploads/api/feed-service";
import {
  listPrActivityPage,
  PULLS_DEFAULT_LIMIT,
  PULLS_DEFAULT_WINDOW_DAYS,
  PULLS_MAX_LIMIT,
  isPrState,
} from "@uploads/api/github-pr-activity";
import { linkedRepoSet } from "@uploads/api/github-repo-links";
import {
  decodeScopeCursor,
  encodeScopeCursor,
  listWorkspaceRepos,
  prScopeQuery,
  REPOS_DEFAULT_LIMIT,
  REPOS_MAX_LIMIT,
  SCOPE_DEFAULT_LIMIT,
  SCOPE_MAX_LIMIT,
  type ScopeCursor,
} from "@uploads/api/pr-scope";
import { objectPublicUrls, storageConfig } from "@uploads/api/storage";
import type { FileScope, WorkspaceRecord } from "@uploads/api/workspace";
import {
  mcpOAuthRead,
  mcpRead,
  optBool,
  optPosInt,
  optString,
  usage,
  type McpTool,
} from "@buildinternet/uploads/mcp";

const DAY_MS = 86_400_000;

interface ActivityToolContext {
  env: Env;
  workspace: WorkspaceRecord;
  workspaceName: string;
  requireScope: (scope: FileScope) => void;
}

function pageLimit(raw: number | undefined, fallback: number, max: number): number {
  if (raw === undefined) return fallback;
  if (raw > max) usage(`limit must be an integer between 1 and ${max}`);
  return raw;
}

function repoValue(raw: string): string {
  return unwrapFeedMutation(normalizeFeedRepo(raw)).value;
}

function cursorOut(cursor: ScopeCursor | null): string | null {
  return cursor ? encodeScopeCursor(cursor) : null;
}

/** `all: true` lifts the 90-day window. Any other value keeps it. */
function pullsSince(all: boolean, now = Date.now()): string | undefined {
  if (all) return undefined;
  return new Date(now - PULLS_DEFAULT_WINDOW_DAYS * DAY_MS).toISOString();
}

export function activityReadTools(ctx: ActivityToolContext): McpTool[] {
  const { env, workspace, workspaceName, requireScope } = ctx;

  return [
    {
      name: "list_activity",
      title: "List recent activity",
      annotations: mcpRead,
      securitySchemes: mcpOAuthRead,
      description:
        "Recent GitHub-tagged activity in this workspace, grouped by pull request (default) or by repo. " +
        "Pull rows are pull requests that received media tagged gh.kind=pull, newest last_media_at first. " +
        "The default window is 90 days. Set all to true to lift it. Optional repo and state (open, closed, or merged) narrow those rows. " +
        "A title is included only when the repo is linked to this workspace. " +
        "Repo rows are distinct gh.repo values, newest metadata updated_at first. " +
        "These times are not the object's uploaded-at. Untagged uploads are absent. This does not publish a feed. " +
        "Pass cursor back unchanged with the same arguments for the next page. " +
        "Use list_repo_files to open one repo's files, and find_files for tag or filename search in key order.",
      inputSchema: {
        type: "object",
        properties: {
          by: {
            type: "string",
            enum: ["pull", "repo"],
            description:
              'Group the page by pull request ("pull", the default) or by repository ("repo").',
          },
          repo: {
            type: "string",
            description:
              "When by is pull, keep rows for this owner/repo only. Ignored values are rejected when by is repo.",
          },
          state: {
            type: "string",
            enum: ["open", "closed", "merged"],
            description:
              "When by is pull, keep rows in this state. Rows with no stored state drop out. Rejected when by is repo.",
          },
          all: {
            type: "boolean",
            description:
              "When by is pull, include pull requests whose last media is older than 90 days. Default false. Rejected when by is repo.",
          },
          limit: {
            type: "number",
            description: "Page size. Pulls default to 20 (max 100). Repos default to 20 (max 50).",
          },
          cursor: {
            type: "string",
            description:
              "Opaque cursor from the previous page. Send it back with the same by, repo, state, and all.",
          },
        },
        additionalProperties: false,
        examples: [{ by: "pull", repo: "acme/widgets" }, { by: "repo" }],
      },
      async handler(args) {
        requireScope("files:read");
        const by = optString(args, "by") ?? "pull";
        if (by !== "pull" && by !== "repo") usage('by must be "pull" or "repo"');
        const repoArg = optString(args, "repo");
        const stateArg = optString(args, "state");
        const all = optBool(args, "all");
        if (by === "repo" && (repoArg !== undefined || stateArg !== undefined || all)) {
          usage("repo, state, and all apply only when by is pull");
        }
        const cursor = decodeScopeCursor(optString(args, "cursor"));
        if (by === "repo") {
          const page = await listWorkspaceRepos(env.DB, workspaceName, {
            cursor,
            limit: pageLimit(optPosInt(args, "limit"), REPOS_DEFAULT_LIMIT, REPOS_MAX_LIMIT),
          });
          return {
            by: "repo",
            repos: page.repos,
            cursor: cursorOut(page.nextCursor),
          };
        }
        const state = stateArg ? stateArg : undefined;
        if (state !== undefined && !isPrState(state)) {
          usage("state must be open, closed, or merged");
        }
        const [page, linked] = await Promise.all([
          listPrActivityPage(env.DB, workspaceName, {
            ...(repoArg ? { repo: repoValue(repoArg) } : {}),
            ...(state ? { state } : {}),
            since: pullsSince(all),
            cursor,
            limit: pageLimit(optPosInt(args, "limit"), PULLS_DEFAULT_LIMIT, PULLS_MAX_LIMIT),
          }),
          linkedRepoSet(env.DB, workspaceName),
        ]);
        return {
          by: "pull",
          pulls: page.rows.map((row) => ({
            ref: row.ref,
            repo: row.repo,
            number: row.prNumber,
            branch: row.branch,
            state: row.state,
            lastMediaAt: row.lastMediaAt,
            title: linked.has(row.repo) ? row.title : null,
          })),
          cursor: cursorOut(page.nextCursor),
        };
      },
    },
    {
      name: "list_repo_files",
      title: "List files in a repo",
      annotations: mcpRead,
      securitySchemes: mcpOAuthRead,
      description:
        "Files tagged with gh.repo for one repository, newest metadata updated_at first. That time is not the object's uploaded-at. " +
        "repo is owner/name. Optional pr matches gh.number. Optional path matches the path tag exactly. " +
        "type is a filename suffix class: screenshot, video, or other. PDFs are other. " +
        "Promoted copies (gh.status=promoted) are omitted. This does not publish a feed. " +
        "Pass cursor back unchanged with the same arguments for the next page.",
      inputSchema: {
        type: "object",
        properties: {
          repo: {
            type: "string",
            description: "GitHub repository as owner/name. Matching is case-insensitive.",
          },
          pr: {
            type: "number",
            description: "When set, keep files tagged with this pull-request number (gh.number).",
          },
          path: {
            type: "string",
            description: "When set, keep files whose path tag equals this string.",
          },
          type: {
            type: "string",
            enum: ["screenshot", "video", "other"],
            description:
              "Filename suffix class. screenshot is png/jpg/jpeg/webp/gif/avif, video is mp4/webm/mov, and other is everything else (including PDF).",
          },
          limit: {
            type: "number",
            description: "Page size (default 50, max 100).",
          },
          cursor: {
            type: "string",
            description:
              "Opaque cursor from the previous page. Send it back with the same repo, pr, path, and type.",
          },
        },
        required: ["repo"],
        additionalProperties: false,
        examples: [{ repo: "acme/widgets", type: "screenshot" }],
      },
      async handler(args) {
        requireScope("files:read");
        const rawRepo = optString(args, "repo");
        if (!rawRepo) usage("repo is required");
        const repo = repoValue(rawRepo);
        const pr = optPosInt(args, "pr");
        const number =
          pr === undefined ? undefined : unwrapFeedMutation(normalizeFeedNumber(pr)).value;
        const pathRaw = optString(args, "path");
        const path =
          pathRaw === undefined ? undefined : unwrapFeedMutation(normalizeFeedPath(pathRaw)).value;
        const type = parseFileTypeQuery(optString(args, "type"));
        const [cfg, page] = await Promise.all([
          storageConfig(env, workspace),
          prScopeQuery(env.DB, {
            workspace: workspaceName,
            repo,
            ...(number !== undefined ? { number } : {}),
            ...(path ? { path } : {}),
            ...(type ? { type } : {}),
            cursor: decodeScopeCursor(optString(args, "cursor")),
            limit: pageLimit(optPosInt(args, "limit"), SCOPE_DEFAULT_LIMIT, SCOPE_MAX_LIMIT),
          }),
        ]);
        return {
          items: page.items.map((item) => ({
            key: item.key,
            ...objectPublicUrls(env, cfg, item.key),
            updatedAt: item.updatedAt,
            path: item.metadata.path ?? null,
            state: item.metadata.state ?? null,
            kind: fileTypeClassFromKey(item.key),
          })),
          cursor: cursorOut(page.nextCursor),
        };
      },
    },
  ];
}
