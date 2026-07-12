/**
 * Resolve the published package version for CLI headers, --version, and
 * update checks. Reads package.json once per process.
 */
import { createRequire } from "node:module";

let cachedVersion: string | undefined;

export function packageVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version?: string };
    cachedVersion = pkg.version ?? "0.0.0";
  } catch {
    cachedVersion = "0.0.0";
  }
  return cachedVersion;
}
