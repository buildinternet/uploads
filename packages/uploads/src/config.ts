import { readFileSync } from "node:fs";
import { UploadsError } from "./errors.js";

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

export function resolveApiUrl(flags?: { apiUrl?: string; envFile?: string }): string {
  const fromFile = flags?.envFile ? loadEnvFile(flags.envFile) : {};
  return flags?.apiUrl ?? process.env.UPLOADS_API_URL ?? fromFile.apiUrl ?? DEFAULT_API_URL;
}

/** How the active workspace was chosen (for doctor hints). */
export type WorkspaceSource = "override" | "env" | "file" | "token" | "default";

export interface ResolvedConfig extends UploadsClientConfig {
  workspaceSource: WorkspaceSource;
}

export function resolveConfig(
  flags?: Partial<UploadsClientConfig> & { envFile?: string; requireToken?: boolean },
): ResolvedConfig {
  const fromFile = flags?.envFile ? loadEnvFile(flags.envFile) : {};
  const token = flags?.token ?? process.env.UPLOADS_TOKEN ?? fromFile.token;
  const apiUrl = resolveApiUrl(flags);

  let workspace: string;
  let workspaceSource: WorkspaceSource;

  if (flags?.workspace) {
    workspace = flags.workspace;
    workspaceSource = "override";
  } else if (process.env.UPLOADS_WORKSPACE) {
    workspace = process.env.UPLOADS_WORKSPACE;
    workspaceSource = "env";
  } else if (fromFile.workspace) {
    workspace = fromFile.workspace;
    workspaceSource = "file";
  } else if (token && workspaceFromToken(token)) {
    workspace = workspaceFromToken(token)!;
    workspaceSource = "token";
  } else {
    workspace = DEFAULT_WORKSPACE;
    workspaceSource = "default";
  }

  if (flags?.requireToken !== false && !token) {
    throw new UploadsError(
      "UPLOADS_TOKEN is required — set in env, pass --token, or use --env-file",
      "MISSING_TOKEN",
    );
  }

  return { apiUrl, workspace, token: token ?? "", workspaceSource };
}

/** Warn when an explicit workspace override may not match the token's embedded workspace. */
export function workspaceMismatch(config: ResolvedConfig): string | undefined {
  const fromToken = workspaceFromToken(config.token);
  if (!fromToken || fromToken === config.workspace) return undefined;
  if (config.workspaceSource === "token" || config.workspaceSource === "default") return undefined;
  return `workspace override "${config.workspace}" (token encodes "${fromToken}") — ensure the token is valid for the override workspace`;
}