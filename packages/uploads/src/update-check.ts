/**
 * Optional npm update notifier for the CLI.
 *
 * Checks the registry at most once per day, never throws, never blocks longer
 * than a short timeout, and writes only to stderr. Silence with --quiet,
 * UPLOADS_NO_UPDATE=1, or NO_UPDATE_NOTIFIER=1.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { packageVersion } from "./package-version.js";

export const PACKAGE_NAME = "@buildinternet/uploads";
const REGISTRY_LATEST = `https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}/latest`;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 1500;

export interface UpdateCache {
  checkedAt: number;
  latest: string;
  current: string;
}

export interface UpdateCheckOptions {
  quiet?: boolean;
  /** mcp is always skipped (stdio purity). */
  command?: string;
  currentVersion?: string;
  cachePath?: string;
  now?: number;
  /** Default 24h. Pass 0 in tests to force a network check. */
  ttlMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  write?: (text: string) => void;
}

function truthyEnv(name: string): boolean {
  const v = process.env[name];
  if (!v) return false;
  const lower = v.toLowerCase();
  return lower !== "0" && lower !== "false" && lower !== "no";
}

function defaultCachePath(): string {
  const base = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(base, "uploads", "version-check.json");
}

/** Parse major.minor.patch (ignores pre-release). */
export function parseSemver(version: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** True when `latest` is strictly greater than `current`. */
export function isNewerVersion(latest: string, current: string): boolean {
  const a = parseSemver(latest);
  const b = parseSemver(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

export function readUpdateCache(path: string): UpdateCache | undefined {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<UpdateCache>;
    if (
      typeof raw.checkedAt !== "number" ||
      typeof raw.latest !== "string" ||
      typeof raw.current !== "string"
    ) {
      return undefined;
    }
    return { checkedAt: raw.checkedAt, latest: raw.latest, current: raw.current };
  } catch {
    return undefined;
  }
}

export function writeUpdateCache(path: string, cache: UpdateCache): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cache) + "\n", { mode: 0o600 });
  } catch {
    // Best-effort — never fail the CLI for a cache write error.
  }
}

/**
 * If a newer published version is known (or can be fetched within the timeout),
 * write a one-line stderr hint. Always resolves; never throws.
 */
export async function maybeHintUpdate(opts: UpdateCheckOptions = {}): Promise<void> {
  try {
    if (opts.quiet || opts.command === "mcp") return;
    if (truthyEnv("UPLOADS_NO_UPDATE") || truthyEnv("NO_UPDATE_NOTIFIER")) return;

    const current = opts.currentVersion ?? packageVersion();
    const cachePath = opts.cachePath ?? defaultCachePath();
    const now = opts.now ?? Date.now();
    const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    const write = opts.write ?? ((text: string) => process.stderr.write(text));

    const cached = readUpdateCache(cachePath);
    let latest: string | undefined;

    if (cached && now - cached.checkedAt < ttlMs && cached.current === current) {
      latest = cached.latest;
    } else {
      const fetched = await fetchLatestVersion(
        opts.fetchImpl,
        opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      if (fetched) {
        latest = fetched;
        writeUpdateCache(cachePath, { checkedAt: now, latest: fetched, current });
      } else if (cached?.current === current) {
        latest = cached.latest; // stale cache if network failed
      }
    }

    if (latest && isNewerVersion(latest, current)) {
      write(
        `hint: ${PACKAGE_NAME}@${latest} is available (you have ${current}). Update: npm i -g ${PACKAGE_NAME}\n`,
      );
    }
  } catch {
    // Never surface update-check failures.
  }
}

async function fetchLatestVersion(
  fetchImpl: typeof fetch | undefined,
  timeoutMs: number,
): Promise<string | undefined> {
  const fetchFn = fetchImpl ?? globalThis.fetch;
  if (typeof fetchFn !== "function") return undefined;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(REGISTRY_LATEST, {
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "user-agent": `${PACKAGE_NAME}/${packageVersion()} (update-check)`,
      },
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === "string" ? body.version : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
