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
  runList,
  runDelete,
  runHealth,
  runDoctor,
  runComment,
  type CliContext,
} from "./commands.js";

const ROOT_HELP = `uploads — CLI for uploads.sh (GitHub image embeds)

Usage:
  uploads [globals] <command> [args]

Workspace (first match wins):
  --workspace, -w     override — global (before command) or per-command (after)
  UPLOADS_WORKSPACE   env / --env-file
  (else inferred from token up_<name>_…, else "default")

Other globals (before command):
  --api-url <url>     default: https://api.uploads.sh
  --token <token>     or UPLOADS_TOKEN
  --env-file <path>
  --json              JSON on stdout
  --quiet

Commands:
  put <file>          Upload (+ URL + markdown for GitHub)
  comment             Create/update a PR/issue attachments comment (via gh)
  list                List objects
  delete <key>        Delete object
  doctor              Health + auth + workspace checks
  health              API liveness (no auth)

Examples:
  uploads --env-file .env put ./shot.png --repo myorg/myapp --ref 42
  uploads put ./shot.png --workspace acme
  uploads --workspace buildinternet --env-file .env doctor

Agent/MCP: use createUploadsWorkerFileTools() from @buildinternet/uploads/agent on the Worker.
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
  else process.stderr.write(`error: ${payload.error}\n`);
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
        return runHealth(
          { apiUrl: resolveApiUrl(parsed.globals), json },
          cmdArgs,
          showHelp,
        );
      case "put":
      case "list":
      case "delete":
      case "doctor":
      case "comment": {
        const ctx = createContext(parsed.globals, !showHelp, cmdArgs);
        switch (parsed.command) {
          case "put":
            return runPut(ctx, cmdArgs, showHelp);
          case "comment":
            return runComment(ctx, cmdArgs, showHelp);
          case "list":
            return runList(ctx, cmdArgs, showHelp);
          case "delete":
            return runDelete(ctx, cmdArgs, showHelp);
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
    if (err instanceof UsageError && !argv.includes("--json")) process.stderr.write(`\n${ROOT_HELP}`);
    return exitCode(err);
  }
  return 1;
}