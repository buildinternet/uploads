import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { parseCommandArgs, type GlobalFlags } from "../cli-args.js";
import { resolveApiUrl } from "../config.js";
import { createMcpServer, MCP_SERVER_ICONS } from "../mcp/server.js";
import { createUploadsMcpTools } from "../mcp/tools.js";
import { packageVersion } from "../package-version.js";
import { writeCommandHelp } from "../cli-style.js";

const MCP_HELP = `uploads [globals] mcp

Serve the Model Context Protocol (MCP) over stdio for agent clients. Tools
mirror the CLI commands: put, attach, list, delete, usage, reconcile,
purge_expired, comment, whoami, doctor.
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
  // Ajv is the right provider here and only here: it compiles schemas at
  // runtime, which Node allows and workerd does not (apps/mcp passes the
  // `@cfworker/json-schema` provider instead).
  const validator = new AjvJsonSchemaValidator();
  const handle = serveStdio(() =>
    createMcpServer({
      serverInfo: { name: "uploads", version: packageVersion(), icons: MCP_SERVER_ICONS },
      tools: createUploadsMcpTools({ globals: opts.globals }),
      apiUrl: resolveApiUrl(opts.globals),
      validator,
    }),
  );
  // `serveStdio` hands back only a teardown handle, so the command owns the
  // wait: serving ends when the client closes our stdin, which is what the
  // previous readline loop returned on.
  await new Promise<void>((resolve) => {
    process.stdin.once("end", resolve);
    process.stdin.once("close", resolve);
  });
  await handle.close();
  return 0;
}
