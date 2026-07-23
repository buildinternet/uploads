import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { flagBool, parseCommandArgs, UsageError, type GlobalFlags } from "../cli-args.js";
import { execRunner, type CommandRunner } from "../github-gh.js";
import { writeCommandHelp } from "../cli-style.js";
import { detectInstallSource, type InstallSource } from "../install-source.js";
import { checkForUpdate, type UpdateStatus } from "../update-check.js";
import { runInstall, runStep } from "./install.js";

const UPDATE_HELP = `uploads update — update the CLI and refresh agent integrations

Upgrades the globally installed npm package, then re-runs \`uploads install\` so
the agent skills and the MCP registration match the new version. Skills and the
MCP registration drift on their own, so this refreshes them even when the CLI is
already current.

Usage:
  uploads update [options]

Options:
  --dry-run        Print the plan without running anything
  --skip-install   Upgrade the npm package only; leave skills and MCP alone
  --verbose        Show the output of the underlying commands

Examples:
  uploads update
  uploads update --dry-run
  uploads update --skip-install
`;

/** Why an upgrade was skipped, phrased for the user. */
const SKIP_REASON: Record<string, string> = {
  workspace: "this is a workspace checkout, not a global install",
  npx: "this ran from an npx cache, which is discarded after the run",
  unknown: "this is a local project dependency, not a global install",
};

export interface RunUpdateOptions {
  globals: GlobalFlags;
  /** Injected in tests. */
  runner?: CommandRunner;
  /** Injected in tests; defaults to detection from this module's path. */
  source?: InstallSource;
  /** Injected in tests; defaults to a cache-bypassing registry check. */
  check?: () => Promise<UpdateStatus>;
}

function thisModulePath(): string {
  const path = fileURLToPath(import.meta.url);
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function isPermissionError(message: string): boolean {
  return /EACCES|EPERM|permission denied/i.test(message);
}

export async function runUpdate(
  args: string[],
  opts: RunUpdateOptions,
  help = false,
): Promise<number> {
  const parsed = parseCommandArgs(args);
  if (help || parsed.help) {
    writeCommandHelp(UPDATE_HELP);
    return 0;
  }
  if (parsed.positionals.length > 0) {
    throw new UsageError(`update takes no arguments (got ${parsed.positionals[0]})`);
  }

  const dryRun = flagBool(parsed.flags, "--dry-run");
  const verbose = flagBool(parsed.flags, "--verbose");
  const skipInstall = flagBool(parsed.flags, "--skip-install");
  const run = opts.runner ?? execRunner;
  const source = opts.source ?? detectInstallSource(thisModulePath());
  // ttlMs 0 bypasses the once-a-day cache: `update` must not trust yesterday's read.
  const status = await (opts.check ?? (() => checkForUpdate({ ttlMs: 0 })))();

  const willUpgrade = status.updateAvailable && source.kind === "global";
  const refreshCommand = ["uploads", "install"];

  // --- plan ---
  if (willUpgrade) {
    process.stdout.write(`CLI ${status.current} → ${status.latest}\n`);
  } else if (status.updateAvailable) {
    process.stdout.write(
      `CLI ${status.current} is behind ${status.latest}, but the upgrade is skipped — ` +
        `${SKIP_REASON[source.kind] ?? "the install source is not a global install"}.\n` +
        `Upgrade by hand with: ${source.upgradeCommand.join(" ")}\n`,
    );
  } else {
    process.stdout.write(`CLI already at ${status.current}\n`);
  }

  if (dryRun) {
    if (willUpgrade) {
      process.stdout.write(`upgrade: would run — ${source.upgradeCommand.join(" ")}\n`);
    }
    if (!skipInstall) {
      process.stdout.write(`refresh: would run — ${refreshCommand.join(" ")}\n`);
    }
    return 0;
  }

  // --- upgrade ---
  if (willUpgrade) {
    process.stdout.write("Upgrading the CLI…\n");
    const result = runStep(run, source.upgradeCommand);
    if (!result.ok) {
      const message = result.error ?? "";
      process.stderr.write(`upgrade: failed — ${message}\n`);
      if (isPermissionError(message)) {
        process.stderr.write(
          "The global install directory is not writable by your user. Fix the ownership " +
            `of your npm prefix so global installs work without sudo, then re-run \`uploads update\`.\n`,
        );
      }
      process.stderr.write(`Run it by hand: ${source.upgradeCommand.join(" ")}\n`);
      return 1;
    }
    process.stdout.write("upgrade: ok\n");
    if (verbose && result.output) process.stdout.write(`  ${result.output}\n`);
  }

  if (skipInstall) return 0;

  // --- refresh ---
  // After an upgrade the in-process code is the OLD version, so spawn the newly
  // installed binary. Its skill list is the one that should be installed.
  if (willUpgrade) {
    process.stdout.write("Refreshing skills and MCP…\n");
    const result = runStep(run, refreshCommand);
    if (!result.ok) {
      process.stderr.write(`refresh: failed — ${result.error ?? ""}\n`);
      process.stderr.write("Run it by hand: uploads install\n");
      return 1;
    }
    process.stdout.write(result.output ? `${result.output}\n` : "refresh: ok\n");
    return 0;
  }

  // Nothing changed, so the in-process install code is already current.
  return runInstall([], { globals: opts.globals, runner: run });
}
