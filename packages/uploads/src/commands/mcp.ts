import { parseCommandArgs, type GlobalFlags } from "../cli-args.js";
import { resolveApiUrl } from "../config.js";
import { createMcpServer } from "../mcp/server.js";
import { serveStdio } from "../mcp/stdio.js";
import { createUploadsMcpTools } from "../mcp/tools.js";
import { packageVersion } from "../package-version.js";
import { writeCommandHelp } from "../cli-style.js";

const MCP_HELP = `uploads [globals] mcp

Serve the Model Context Protocol (MCP) over stdio for agent clients. Tools
mirror the CLI commands: put, attach, list, delete, usage, reconcile,
purge_expired, comment, health, doctor.
Global flags before "mcp" (--api-url, --token, --workspace, --env-file)
configure every tool call; a per-call "workspace" argument overrides
--workspace, like the CLI's per-command flag.

Example MCP client config:
  {
    "command": "uploads",
    "args": ["--env-file", "/path/.env", "mcp"]
  }

Examples:
  uploads --env-file .env mcp
  uploads --token up_default_… mcp
`;

export async function runMcp(
  args: string[],
  opts: { globals: GlobalFlags },
  help = false,
): Promise<number> {
  if (help || parseCommandArgs(args).help) {
    writeCommandHelp(MCP_HELP);
    return 0;
  }
  const server = createMcpServer({
    serverInfo: { name: "uploads", version: packageVersion() },
    tools: createUploadsMcpTools({ globals: opts.globals }),
    apiUrl: resolveApiUrl(opts.globals),
  });
  await serveStdio(server);
  return 0;
}
