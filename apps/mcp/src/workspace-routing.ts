/**
 * Per-call workspace choice for the hosted MCP. An OAuth token on `/mcp`
 * carries every workspace its user belongs to (`workspaces` claim), but the
 * request authenticates as the default one (picked at consent, else the oldest membership). A call
 * moves to another of those workspaces when it names one with `workspace`,
 * or when its `repo` is bound to one, so a person in two workspaces gets
 * the right one per repo without a second connector.
 *
 * `up_` tokens, the `/<workspace>/mcp` route and single-workspace users have
 * no `choices`: their tools are left as they were, with no `workspace` argument.
 */
import { usage, type McpTool } from "@buildinternet/uploads/mcp";
import { findRepoLink } from "@uploads/api/github-repo-binding";
import { loadWorkspaceRecord, type WorkspaceRecord } from "@uploads/api/workspace";

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/** `owner/name` from `repo`, or from `feed_create`'s `github` (`owner/name#1` or a github.com URL). */
export function repoFromArgs(args: Record<string, unknown>): string | null {
  if (typeof args.repo === "string" && REPO_RE.test(args.repo)) return args.repo;
  if (typeof args.github !== "string") return null;
  const match = /^(?:https:\/\/github\.com\/)?([\w.-]+\/[\w.-]+?)(?:#|\/|$)/.exec(args.github);
  return match ? match[1]! : null;
}

export const WORKSPACE_ARG_SCHEMA = {
  type: "string",
  description:
    "Workspace to act in, when you belong to more than one (`whoami` lists them). Omit it: a call with `repo` uses the workspace that repo is linked to, otherwise your default.",
} as const;

/**
 * Which workspace a call runs in. An explicit `requested` must be one this
 * connection may use. Without one, `repoWorkspace` (the repo's bound
 * workspace) wins when the user belongs to it; otherwise the default.
 */
export function chooseWorkspace(opts: {
  defaultName: string;
  choices: readonly string[] | undefined;
  requested?: string;
  repoWorkspace?: string | null;
}): string {
  const { defaultName, choices, requested, repoWorkspace } = opts;
  const allowed = choices ?? [defaultName];
  if (requested !== undefined) {
    if (allowed.includes(requested)) return requested;
    usage(
      choices
        ? `you are not a member of workspace "${requested}"; this connection can use: ${allowed.join(", ")}`
        : `this token only acts in workspace "${defaultName}"`,
    );
  }
  if (choices && repoWorkspace && choices.includes(repoWorkspace)) return repoWorkspace;
  return defaultName;
}

/**
 * Wraps each tool so a call can run in another workspace: adds the optional
 * `workspace` argument and, when the chosen workspace differs from the
 * default, runs the same tool built for that workspace via `toolsFor`.
 */
export function withWorkspaceRouting(
  tools: McpTool[],
  opts: {
    env: Env;
    defaultName: string;
    choices: readonly string[] | undefined;
    toolsFor: (record: WorkspaceRecord, name: string) => McpTool[];
  },
): McpTool[] {
  // One workspace: nothing to choose, so keep the schemas (and tools/list) as they were.
  if (!opts.choices || opts.choices.length < 2) return tools;
  return tools.map((tool) => {
    const schema = tool.inputSchema as { properties?: Record<string, unknown> };
    if (!schema.properties || "workspace" in schema.properties) return tool;
    return {
      ...tool,
      inputSchema: {
        ...tool.inputSchema,
        properties: { ...schema.properties, workspace: WORKSPACE_ARG_SCHEMA },
      },
      async handler(args) {
        const { workspace: requested, ...rest } = args;
        if (requested !== undefined && typeof requested !== "string") {
          usage("workspace must be a string");
        }
        const repo = repoFromArgs(rest);
        // Only look the repo up when the answer could move the call.
        const repoWorkspace =
          requested === undefined && repo
            ? ((await findRepoLink(opts.env.DB, repo))?.workspaceName ?? null)
            : null;
        const target = chooseWorkspace({
          defaultName: opts.defaultName,
          choices: opts.choices,
          requested,
          repoWorkspace,
        });
        if (target === opts.defaultName) return tool.handler(rest);
        const record = await loadWorkspaceRecord(opts.env, target);
        if (!record) usage(`workspace "${target}" no longer exists`);
        const routed = opts.toolsFor(record, target).find((t) => t.name === tool.name);
        if (!routed) usage(`${tool.name} is not available in workspace "${target}"`);
        return routed.handler(rest);
      },
    };
  });
}
