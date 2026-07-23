/**
 * Classify where the running CLI was installed from.
 *
 * `uploads update` upgrades the global npm package. That is only safe when the
 * CLI actually came from a global install — upgrading a workspace checkout
 * would overwrite a developer's build with the published version.
 *
 * Pure and path-only: no filesystem or process access, so it is fully testable.
 */
import { PACKAGE_NAME } from "./update-check.js";

export type InstallKind = "global" | "workspace" | "npx" | "unknown";
export type PackageManager = "npm" | "pnpm" | "bun";

export interface InstallSource {
  kind: InstallKind;
  /** Falls back to npm for every non-global kind. */
  manager: PackageManager;
  /** Upgrades the global install. Only meaningful when kind is "global". */
  upgradeCommand: string[];
}

const UPGRADE_COMMANDS: Record<PackageManager, string[]> = {
  npm: ["npm", "install", "-g", `${PACKAGE_NAME}@latest`],
  pnpm: ["pnpm", "add", "-g", `${PACKAGE_NAME}@latest`],
  bun: ["bun", "add", "-g", `${PACKAGE_NAME}@latest`],
};

function classify(path: string): { kind: InstallKind; manager: PackageManager } {
  // npx is checked first: a cache entry can also contain a global-looking marker.
  if (path.includes("/_npx/")) return { kind: "npx", manager: "npm" };
  if (path.includes("/.bun/install/global/")) return { kind: "global", manager: "bun" };
  if (path.includes("/pnpm/global/")) return { kind: "global", manager: "pnpm" };
  if (path.includes("/lib/node_modules/")) return { kind: "global", manager: "npm" };
  // Windows npm globals have no `lib` segment: `<prefix>\npm\node_modules\<pkg>`.
  if (path.includes("/npm/node_modules/")) return { kind: "global", manager: "npm" };
  // No node_modules segment at all means we are running out of a source checkout.
  if (!path.includes("/node_modules/")) return { kind: "workspace", manager: "npm" };
  return { kind: "unknown", manager: "npm" };
}

/**
 * @param modulePath Absolute path of a file inside the installed package,
 *   normally `realpathSync(fileURLToPath(import.meta.url))`.
 */
export function detectInstallSource(modulePath: string): InstallSource {
  const normalized = modulePath.split("\\").join("/");
  const { kind, manager } = classify(normalized);
  return { kind, manager, upgradeCommand: UPGRADE_COMMANDS[manager] };
}
