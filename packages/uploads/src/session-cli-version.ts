/**
 * Keep Better Auth session.cliVersion in sync with the installed package.
 *
 * Device login stores UPLOADS_SESSION_TOKEN; later commands POST
 * /api/auth/update-session when the local version changes (fire-and-forget).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { authUrlFromApi } from "./config.js";
import { loadConfigFile, removeConfigKeys, resolveConfigPath } from "./config-file.js";
import { packageVersion } from "./package-version.js";

const POST_TIMEOUT_MS = 1500;

function defaultCachePath(): string {
  const base = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(base, "uploads", "cli-version-sync");
}

function readLastSyncedVersion(path: string): string | undefined {
  try {
    const v = readFileSync(path, "utf8").trim();
    return v || undefined;
  } catch {
    return undefined;
  }
}

function writeLastSyncedVersion(path: string, version: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, version + "\n", { mode: 0o600 });
  } catch {
    // best-effort
  }
}

export interface SyncCliVersionOptions {
  sessionToken?: string;
  authUrl?: string;
  apiUrl?: string;
  envFile?: string;
  version?: string;
  /** Skip the local "already synced this version" short-circuit. */
  force?: boolean;
  cachePath?: string;
  fetchImpl?: typeof fetch;
}

/** Best-effort POST; never throws. */
export async function syncSessionCliVersion(opts: SyncCliVersionOptions = {}): Promise<boolean> {
  const version = opts.version ?? packageVersion();
  const configPath = resolveConfigPath({ envFile: opts.envFile });
  const fromFile = loadConfigFile(configPath);
  const sessionToken = opts.sessionToken ?? fromFile.UPLOADS_SESSION_TOKEN;
  if (!sessionToken) return false;

  const cachePath = opts.cachePath ?? defaultCachePath();
  if (!opts.force && readLastSyncedVersion(cachePath) === version) return true;

  const apiUrl = opts.apiUrl ?? fromFile.UPLOADS_API_URL ?? process.env.UPLOADS_API_URL;
  const authUrl = (
    opts.authUrl ??
    process.env.UPLOADS_AUTH_URL ??
    (apiUrl ? authUrlFromApi(apiUrl) : "https://auth.uploads.sh")
  ).replace(/\/$/, "");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
  try {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const res = await fetchImpl(`${authUrl}/api/auth/update-session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sessionToken}`,
        "User-Agent": `@buildinternet/uploads/${version} (session-version)`,
      },
      body: JSON.stringify({ cliVersion: version }),
      signal: controller.signal,
    });
    if (res.ok) {
      writeLastSyncedVersion(cachePath, version);
      return true;
    }
    // Stale session: drop it so we stop retrying every command.
    if (res.status === 401 || res.status === 403) {
      removeConfigKeys(configPath, ["UPLOADS_SESSION_TOKEN"]);
    }
    return false;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Fire-and-forget for CLI command starts. */
export function maybeSyncSessionCliVersion(opts: SyncCliVersionOptions = {}): void {
  void syncSessionCliVersion(opts);
}
