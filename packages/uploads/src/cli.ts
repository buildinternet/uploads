import { createUploadsClient } from "./client.js";
import { resolveApiUrl, resolveConfig } from "./config.js";
import { UploadsError } from "./errors.js";
import {
  commandWorkspace,
  isHelpFlag,
  parseArgv,
  parseCommandArgs,
  UsageError,
} from "./cli-args.js";
import {
  runPut,
  runAttach,
  runList,
  runDelete,
  runHealth,
  runDoctor,
  runComment,
  runUsage,
  runReconcile,
  runPurgeExpired,
  runGallery,
  type CliContext,
} from "./commands.js";
import { runConfig } from "./commands/config.js";
import { runSetup } from "./commands/setup.js";
import { runLogin } from "./commands/login.js";
import { runAdmin } from "./commands/admin-enrollment.js";
import { runMcp } from "./commands/mcp.js";
import { runInstall } from "./commands/install.js";

const ROOT_HELP = `uploads — CLI for uploads.sh (GitHub image embeds)

Usage:
  uploads [globals] <command> [args]

Config (first match wins, per key):
  CLI flags           --api-url, --token, --workspace
  environment         UPLOADS_API_URL, UPLOADS_TOKEN, UPLOADS_WORKSPACE
  --env-file <path>
  $BUILDINTERNET_CONFIG
  ~/.config/buildinternet/config

Workspace (within config layers):
  --workspace, -w     override — global (before command) or per-command (after)
  UPLOADS_WORKSPACE   env / config file
  (else inferred from token up_<name>_…, else "default")

Other globals (before command):
  --api-url <url>     default: https://api.uploads.sh
  --token <token>     or UPLOADS_TOKEN
  --env-file <path>
  --json              JSON on stdout
  --quiet

Commands:
  attach <file...>     Attach media to the current PR (stable URLs + managed comment)
  put <file>          Upload (+ URL + markdown for GitHub)
  gallery             Create and organize public media galleries
  comment             Create/update a PR/issue attachments comment (via gh)
  list                List objects
  delete <key>        Delete object
  usage               Workspace storage / upload counters
  reconcile           Rebuild usage ledger from storage
  purge-expired       Delete objects past retentionDays
  setup               Inspect/configure advanced CLI settings
  install             Install the agent skill + register the remote MCP server
  login               Exchange an enrollment code and configure credentials
  admin               Admin invitation management
  config              Show path, init, or set shared config
  doctor              Health + auth + workspace checks
  health              API liveness (no auth)
  mcp                 Serve MCP over stdio (tools mirror the CLI)

Put/list defaults (config file or env):
  UPLOADS_DEFAULT_PREFIX, UPLOADS_DEFAULT_REPO, UPLOADS_DEFAULT_REF
  UPLOADS_DEFAULT_WIDTH, UPLOADS_NO_GIT

Examples:
  uploads setup
  uploads setup --token up_default_… --repo myorg/myapp
  uploads attach ./before.png ./after.png
  uploads put ./shot.png --ref 42
  uploads gallery create --title "Release screenshots"
  uploads doctor

Agent/MCP: \`uploads install\` sets up the agent skill and the hosted MCP server
(https://agents.uploads.sh/mcp, workspace inferred from the token). Run
\`uploads mcp\` for local stdio, or use createUploadsWorkerFileTools()
from @buildinternet/uploads/agent on the Worker.
`;

function createContext(
  globals: ReturnType<typeof parseArgv>["globals"],
  requireToken: boolean,
  commandArgs: string[],
): CliContext {
  const cmdWorkspace = commandWorkspace(parseCommandArgs(commandArgs).flags);
  const config = resolveConfig({
    apiUrl: globals.apiUrl,
    workspace: cmdWorkspace ?? globals.workspace,
    token: globals.token,
    envFile: globals.envFile,
    requireToken,
  });
  return {
    config,
    client: createUploadsClient(config),
    json: globals.json ?? false,
    quiet: globals.quiet ?? false,
    envFile: globals.envFile,
  };
}

function exitCode(err: unknown): number {
  if (err instanceof UsageError) return 2;
  if (err instanceof UploadsError) {
    switch (err.code) {
      case "MISSING_TOKEN":
      case "USAGE":
        return 2;
      case "UNAUTHORIZED":
      case "NOT_FOUND":
      case "KEY_POLICY":
      case "STORAGE_QUOTA":
      case "UPLOAD_BUDGET":
        return 3;
      case "NETWORK":
        return 4;
      default:
        return 1;
    }
  }
  return 1;
}

function errorOut(err: unknown, json: boolean): void {
  const payload =
    err instanceof UploadsError
      ? { error: err.message, code: err.code, status: err.status }
      : err instanceof UsageError
        ? { error: err.message, code: "USAGE" }
        : { error: err instanceof Error ? err.message : String(err) };
  if (json) process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  else {
    const msg = payload.error;
    if (msg.includes("\n")) process.stderr.write(`${msg}\n`);
    else process.stderr.write(`error: ${msg}\n`);
    if (err instanceof UploadsError) {
      if (err.code === "STORAGE_QUOTA" || err.code === "UPLOAD_BUDGET") {
        process.stderr.write(
          "hint: run `uploads usage` then delete objects or raise limits (`pnpm workspace:limits`)\n",
        );
      } else if (err.code === "KEY_POLICY") {
        process.stderr.write(
          "hint: use a typed destination (`--destination screenshots|gh`) or an allowed prefix; operators set allowlists with `pnpm workspace:limits --allowed-prefixes`\n",
        );
      } else if (err.status === 413 || err.message.toLowerCase().includes("too large")) {
        process.stderr.write(
          "hint: file exceeds workspace size policy (images vs video may differ); compress or raise --max-upload-bytes / --max-video-bytes\n",
        );
      }
    }
  }
}

export async function runCli(argv: string[]): Promise<number> {
  try {
    const parsed = parseArgv(argv);
    const json = parsed.globals.json ?? false;

    if (!parsed.command) {
      process.stderr.write(ROOT_HELP);
      return parsed.help ? 0 : 2;
    }

    const cmdArgs = parsed.rest.slice(1);
    const showHelp = parsed.help || cmdArgs.some(isHelpFlag);

    switch (parsed.command) {
      case "health":
        return runHealth({ apiUrl: resolveApiUrl(parsed.globals), json }, cmdArgs, showHelp);
      case "config":
        return runConfig(cmdArgs, { json, envFile: parsed.globals.envFile }, showHelp);
      case "setup":
        return runSetup(cmdArgs, { json, envFile: parsed.globals.envFile }, showHelp);
      case "login":
        return runLogin(cmdArgs, { json, apiUrl: resolveApiUrl(parsed.globals) }, showHelp);
      case "admin":
        return runAdmin(cmdArgs, { json, apiUrl: resolveApiUrl(parsed.globals) }, showHelp);
      case "mcp":
        return runMcp(cmdArgs, { globals: parsed.globals }, showHelp);
      case "install":
        return runInstall(cmdArgs, { globals: parsed.globals, json }, showHelp);
      case "attach":
      case "put":
      case "gallery":
      case "list":
      case "delete":
      case "usage":
      case "reconcile":
      case "purge-expired":
      case "doctor":
      case "comment": {
        const ctx = createContext(parsed.globals, !showHelp, cmdArgs);
        switch (parsed.command) {
          case "attach":
            return runAttach(ctx, cmdArgs, showHelp);
          case "put":
            return runPut(ctx, cmdArgs, showHelp);
          case "gallery":
            return runGallery(ctx, cmdArgs, showHelp);
          case "comment":
            return runComment(ctx, cmdArgs, showHelp);
          case "list":
            return runList(ctx, cmdArgs, showHelp);
          case "delete":
            return runDelete(ctx, cmdArgs, showHelp);
          case "usage":
            return runUsage(ctx, cmdArgs, showHelp);
          case "reconcile":
            return runReconcile(ctx, cmdArgs, showHelp);
          case "purge-expired":
            return runPurgeExpired(ctx, cmdArgs, showHelp);
          case "doctor":
            return runDoctor(ctx, cmdArgs, showHelp);
        }
      }
      default:
        process.stderr.write(`unknown command: ${parsed.command}\n\n${ROOT_HELP}`);
        return 2;
    }
  } catch (err) {
    errorOut(err, argv.includes("--json"));
    if (err instanceof UsageError && !argv.includes("--json"))
      process.stderr.write(`\n${ROOT_HELP}`);
    return exitCode(err);
  }
}
