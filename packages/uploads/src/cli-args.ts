export interface GlobalFlags {
  apiUrl?: string;
  workspace?: string;
  token?: string;
  envFile?: string;
  json?: boolean;
  quiet?: boolean;
  /** `--version` / `-V` — print package version and exit. */
  version?: boolean;
}

export interface ParsedArgv {
  globals: GlobalFlags;
  help: boolean;
  command?: string;
  /** Args starting at the command name (includes command-specific flags). */
  rest: string[];
}

const VALUE_GLOBALS = new Set(["--api-url", "--workspace", "-w", "--token", "--env-file"]);

export function isHelpFlag(arg: string): boolean {
  return arg === "-h" || arg === "--help";
}

/**
 * Parse global flags that appear before the subcommand. Stops at the first
 * positional token (the command name) or an unrecognized flag.
 */
export function parseArgv(argv: string[]): ParsedArgv {
  const args = argv.slice(2);
  const globals: GlobalFlags = {};
  let help = false;
  let i = 0;

  while (i < args.length) {
    const arg = args[i];

    if (isHelpFlag(arg)) {
      help = true;
      i++;
      continue;
    }
    if (arg === "--json") {
      globals.json = true;
      i++;
      continue;
    }
    if (arg === "--quiet") {
      globals.quiet = true;
      i++;
      continue;
    }
    if (arg === "--version" || arg === "-V") {
      globals.version = true;
      i++;
      continue;
    }
    if (VALUE_GLOBALS.has(arg)) {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) {
        throw new UsageError(`missing value for ${arg}`);
      }
      switch (arg) {
        case "--api-url":
          globals.apiUrl = value;
          break;
        case "--workspace":
        case "-w":
          globals.workspace = value;
          break;
        case "--token":
          globals.token = value;
          break;
        case "--env-file":
          globals.envFile = value;
          break;
      }
      i += 2;
      continue;
    }
    if (arg.startsWith("-")) break;
    break;
  }

  const rest = args.slice(i);
  return { globals, help, command: rest[0], rest };
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface CommandFlags {
  positionals: string[];
  flags: Map<string, string | boolean>;
  help: boolean;
}

/**
 * Parse command-specific args. Supports `--flag value`, `--flag=value`, and
 * boolean `--flag` flags.
 */
export function parseCommandArgs(args: string[]): CommandFlags {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  let help = false;
  let i = 0;

  while (i < args.length) {
    const arg = args[i];

    if (isHelpFlag(arg)) {
      help = true;
      i++;
      continue;
    }

    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        flags.set(arg.slice(0, eq), arg.slice(eq + 1));
        i++;
        continue;
      }

      const name = arg;
      const next = args[i + 1];
      if (next && !next.startsWith("-")) {
        flags.set(name, next);
        i += 2;
        continue;
      }

      flags.set(name, true);
      i++;
      continue;
    }

    positionals.push(arg);
    i++;
  }

  return { positionals, flags, help };
}

export function flagString(flags: CommandFlags["flags"], name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

export function flagBool(flags: CommandFlags["flags"], name: string): boolean {
  return flags.get(name) === true;
}

/** Command-level workspace override (`--workspace` / `-w`). */
export function commandWorkspace(flags: CommandFlags["flags"]): string | undefined {
  return flagString(flags, "--workspace") ?? flagString(flags, "-w");
}

export function flagInt(
  flags: CommandFlags["flags"],
  name: string,
  label: string,
): number | undefined {
  const raw = flagString(flags, name);
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) {
    throw new UsageError(`invalid ${label}: must be a positive integer (got ${raw})`);
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new UsageError(`invalid ${label}: must be a positive integer (got ${raw})`);
  }
  return n;
}
