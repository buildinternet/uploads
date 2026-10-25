import {
  mcpOAuthRead,
  mcpRead,
  optPosInt,
  optString,
  usage,
  type McpTool,
} from "@buildinternet/uploads/mcp";
import { searchFilesByNameAndMeta } from "@uploads/api/file-search";
import { hydrateFeedItems } from "@uploads/api/feed-service";
import { listStagedScopes } from "@uploads/api/staged-scopes";
import type { FileScope, WorkspaceRecord } from "@uploads/api/workspace";
import { stagedMediaResponse, stagedMediaOutputSchemas } from "./staged-media-response";
import { mediaPr, mediaScope, resolveMediaContext } from "./media-context";

interface StagedToolContext {
  env: Env;
  workspace: WorkspaceRecord;
  workspaceName: string;
  requireScope: (scope: FileScope) => void;
}

function limitValue(args: Record<string, unknown>, fallback: number, maximum: number): number {
  const limit = optPosInt(args, "limit") ?? fallback;
  if (limit > maximum) usage(`limit must be an integer between 1 and ${maximum}`);
  return limit;
}

export function stagedMediaReadTools(ctx: StagedToolContext): McpTool[] {
  const { env, workspace, workspaceName, requireScope } = ctx;
  return [
    {
      name: "list_staged_media",
      title: "Staged media",
      annotations: mcpRead,
      securitySchemes: mcpOAuthRead,
      description:
        "Read staged media for one explicit repository and branch in the connected workspace. " +
        "Read the current checkout's Git remote and branch before calling; the hosted server cannot infer them. " +
        "Repository and branch match stored lowercase metadata. Excludes promoted and unstaged files. " +
        "Private, held, missing, and unsupported previews are placeholders. Pass cursor unchanged with the same scope to load more; " +
        "a non-null cursor means more pages even if this page is empty. Results use object-key order, not newest-first.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["repo", "branch"],
        properties: {
          repo: { type: "string", description: "Explicit GitHub repository owner/name." },
          branch: {
            type: "string",
            description: "Explicit Git branch, for example feature/settings.",
          },
          cursor: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 50 },
        },
      },
      outputSchema: stagedMediaOutputSchemas.list_staged_media,
      async handler(args) {
        requireScope("files:read");
        const { repo, branch } = mediaScope(args);
        const page = await searchFilesByNameAndMeta(env, workspace, workspaceName, {
          filters: {
            "gh.repo": repo,
            "gh.kind": "branch",
            "gh.branch": branch,
            "gh.status": "staged",
          },
          pageSize: limitValue(args, 24, 50),
          cursor: optString(args, "cursor"),
        });
        const hydrated = await hydrateFeedItems(
          env,
          { ...workspace, name: workspaceName },
          page.matches,
          { audience: "public", requirePublicUrls: false },
        );
        return stagedMediaResponse(
          { repo, branch },
          hydrated,
          new Map(page.matches.map((match) => [match.key, match.metadata])),
          page.cursor,
        );
      },
    },
    {
      name: "resolve_media_context",
      title: "Resolve media context",
      annotations: mcpRead,
      securitySchemes: mcpOAuthRead,
      description:
        "Resolve the pull request for one explicit repository and branch. Pass the current PR number when known. " +
        "Otherwise look up one open same-repository PR only when the repository is linked to this workspace. " +
        "An unavailable resolution requires an explicit PR number; it does not mean that the PR has no attached files.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["repo", "branch"],
        properties: {
          repo: { type: "string" },
          branch: { type: "string" },
          pr: { type: "integer", minimum: 1 },
        },
      },
      outputSchema: stagedMediaOutputSchemas.resolve_media_context,
      async handler(args) {
        requireScope("files:read");
        return resolveMediaContext(env, workspaceName, args);
      },
    },
    {
      name: "list_attached_media",
      title: "Attached media",
      annotations: mcpRead,
      securitySchemes: mcpOAuthRead,
      description:
        "Read media attached to one explicit repository and PR in the connected workspace. " +
        "Pass the displayed branch as context. PR membership uses repository and PR number, " +
        "including direct attachments without branch tags. Private and held files remain placeholders. " +
        "Continue with the returned cursor and the same repository and PR; never combine PRs.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["repo", "branch", "pr"],
        properties: {
          repo: { type: "string" },
          branch: { type: "string" },
          pr: { type: "integer", minimum: 1 },
          cursor: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 50 },
        },
      },
      outputSchema: stagedMediaOutputSchemas.list_attached_media,
      async handler(args) {
        requireScope("files:read");
        const { repo, branch } = mediaScope(args);
        const pr = mediaPr(args);
        if (pr === undefined) usage("pr must be an explicit positive pull-request number");
        const page = await searchFilesByNameAndMeta(env, workspace, workspaceName, {
          filters: { "gh.repo": repo, "gh.kind": "pull", "gh.number": String(pr) },
          pageSize: limitValue(args, 24, 50),
          cursor: optString(args, "cursor"),
        });
        const hydrated = await hydrateFeedItems(
          env,
          { ...workspace, name: workspaceName },
          page.matches,
          { audience: "public", requirePublicUrls: false },
        );
        return {
          ...stagedMediaResponse(
            { repo, branch },
            hydrated,
            new Map(page.matches.map((match) => [match.key, match.metadata])),
            page.cursor,
          ),
          pr,
        };
      },
    },
    {
      name: "list_staged_scopes",
      title: "List staged branches",
      annotations: mcpRead,
      securitySchemes: mcpOAuthRead,
      description:
        "List distinct repository/branch pairs with staged files in the connected workspace. " +
        "Use an explicit pair with list_staged_media; never combine different branches. " +
        "Results use repository/branch order. Pass cursor unchanged for the next page.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          cursor: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 200 },
        },
      },
      outputSchema: stagedMediaOutputSchemas.list_staged_scopes,
      async handler(args) {
        requireScope("files:read");
        return listStagedScopes(env, workspaceName, {
          cursor: optString(args, "cursor"),
          limit: limitValue(args, 100, 200),
        });
      },
    },
  ];
}
