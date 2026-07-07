import { existsSync } from "node:fs";
import {
  DEFAULT_API_URL,
  DEFAULT_WORKSPACE,
  UPLOADS_CONFIG_KEYS,
  describeConfigSources,
  redactToken,
  resolveConfig,
  resolveConfigPath,
  resolvePutDefaults,
  writeConfigKeys,
  type UploadsConfigKey,
} from "../config.js";
import {
  flagBool,
  flagString,
  parseCommandArgs,
  UsageError,
} from "../cli-args.js";

const CONFIG_HELP = `uploads config — manage shared buildinternet config

Shared file (with github-screenshots and other skills):
  ~/.config/buildinternet/config
  or $XDG_CONFIG_HOME/buildinternet/config
  or override with $BUILDINTERNET_CONFIG

Subcommands:
  path                Print the resolved config file path
  show                Show effective settings (token redacted)
  init                Create or update UPLOADS_* keys in the config file
  set <key> <value>   Set one UPLOADS_* key

Keys:
  UPLOADS_API_URL           API base URL (default: ${DEFAULT_API_URL})
  UPLOADS_WORKSPACE         Workspace / bucket tenant (default: ${DEFAULT_WORKSPACE})
  UPLOADS_TOKEN             Bearer token for the workspace
  UPLOADS_DEFAULT_PREFIX    Default key prefix for put/list
  UPLOADS_DEFAULT_REPO      Default repo segment for put
  UPLOADS_DEFAULT_REF       Default ref segment for put
  UPLOADS_DEFAULT_WIDTH     Default markdown image width
  UPLOADS_NO_GIT            Set to 1 to skip git remote for --repo

Examples:
  uploads config path
  uploads config show
  uploads config init --token up_default_… --workspace default
  uploads config set UPLOADS_TOKEN up_default_…
  uploads config init --api-url http://localhost:8787 --force
`;

const VALID_KEYS = new Set<UploadsConfigKey>(UPLOADS_CONFIG_KEYS);

function writeStdout(text: string): void {
  process.stdout.write(text);
}

function writeJson(payload: unknown): void {
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
}

export async function runConfig(
  args: string[],
  opts: { json?: boolean; envFile?: string },
  help = false,
): Promise<number> {
  const parsed = parseCommandArgs(args);
  if (help || parsed.help || parsed.positionals.length === 0) {
    process.stderr.write(CONFIG_HELP);
    return 0;
  }

  const sub = parsed.positionals[0];
  const rest = parsed.positionals.slice(1);
  const subArgs = args.slice(args.indexOf(sub) + 1);

  switch (sub) {
    case "path":
      return runConfigPath(subArgs, opts, help);
    case "show":
      return runConfigShow(subArgs, opts, help);
    case "init":
      return runConfigInit(subArgs, opts, help);
    case "set":
      return runConfigSet(rest, subArgs, opts, help);
    default:
      process.stderr.write(`unknown config subcommand: ${sub}\n\n${CONFIG_HELP}`);
      return 2;
  }
}

async function runConfigPath(
  args: string[],
  opts: { json?: boolean; envFile?: string },
  help: boolean,
): Promise<number> {
  if (help || parseCommandArgs(args).help) {
    process.stderr.write(`uploads config path\n\nPrint the resolved config file path.\n`);
    return 0;
  }
  const path = resolveConfigPath({ envFile: opts.envFile });
  const payload = { path, exists: existsSync(path) };
  if (opts.json) writeJson(payload);
  else writeStdout(`${path}\n`);
  return 0;
}

async function runConfigShow(
  args: string[],
  opts: { json?: boolean; envFile?: string },
  help: boolean,
): Promise<number> {
  if (help || parseCommandArgs(args).help) {
    process.stderr.write(`uploads config show\n\nShow effective settings (token redacted).\n`);
    return 0;
  }

  const config = resolveConfig({ envFile: opts.envFile, requireToken: false });
  const sources = describeConfigSources({ envFile: opts.envFile });
  const defaults = resolvePutDefaults({ envFile: opts.envFile });
  const payload = {
    configPath: config.configPath,
    configExists: config.configExists,
    apiUrl: config.apiUrl,
    workspace: config.workspace,
    token: redactToken(config.token || undefined),
    sources,
    defaults,
  };

  if (opts.json) {
    writeJson(payload);
    return 0;
  }

  const lines = [
    `config:    ${config.configPath}${config.configExists ? "" : " (missing)"}`,
    `api:       ${config.apiUrl} (${sources.apiUrl})`,
    `workspace: ${config.workspace} (${sources.workspace})`,
    `token:     ${redactToken(config.token || undefined)} (${sources.token})`,
  ];
  if (defaults.prefix) lines.push(`prefix:    ${defaults.prefix}`);
  if (defaults.repo) lines.push(`repo:      ${defaults.repo}`);
  if (defaults.ref) lines.push(`ref:       ${defaults.ref}`);
  if (defaults.width != null) lines.push(`width:     ${defaults.width}`);
  if (defaults.noGit) lines.push("no-git:    true");
  writeStdout(lines.join("\n") + "\n");
  return 0;
}

async function runConfigInit(
  args: string[],
  opts: { json?: boolean; envFile?: string },
  help: boolean,
): Promise<number> {
  const parsed = parseCommandArgs(args);
  if (help || parsed.help) {
    process.stderr.write(`uploads config init [options]

Create or update UPLOADS_* keys in the shared config file.

Options:
  --api-url <url>
  --workspace, -w <name>
  --token <token>
  --path <file>       Write to this file instead of the default
  --force             Overwrite existing non-empty values

Examples:
  uploads config init --token up_default_…
  uploads config init --api-url http://localhost:8787 --workspace default --token up_default_…
`);
    return 0;
  }

  const apiUrl = flagString(parsed.flags, "--api-url");
  const workspace = flagString(parsed.flags, "--workspace") ?? flagString(parsed.flags, "-w");
  const token = flagString(parsed.flags, "--token");
  const path = flagString(parsed.flags, "--path") ?? resolveConfigPath({ envFile: opts.envFile });
  const force = flagBool(parsed.flags, "--force");

  const keys: Partial<Record<UploadsConfigKey, string>> = {};
  if (apiUrl) keys.UPLOADS_API_URL = apiUrl;
  if (workspace) keys.UPLOADS_WORKSPACE = workspace;
  if (token) keys.UPLOADS_TOKEN = token;

  if (Object.keys(keys).length === 0) {
    keys.UPLOADS_API_URL = DEFAULT_API_URL;
    keys.UPLOADS_WORKSPACE = DEFAULT_WORKSPACE;
  }

  try {
    const result = writeConfigKeys(path, keys, { force });
    const payload = { ...result, keys: Object.keys(keys) };
    if (opts.json) writeJson(payload);
    else {
      const verb = result.created ? "created" : "updated";
      process.stdout.write(`${verb} ${result.path}\n`);
      if (result.updated.length) process.stdout.write(`keys: ${result.updated.join(", ")}\n`);
      if (!token) {
        process.stderr.write(
          "hint: add a token with uploads config set UPLOADS_TOKEN <token>\n",
        );
      }
    }
    return 0;
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
}

async function runConfigSet(
  positionals: string[],
  args: string[],
  opts: { json?: boolean; envFile?: string },
  help: boolean,
): Promise<number> {
  const parsed = parseCommandArgs(args);
  if (help || parsed.help) {
    process.stderr.write(`uploads config set <key> <value> [--path <file>] [--force]

Examples:
  uploads config set UPLOADS_TOKEN up_default_…
  uploads config set UPLOADS_WORKSPACE acme
`);
    return 0;
  }

  const key = positionals[0] as UploadsConfigKey | undefined;
  const value = positionals[1];
  if (!key || !value) {
    process.stderr.write(`uploads config set <key> <value>\n`);
    return 2;
  }
  if (!VALID_KEYS.has(key)) {
    throw new UsageError(`unknown key: ${key} (expected ${[...VALID_KEYS].join(", ")})`);
  }

  const path = flagString(parsed.flags, "--path") ?? resolveConfigPath({ envFile: opts.envFile });
  const force = flagBool(parsed.flags, "--force");
  const result = writeConfigKeys(path, { [key]: value }, { force });
  const payload = { ...result, key, value: key === "UPLOADS_TOKEN" ? redactToken(value) : value };

  if (opts.json) writeJson(payload);
  else process.stdout.write(`set ${key} in ${result.path}\n`);
  return 0;
}