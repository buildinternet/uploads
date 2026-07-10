import { createRequire } from "node:module";
import { parseCommandArgs, type GlobalFlags } from "../cli-args.js";
import { createMcpServer } from "../mcp/server.js";
import { serveStdio } from "../mcp/stdio.js";
import { createUploadsMcpTools } from "../mcp/tools.js";

const MCP_HELP = `uploads [globals] mcp

Serve the Model Context Protocol (MCP) over stdio for agent clients. Tools
mirror the CLI commands: put, attach, list, delete, comment, health, doctor.
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

// Same relative depth from src/commands/ and dist/commands/, so this works
// both under vitest (src) and at runtime (dist).
const { version } = createRequire(import.meta.url)("../../package.json") as { version: string };

export async function runMcp(
  args: string[],
  opts: { globals: GlobalFlags },
  help = false,
): Promise<number> {
  if (help || parseCommandArgs(args).help) {
    process.stderr.write(MCP_HELP);
    return 0;
  }
  const server = createMcpServer({
    serverInfo: { name: "uploads", version },
    tools: createUploadsMcpTools({ globals: opts.globals }),
  });
  await serveStdio(server);
  return 0;
}
