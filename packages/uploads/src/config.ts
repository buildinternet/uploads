import { existsSync, readFileSync } from "node:fs";
import { loadConfigFile, resolveConfigPath } from "./config-file.js";
import { UploadsError } from "./errors.js";

export {
  defaultConfigPath,
  resolveConfigPath,
  loadConfigFile,
  redactToken,
  writeConfigKeys,
  configValuesFromClient,
  putDefaultsToConfigValues,
  resolvePutDefaults,
  mergePutDefaults,
  UPLOADS_CONFIG_KEYS,
  type UploadsConfigKey,
  type UploadsConfigValues,
  type PutDefaults,
} from "./config-file.js";

export interface UploadsClientConfig {
  apiUrl: string;
  workspace: string;
  token: string;
}

export const DEFAULT_API_URL = "https://api.uploads.sh";
export const DEFAULT_WORKSPACE = "default";

const TOKEN_WORKSPACE_RE = /^up_([a-z0-9][a-z0-9-]{1,62})_/;

/** Workspace encoded in minted tokens: `up_<workspace>_…` */
export function workspaceFromToken(token: string): string | undefined {
  return TOKEN_WORKSPACE_RE.exec(token)?.[1];
}

export function loadEnvFile(path: string): Partial<UploadsClientConfig> {
  if (!existsSync(path)) {
    throw new UploadsError(`--env-file not found: ${path}`, "USAGE");
  }
  const out: Partial<UploadsClientConfig> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key === "UPLOADS_API_URL") out.apiUrl = value;
    else if (key === "UPLOADS_WORKSPACE") out.workspace = value;
    else if (key === "UPLOADS_TOKEN") out.token = value;
  }
  return out;
}

type ConfigLayer = Partial<UploadsClientConfig>;

function layerFromUserConfig(flags?: { envFile?: string }): ConfigLayer {
  if (flags?.envFile) return {};
  const path = resolveConfigPath(flags);
  const raw = loadConfigFile(path);
  return {
    apiUrl: raw.UPLOADS_API_URL,
    workspace: raw.UPLOADS_WORKSPACE,
    token: raw.UPLOADS_TOKEN,
  };
}

function pickApiUrl(flags?: ConfigLayer & { apiUrl?: string; envFile?: string }): string {
  const fromEnvFile = flags?.envFile ? loadEnvFile(flags.envFile) : {};
  const fromUser = layerFromUserConfig(flags);
  return (
    flags?.apiUrl ??
    process.env.UPLOADS_API_URL ??
    fromEnvFile.apiUrl ??
    fromUser.apiUrl ??
    DEFAULT_API_URL
  );
}

/** How the active workspace was chosen (for doctor hints). */
export type WorkspaceSource = "override" | "env" | "file" | "user-config" | "token" | "default";

export type ConfigValueSource = "flag" | "env" | "env-file" | "user-config" | "token" | "default";

export interface ResolvedConfig extends UploadsClientConfig {
  workspaceSource: WorkspaceSource;
  configPath: string;
  configExists: boolean;
}

export interface ConfigSources {
  apiUrl: ConfigValueSource;
  workspace: WorkspaceSource;
  token: ConfigValueSource;
}

export function describeConfigSources(
  flags?: Partial<UploadsClientConfig> & { envFile?: string },
): ConfigSources {
  const fromEnvFile = flags?.envFile ? loadEnvFile(flags.envFile) : {};
  const fromUser = layerFromUserConfig(flags);
  const token = flags?.token ?? process.env.UPLOADS_TOKEN ?? fromEnvFile.token ?? fromUser.token;

  let apiUrl: ConfigValueSource = "default";
  if (flags?.apiUrl) apiUrl = "flag";
  else if (process.env.UPLOADS_API_URL) apiUrl = "env";
  else if (fromEnvFile.apiUrl) apiUrl = "env-file";
  else if (fromUser.apiUrl) apiUrl = "user-config";

  let workspaceSource: WorkspaceSource = "default";
  if (flags?.workspace) workspaceSource = "override";
  else if (process.env.UPLOADS_WORKSPACE) workspaceSource = "env";
  else if (fromEnvFile.workspace) workspaceSource = "file";
  else if (fromUser.workspace) workspaceSource = "user-config";
  else if (token && workspaceFromToken(token)) workspaceSource = "token";

  let tokenSource: ConfigValueSource = "default";
  if (flags?.token) tokenSource = "flag";
  else if (process.env.UPLOADS_TOKEN) tokenSource = "env";
  else if (fromEnvFile.token) tokenSource = "env-file";
  else if (fromUser.token) tokenSource = "user-config";

  return { apiUrl, workspace: workspaceSource, token: tokenSource };
}

export function resolveApiUrl(flags?: { apiUrl?: string; envFile?: string }): string {
  return pickApiUrl(flags);
}

export function resolveConfig(
  flags?: Partial<UploadsClientConfig> & { envFile?: string; requireToken?: boolean },
): ResolvedConfig {
  const fromEnvFile = flags?.envFile ? loadEnvFile(flags.envFile) : {};
  const fromUser = layerFromUserConfig(flags);
  const configPath = resolveConfigPath(flags);

  const token = flags?.token ?? process.env.UPLOADS_TOKEN ?? fromEnvFile.token ?? fromUser.token;
  const apiUrl = pickApiUrl(flags);

  let workspace: string;
  let workspaceSource: WorkspaceSource;

  if (flags?.workspace) {
    workspace = flags.workspace;
    workspaceSource = "override";
  } else if (process.env.UPLOADS_WORKSPACE) {
    workspace = process.env.UPLOADS_WORKSPACE;
    workspaceSource = "env";
  } else if (fromEnvFile.workspace) {
    workspace = fromEnvFile.workspace;
    workspaceSource = "file";
  } else if (fromUser.workspace) {
    workspace = fromUser.workspace;
    workspaceSource = "user-config";
  } else if (token && workspaceFromToken(token)) {
    workspace = workspaceFromToken(token)!;
    workspaceSource = "token";
  } else {
    workspace = DEFAULT_WORKSPACE;
    workspaceSource = "default";
  }

  if (flags?.requireToken !== false && !token) {
    throw new UploadsError(missingTokenMessage(configPath), "MISSING_TOKEN");
  }

  return {
    apiUrl,
    workspace,
    token: token ?? "",
    workspaceSource,
    configPath,
    configExists: existsSync(configPath),
  };
}

function missingTokenMessage(configPath: string): string {
  return [
    "UPLOADS_TOKEN is required.",
    "  uploads login                         # exchange an admin-provided enrollment code",
    `  uploads setup --token <token>         # guided setup → ${configPath}`,
    `  uploads config init --token <token>   # writes ${configPath}`,
    "  or set UPLOADS_TOKEN in env, pass --token, or use --env-file",
  ].join("\n");
}

/** Warn when an explicit workspace override may not match the token's embedded workspace. */
export function workspaceMismatch(config: ResolvedConfig): string | undefined {
  const fromToken = workspaceFromToken(config.token);
  if (!fromToken || fromToken === config.workspace) return undefined;
  if (config.workspaceSource === "token" || config.workspaceSource === "default") return undefined;
  return `workspace override "${config.workspace}" (token encodes "${fromToken}") — ensure the token is valid for the override workspace`;
}
