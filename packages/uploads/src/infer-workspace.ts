import { listMintWorkspaces } from "./client.js";
import { workspaceFromToken, type ResolvedConfig } from "./config.js";
import { UploadsError } from "./errors.js";

/**
 * API keys do not encode a workspace. When the caller didn't pick one, ask
 * GET /v1/tokens: one membership → use it; several → require --workspace.
 * Workspace tokens (`up_<name>_…`) never reach this — resolveConfig already
 * read the name out of the secret.
 */
export async function inferWorkspaceFromCredential(
  config: ResolvedConfig,
): Promise<ResolvedConfig> {
  if (config.workspaceSource !== "default") return config;
  if (!config.token || workspaceFromToken(config.token)) return config;

  let workspaces: { workspace: string }[];
  try {
    ({ workspaces } = await listMintWorkspaces(config.apiUrl, config.token));
  } catch {
    return config;
  }
  if (workspaces.length === 1) {
    const workspace = workspaces[0]?.workspace;
    if (!workspace) return config;
    return { ...config, workspace, workspaceSource: "account" };
  }
  if (workspaces.length > 1) {
    throw new UploadsError(
      [
        "This API key works on more than one workspace. Pick one:",
        "",
        ...workspaces.map((w) => `  --workspace ${w.workspace}`),
        "",
        "or set UPLOADS_WORKSPACE.",
      ].join("\n"),
      "USAGE",
    );
  }
  return config;
}
