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

Remove the saved UPLOADS_TOKEN from the shared config file so this machine is
no longer signed in for the CLI. Does not revoke the token on the server.

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
  /** True when a token is present only via process env (not config file). */
  tokenFromEnv: boolean;
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
  const config = resolveConfig({
    envFile: opts.envFile,
    token: opts.token,
    workspace: opts.workspace,
    apiUrl: opts.apiUrl,
    requireToken: false,
  });
  const sources = describeConfigSources({
    envFile: opts.envFile,
    token: opts.token,
    workspace: opts.workspace,
    apiUrl: opts.apiUrl,
  });
  const fileRaw = loadConfigFile(config.configPath);
  const tokenInConfig = Boolean(fileRaw.UPLOADS_TOKEN);
  const tokenFromEnv = sources.token === "env" || sources.token === "env-file";

  return {
    signedIn: Boolean(config.token),
    workspace: config.workspace,
    workspaceSource: sources.workspace,
    workspaceFromToken: config.token ? workspaceFromToken(config.token) : undefined,
    token: redactToken(config.token || undefined),
    tokenSource: sources.token,
    tokenFromEnv: Boolean(config.token) && tokenFromEnv && !tokenInConfig,
    tokenInConfig,
    apiUrl: config.apiUrl,
    apiUrlSource: sources.apiUrl,
    configPath: config.configPath,
    configExists: config.configExists,
  };
}

function formatWhoami(report: WhoamiReport): string {
  const lines: string[] = [];
  if (!report.signedIn) {
    lines.push("signed in:  no");
    lines.push(`config:     ${report.configPath}${report.configExists ? "" : " (missing)"}`);
    lines.push(`api:        ${report.apiUrl} (${report.apiUrlSource})`);
    lines.push(`workspace:  ${report.workspace} (${report.workspaceSource})`);
    lines.push("");
    lines.push("hint: run uploads login to sign in");
    return lines.join("\n") + "\n";
  }

  lines.push("signed in:  yes");
  lines.push(`workspace:  ${report.workspace} (${report.workspaceSource})`);
  if (report.workspaceFromToken && report.workspaceFromToken !== report.workspace) {
    lines.push(`token ws:   ${report.workspaceFromToken} (encoded in token)`);
  }
  lines.push(`token:      ${report.token} (${report.tokenSource})`);
  lines.push(`api:        ${report.apiUrl} (${report.apiUrlSource})`);
  lines.push(`config:     ${report.configPath}${report.configExists ? "" : " (missing)"}`);
  if (report.tokenFromEnv) {
    lines.push("");
    lines.push("note: token is from the environment, not the config file");
    lines.push("      uploads logout only clears the config file");
  }
  return lines.join("\n") + "\n";
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

  const path = flagString(parsed.flags, "--path") ?? opts.envFile;
  const report = buildWhoamiReport({
    envFile: path,
    token: opts.token,
    workspace: opts.workspace,
    apiUrl: opts.apiUrl,
  });

  if (opts.json || flagBool(parsed.flags, "--json")) {
    await writeJson(report);
  } else {
    process.stdout.write(formatWhoami(report));
  }
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
  const before = loadConfigFile(path);
  const hadFileToken = Boolean(before.UPLOADS_TOKEN);
  const envToken = Boolean(process.env.UPLOADS_TOKEN);

  const result = removeConfigKeys(path, ["UPLOADS_TOKEN"]);

  const payload = {
    path: result.path,
    removed: result.removed,
    configExisted: result.existed,
    hadTokenInConfig: hadFileToken,
    envTokenStillSet: envToken,
  };

  if (opts.json || flagBool(parsed.flags, "--json")) {
    await writeJson(payload);
    return 0;
  }

  if (result.removed.includes("UPLOADS_TOKEN")) {
    process.stdout.write(`signed out — removed UPLOADS_TOKEN from ${result.path}\n`);
  } else if (!result.existed) {
    process.stdout.write(`no config file at ${result.path} — already signed out\n`);
  } else {
    process.stdout.write(`no UPLOADS_TOKEN in ${result.path} — already signed out\n`);
  }

  if (envToken) {
    process.stderr.write(
      "note: UPLOADS_TOKEN is still set in the environment; unset it to fully sign out\n",
    );
  }

  return 0;
}
