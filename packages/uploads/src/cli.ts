import { createUploadsClient } from "./client.js";
import { DEFAULT_API_URL, resolveApiUrl, resolveConfig } from "./config.js";
import { UploadsError } from "./errors.js";
import {
  commandWorkspace,
  flagString,
  isHelpFlag,
  parseArgv,
  parseCommandArgs,
  UsageError,
} from "./cli-args.js";
import { formatRootHelp, wantsFullHelp } from "./cli-help.js";
import { colorEnabled, createStyle } from "./cli-style.js";
import {
  runPut,
  runAttach,
  runStaged,
  runList,
  runFind,
  runMeta,
  runDelete,
  runHealth,
  runDoctor,
  runComment,
  runGithub,
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
import { runCompletion } from "./commands/completion.js";
import { runLogout, runWhoami } from "./commands/session.js";
import { runTelemetry } from "./commands/telemetry.js";
import { runReport } from "./commands/report.js";
import { runScreenshot } from "./commands/screenshot.js";
import { packageVersion } from "./package-version.js";
import { checkForUpdate, maybeHintUpdate } from "./update-check.js";
import { maybeSyncSessionCliVersion } from "./session-cli-version.js";
import {
  errorCodeFromUnknown,
  maybeShowFirstRunNotice,
  recordEvent,
  telemetryCommandName,
} from "./telemetry.js";

async function writeRootHelp(
  options: {
    full?: boolean;
    /** Forwarded so token detection honors --token / --env-file. */
    token?: string;
    envFile?: string;
  } = {},
): Promise<void> {
  // Best-effort version check so the help header can show a banner when outdated.
  // Short timeout; cache still applies (once/day). Never blocks help on network.
  const update = await checkForUpdate({ timeoutMs: 800 });
  // Empty token (and no env/config) → first-run auth banner.
  let needsAuth = true;
  try {
    const cfg = resolveConfig({
      requireToken: false,
      token: options.token,
      envFile: options.envFile,
    });
    needsAuth = !cfg.token;
  } catch {
    needsAuth = true;
  }
  process.stderr.write(
    formatRootHelp({
      full: options.full,
      version: update.current,
      latestVersion: update.updateAvailable ? update.latest : undefined,
      needsAuth,
    }),
  );
}

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
      case "BROWSER_NOT_FOUND":
        return 2;
      case "NETWORK":
      // Transient — same "retry, don't reconfigure" family as a network
      // hiccup, not an auth/policy/budget denial (those are exit 3).
      case "RATE_LIMITED":
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
  INSUFFICIENT_SCOPE:
    "hint: re-run `uploads login` for a full-scope token (or mint one with --scopes)\n",
  BROWSER_NOT_FOUND:
    "hint: no local browser found; try --via remote, or install Chrome / npx playwright install chromium\n",
  RATE_LIMITED: "hint: transient rate limit — wait ~60s and retry\n",
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
  const telemetryStart = Date.now();
  const telemetryCmd = telemetryCommandName(argv);
  // Prefer --api-url from argv early so every exit path can pass it to telemetry.
  let apiUrl = DEFAULT_API_URL;
  try {
    apiUrl = resolveApiUrl(parseArgv(argv).globals);
  } catch {
    // Usage errors while parsing globals fall through to the main try/catch.
  }

  const skipTelemetry =
    argv.includes("--version") ||
    argv.includes("-V") ||
    telemetryCmd === "telemetry" ||
    telemetryCmd.startsWith("telemetry ") ||
    // Report is itself a deliberate submit; skip the automatic usage ping.
    telemetryCmd === "report";

  // One-time notice for interactive humans (never MCP / json / quiet).
  if (!skipTelemetry) {
    const wantsQuiet = argv.includes("--json") || argv.includes("--quiet") || argv[2] === "mcp";
    maybeShowFirstRunNotice({ interactive: wantsQuiet ? false : undefined });
  }

  const flushTelemetry = (code: number, err?: unknown): void => {
    if (skipTelemetry) return;
    // Long-lived MCP process: per-tool events come from the MCP server; skip
    // a process-level "mcp" ping so we don't double-count or hang exit.
    if (telemetryCmd === "mcp") return;
    recordEvent(
      {
        surface: "cli",
        command: telemetryCmd,
        exitCode: code,
        durationMs: Date.now() - telemetryStart,
        errorCode: err !== undefined ? errorCodeFromUnknown(err) : undefined,
      },
      { apiUrl },
    );
  };

  try {
    const parsed = parseArgv(argv);
    const json = parsed.globals.json ?? false;
    const quiet = parsed.globals.quiet ?? false;
    apiUrl = resolveApiUrl(parsed.globals);

    // Refresh session.cliVersion when the installed package changes (no-op without a session token).
    if (parsed.command && parsed.command !== "login" && parsed.command !== "logout") {
      maybeSyncSessionCliVersion({ apiUrl, envFile: parsed.globals.envFile });
    }

    if (parsed.globals.version) {
      process.stdout.write(`${packageVersion()}\n`);
      return 0;
    }

    // Root help: bare `uploads`, `--help`/`-h`, or `help` / `help --all`.
    const isHelpCommand = parsed.command === "help";
    if (!parsed.command || isHelpCommand) {
      const helpArgs = isHelpCommand ? parsed.rest.slice(1) : parsed.rest;
      const full = Boolean(parsed.globals.all) || wantsFullHelp(helpArgs);
      await writeRootHelp({
        full,
        token: parsed.globals.token,
        envFile: parsed.globals.envFile,
      });
      // Explicit help exits 0; bare `uploads` is usage → 2.
      const code = parsed.help || isHelpCommand ? 0 : 2;
      flushTelemetry(code);
      return code;
    }

    const cmdArgs = parsed.rest.slice(1);
    const showHelp = parsed.help || cmdArgs.some(isHelpFlag);
    let code: number;

    switch (parsed.command) {
      case "health":
        code = await runHealth({ apiUrl, json }, cmdArgs, showHelp);
        break;
      case "config":
        code = await runConfig(cmdArgs, { json, envFile: parsed.globals.envFile }, showHelp);
        break;
      case "setup":
        code = await runSetup(cmdArgs, { json, envFile: parsed.globals.envFile }, showHelp);
        break;
      case "login":
        code = await runLogin(cmdArgs, { json, apiUrl }, showHelp);
        break;
      case "whoami":
      case "status":
        code = await runWhoami(
          cmdArgs,
          {
            json,
            envFile: parsed.globals.envFile,
            token: parsed.globals.token,
            workspace: parsed.globals.workspace,
            apiUrl: parsed.globals.apiUrl,
          },
          showHelp,
        );
        break;
      case "logout":
        code = await runLogout(cmdArgs, { json, envFile: parsed.globals.envFile }, showHelp);
        break;
      case "invite":
        code = await runInvite(cmdArgs, { json, apiUrl }, showHelp);
        break;
      case "admin":
        code = await runAdmin(cmdArgs, { json, apiUrl }, showHelp);
        break;
      case "telemetry":
        code = await runTelemetry(cmdArgs, { json, apiUrl }, showHelp);
        break;
      case "report":
        code = await runReport(cmdArgs, { json, apiUrl }, showHelp);
        break;
      case "mcp":
        code = await runMcp(cmdArgs, { globals: parsed.globals }, showHelp);
        break;
      case "install":
        code = await runInstall(cmdArgs, { globals: parsed.globals, json }, showHelp);
        break;
      case "completion":
      case "completions":
        code = await runCompletion(cmdArgs, showHelp);
        break;
      case "attach":
      case "put":
      case "staged":
      case "screenshot":
      case "gallery":
      case "list":
      case "find":
      case "meta":
      case "delete":
      case "usage":
      case "reconcile":
      case "purge-expired":
      case "doctor":
      case "comment":
      case "github": {
        const ctx = createContext(parsed.globals, !showHelp, cmdArgs);
        switch (parsed.command) {
          case "attach":
            code = await runAttach(ctx, cmdArgs, showHelp);
            break;
          case "put":
            code = await runPut(ctx, cmdArgs, showHelp);
            break;
          case "staged":
            code = await runStaged(ctx, cmdArgs, showHelp);
            break;
          case "screenshot":
            code = await runScreenshot(ctx, cmdArgs, showHelp);
            break;
          case "gallery":
            code = await runGallery(ctx, cmdArgs, showHelp);
            break;
          case "comment":
            code = await runComment(ctx, cmdArgs, showHelp);
            break;
          case "github":
            code = await runGithub(ctx, cmdArgs, showHelp);
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
      default: {
        const style = createStyle(colorEnabled(process.stderr));
        process.stderr.write(`${style.error(`unknown command: ${parsed.command}`)}\n\n`);
        await writeRootHelp({
          full: false,
          token: parsed.globals.token,
          envFile: parsed.globals.envFile,
        });
        flushTelemetry(2);
        return 2;
      }
    }

    // Best-effort; skipped for mcp, --quiet/--json, and opt-out env vars.
    if (code === 0 && !showHelp) {
      await maybeHintUpdate({ quiet: quiet || json, command: parsed.command });
    }
    flushTelemetry(code);
    return code;
  } catch (err) {
    const format = outputFormat(argv);
    errorOut(err, format);
    if (err instanceof UsageError && format !== "json") usageHint(argv);
    const code = exitCode(err);
    flushTelemetry(code, err);
    return code;
  }
}
