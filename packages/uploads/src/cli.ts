import { createUploadsClient } from "./client.js";
import { resolveApiUrl, resolveConfig } from "./config.js";
import { UploadsError } from "./errors.js";
import {
  commandWorkspace,
  flagString,
  isHelpFlag,
  parseArgv,
  parseCommandArgs,
  UsageError,
} from "./cli-args.js";
import {
  runPut,
  runAttach,
  runList,
  runFind,
  runMeta,
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
import { runInvite } from "./commands/invite.js";
import { runAdmin } from "./commands/admin-enrollment.js";
import { runMcp } from "./commands/mcp.js";
import { runInstall } from "./commands/install.js";
import { packageVersion } from "./package-version.js";
import { maybeHintUpdate } from "./update-check.js";

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
  --quiet             Suppress stderr progress and update hints
  --version, -V       Print package version and exit

Commands:
  attach <file...>     Attach media to the current PR (stable URLs + managed comment)
  put <file>          Upload (+ URL + markdown for GitHub)
  gallery             Create and organize public media galleries
  comment             Create/update a PR/issue attachments comment (via gh)
  list                List objects (--meta k=v filters by queryable metadata)
  find k=v...         List objects matching metadata (alias for list --meta)
  meta                Get/set an object's queryable metadata
  delete <key>        Delete object
  usage               Workspace storage / upload counters
  reconcile           Rebuild usage ledger from storage
  purge-expired       Delete objects past retentionDays
  setup               Inspect/configure advanced CLI settings
  install             Install the agent skill + register the remote MCP server
  login               Sign in via browser (or an enrollment code) and save credentials
  invite              Invite a teammate to a workspace (workspace admin; device login)
  admin               Site-operator invitation management (ADMIN_TOKEN)
  config              Show path, init, or set shared config
  doctor              Health + auth + workspace checks
  health              API liveness (no auth)
  mcp                 Serve MCP over stdio (tools mirror the CLI)

Put/list defaults (config file or env):
  UPLOADS_DEFAULT_PREFIX, UPLOADS_DEFAULT_REPO, UPLOADS_DEFAULT_REF
  UPLOADS_DEFAULT_WIDTH, UPLOADS_NO_GIT

Update hints (stderr, once/day): silence with --quiet / UPLOADS_NO_UPDATE=1 / NO_UPDATE_NOTIFIER=1

Examples:
  uploads setup
  uploads setup --token up_default_… --repo myorg/myapp
  uploads attach ./before.png ./after.png
  uploads put ./shot.png --ref 42
  uploads gallery create --title "Release screenshots"
  uploads doctor
  uploads --version

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
      case "FILE_NOT_FOUND":
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

/** Effective stdout format, so failures surface where the caller reads output. */
type OutputFormat = "json" | "url" | "markdown" | "human";

/** Global `--json` wins; else put-style `--format`. Drives where failures print. */
export function outputFormat(argv: string[]): OutputFormat {
  const flags = parseCommandArgs(argv.slice(2)).flags;
  if (flags.has("--json")) return "json";
  const value = flagString(flags, "--format");
  if (value === "json" || value === "url" || value === "markdown") return value;
  return "human";
}

const QUOTA_HINT =
  "hint: run `uploads usage` then delete objects or raise limits (`pnpm workspace:limits`)\n";
const ERROR_HINTS: Partial<Record<UploadsError["code"], string>> = {
  STORAGE_QUOTA: QUOTA_HINT,
  UPLOAD_BUDGET: QUOTA_HINT,
  KEY_POLICY:
    "hint: use a typed destination (`--destination screenshots|gh`) or an allowed prefix; operators set allowlists with `pnpm workspace:limits --allowed-prefixes`\n",
  UNAUTHORIZED:
    "hint: token rejected — run `uploads login` to sign in again, or check UPLOADS_TOKEN / --token\n",
};

function errorOut(err: unknown, format: OutputFormat): void {
  const payload =
    err instanceof UploadsError
      ? { error: err.message, code: err.code, status: err.status }
      : err instanceof UsageError
        ? { error: err.message, code: "USAGE" }
        : { error: err instanceof Error ? err.message : String(err) };

  if (format === "json") {
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    return;
  }

  const msg = payload.error;

  // No token: onboarding nudge (no "error:" prefix). Exit stays non-zero; JSON keeps MISSING_TOKEN.
  if (err instanceof UploadsError && err.code === "MISSING_TOKEN") {
    process.stderr.write(`${msg}\n`);
    if (format === "url" || format === "markdown") {
      process.stdout.write("not signed in — run uploads login\n");
    }
    return;
  }

  if (msg.includes("\n")) process.stderr.write(`${msg}\n`);
  else process.stderr.write(`error: ${msg}\n`);

  if (err instanceof UploadsError) {
    const hint = ERROR_HINTS[err.code];
    if (hint) process.stderr.write(hint);
    else if (err.status === 413 || err.message.toLowerCase().includes("too large")) {
      process.stderr.write(
        "hint: file exceeds workspace size policy (images vs video may differ); compress or raise --max-upload-bytes / --max-video-bytes\n",
      );
    }
  }

  // Scripted formats often drop stderr — mirror a one-line reason on stdout.
  if (format === "url" || format === "markdown") {
    process.stdout.write(`error: ${msg.replace(/\s*\n\s*/g, " ")}\n`);
  }
}

/** Point agents at layered --help instead of dumping the full root manual. */
function usageHint(argv: string[]): void {
  try {
    const cmd = parseArgv(argv).command;
    process.stderr.write(cmd ? `hint: uploads ${cmd} --help\n` : "hint: uploads --help\n");
  } catch {
    process.stderr.write("hint: uploads --help\n");
  }
}

export async function runCli(argv: string[]): Promise<number> {
  try {
    const parsed = parseArgv(argv);
    const json = parsed.globals.json ?? false;
    const quiet = parsed.globals.quiet ?? false;

    if (parsed.globals.version) {
      process.stdout.write(`${packageVersion()}\n`);
      return 0;
    }

    if (!parsed.command) {
      process.stderr.write(ROOT_HELP);
      return parsed.help ? 0 : 2;
    }

    const cmdArgs = parsed.rest.slice(1);
    const showHelp = parsed.help || cmdArgs.some(isHelpFlag);
    let code: number;

    switch (parsed.command) {
      case "health":
        code = await runHealth({ apiUrl: resolveApiUrl(parsed.globals), json }, cmdArgs, showHelp);
        break;
      case "config":
        code = await runConfig(cmdArgs, { json, envFile: parsed.globals.envFile }, showHelp);
        break;
      case "setup":
        code = await runSetup(cmdArgs, { json, envFile: parsed.globals.envFile }, showHelp);
        break;
      case "login":
        code = await runLogin(cmdArgs, { json, apiUrl: resolveApiUrl(parsed.globals) }, showHelp);
        break;
      case "invite":
        code = await runInvite(cmdArgs, { json, apiUrl: resolveApiUrl(parsed.globals) }, showHelp);
        break;
      case "admin":
        code = await runAdmin(cmdArgs, { json, apiUrl: resolveApiUrl(parsed.globals) }, showHelp);
        break;
      case "mcp":
        code = await runMcp(cmdArgs, { globals: parsed.globals }, showHelp);
        break;
      case "install":
        code = await runInstall(cmdArgs, { globals: parsed.globals, json }, showHelp);
        break;
      case "attach":
      case "put":
      case "gallery":
      case "list":
      case "find":
      case "meta":
      case "delete":
      case "usage":
      case "reconcile":
      case "purge-expired":
      case "doctor":
      case "comment": {
        const ctx = createContext(parsed.globals, !showHelp, cmdArgs);
        switch (parsed.command) {
          case "attach":
            code = await runAttach(ctx, cmdArgs, showHelp);
            break;
          case "put":
            code = await runPut(ctx, cmdArgs, showHelp);
            break;
          case "gallery":
            code = await runGallery(ctx, cmdArgs, showHelp);
            break;
          case "comment":
            code = await runComment(ctx, cmdArgs, showHelp);
            break;
          case "list":
            code = await runList(ctx, cmdArgs, showHelp);
            break;
          case "find":
            code = await runFind(ctx, cmdArgs, showHelp);
            break;
          case "meta":
            code = await runMeta(ctx, cmdArgs, showHelp);
            break;
          case "delete":
            code = await runDelete(ctx, cmdArgs, showHelp);
            break;
          case "usage":
            code = await runUsage(ctx, cmdArgs, showHelp);
            break;
          case "reconcile":
            code = await runReconcile(ctx, cmdArgs, showHelp);
            break;
          case "purge-expired":
            code = await runPurgeExpired(ctx, cmdArgs, showHelp);
            break;
          case "doctor":
            code = await runDoctor(ctx, cmdArgs, showHelp);
            break;
        }
        break;
      }
      default:
        process.stderr.write(`unknown command: ${parsed.command}\n\n${ROOT_HELP}`);
        return 2;
    }

    // Best-effort; skipped for mcp, --quiet/--json, and opt-out env vars.
    if (code === 0 && !showHelp) {
      await maybeHintUpdate({ quiet: quiet || json, command: parsed.command });
    }
    return code;
  } catch (err) {
    const format = outputFormat(argv);
    errorOut(err, format);
    if (err instanceof UsageError && format !== "json") usageHint(argv);
    return exitCode(err);
  }
}
