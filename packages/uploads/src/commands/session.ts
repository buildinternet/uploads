/**
 * Session commands: whoami / status (show identity) and logout (clear token).
 */
import {
  describeConfigSources,
  loadConfigFile,
  redactToken,
  removeConfigKeys,
  resolveConfig,
  resolveConfigPath,
  workspaceFromToken,
} from "../config.js";
import { flagBool, flagString, parseCommandArgs } from "../cli-args.js";
import { writeCommandHelp } from "../cli-style.js";
import { writeJson } from "../io.js";

const WHOAMI_HELP = `uploads whoami

Show the active CLI identity: workspace, token (redacted), API URL, and where
each value came from. Alias: uploads status.

Does not call the API (offline). Use uploads doctor to verify the token works.

Options:
  --path <file>       Config file to inspect (default: shared buildinternet config)
  --json              JSON on stdout

Examples:
  uploads whoami
  uploads status --json
  uploads whoami --path ./my.env
`;

const LOGOUT_HELP = `uploads logout

Remove the saved UPLOADS_TOKEN (and device session token) from the shared
config file so this machine is no longer signed in for the CLI. Does not
revoke tokens on the server.

Environment variables (UPLOADS_TOKEN) are not unset — export them yourself if set.

Options:
  --path <file>       Config file to edit (default: shared buildinternet config)
  --json              JSON on stdout

Examples:
  uploads logout
  uploads logout --path ./my.env
`;

export interface WhoamiReport {
  signedIn: boolean;
  workspace: string;
  workspaceSource: string;
  workspaceFromToken: string | undefined;
  token: string;
  tokenSource: string;
  /** True when the config file holds UPLOADS_TOKEN. */
  tokenInConfig: boolean;
  apiUrl: string;
  apiUrlSource: string;
  configPath: string;
  configExists: boolean;
}

export function buildWhoamiReport(opts: {
  envFile?: string;
  token?: string;
  workspace?: string;
  apiUrl?: string;
}): WhoamiReport {
  const flags = {
    envFile: opts.envFile,
    token: opts.token,
    workspace: opts.workspace,
    apiUrl: opts.apiUrl,
  };
  const config = resolveConfig({ ...flags, requireToken: false });
  const sources = describeConfigSources(flags);
  const tokenInConfig = Boolean(loadConfigFile(config.configPath).UPLOADS_TOKEN);

  return {
    signedIn: Boolean(config.token),
    workspace: config.workspace,
    workspaceSource: sources.workspace,
    workspaceFromToken: config.token ? workspaceFromToken(config.token) : undefined,
    token: redactToken(config.token || undefined),
    tokenSource: sources.token,
    tokenInConfig,
    apiUrl: config.apiUrl,
    apiUrlSource: sources.apiUrl,
    configPath: config.configPath,
    configExists: config.configExists,
  };
}

function formatWhoami(report: WhoamiReport): string {
  const cfg = `${report.configPath}${report.configExists ? "" : " (missing)"}`;
  const lines = [
    `signed in:  ${report.signedIn ? "yes" : "no"}`,
    `workspace:  ${report.workspace} (${report.workspaceSource})`,
  ];
  if (report.workspaceFromToken && report.workspaceFromToken !== report.workspace) {
    lines.push(`token ws:   ${report.workspaceFromToken} (encoded in token)`);
  }
  if (report.signedIn) {
    lines.push(`token:      ${report.token} (${report.tokenSource})`);
  }
  lines.push(`api:        ${report.apiUrl} (${report.apiUrlSource})`);
  lines.push(`config:     ${cfg}`);
  if (!report.signedIn) {
    lines.push("", "hint: run uploads login to sign in");
  } else if (report.tokenSource === "env" && !report.tokenInConfig) {
    lines.push(
      "",
      "note: token is from the environment, not the config file",
      "      uploads logout only clears the config file",
    );
  }
  return lines.join("\n") + "\n";
}

function wantsJson(opts: { json?: boolean }, parsed: ReturnType<typeof parseCommandArgs>): boolean {
  return Boolean(opts.json || flagBool(parsed.flags, "--json"));
}

export async function runWhoami(
  args: string[],
  opts: { json?: boolean; envFile?: string; token?: string; workspace?: string; apiUrl?: string },
  help = false,
): Promise<number> {
  const parsed = parseCommandArgs(args);
  if (help || parsed.help) {
    writeCommandHelp(WHOAMI_HELP);
    return 0;
  }

  const report = buildWhoamiReport({
    envFile: flagString(parsed.flags, "--path") ?? opts.envFile,
    token: opts.token,
    workspace: opts.workspace,
    apiUrl: opts.apiUrl,
  });

  if (wantsJson(opts, parsed)) await writeJson(report);
  else process.stdout.write(formatWhoami(report));
  return report.signedIn ? 0 : 1;
}

export async function runLogout(
  args: string[],
  opts: { json?: boolean; envFile?: string },
  help = false,
): Promise<number> {
  const parsed = parseCommandArgs(args);
  if (help || parsed.help) {
    writeCommandHelp(LOGOUT_HELP);
    return 0;
  }

  const path = flagString(parsed.flags, "--path") ?? resolveConfigPath({ envFile: opts.envFile });
  const hadFileToken = Boolean(loadConfigFile(path).UPLOADS_TOKEN);
  const envTokenStillSet = Boolean(process.env.UPLOADS_TOKEN);
  const result = removeConfigKeys(path, ["UPLOADS_TOKEN", "UPLOADS_SESSION_TOKEN"]);

  const payload = {
    path: result.path,
    removed: result.removed,
    configExisted: result.existed,
    hadTokenInConfig: hadFileToken,
    envTokenStillSet,
  };

  if (wantsJson(opts, parsed)) {
    await writeJson(payload);
    return 0;
  }

  if (
    result.removed.includes("UPLOADS_TOKEN") ||
    result.removed.includes("UPLOADS_SESSION_TOKEN")
  ) {
    process.stdout.write(`signed out — removed credentials from ${result.path}\n`);
  } else if (!result.existed) {
    process.stdout.write(`no config file at ${result.path} — already signed out\n`);
  } else {
    process.stdout.write(`no UPLOADS_TOKEN in ${result.path} — already signed out\n`);
  }

  if (envTokenStillSet) {
    process.stderr.write(
      "note: UPLOADS_TOKEN is still set in the environment; unset it to fully sign out\n",
    );
  }
  return 0;
}
