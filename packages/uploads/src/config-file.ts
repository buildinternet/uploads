import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import type { UploadsClientConfig } from "./config.js";

export const UPLOADS_CONFIG_KEYS = [
  "UPLOADS_API_URL",
  "UPLOADS_WORKSPACE",
  "UPLOADS_TOKEN",
  "UPLOADS_DEFAULT_PREFIX",
  "UPLOADS_DEFAULT_REPO",
  "UPLOADS_DEFAULT_REF",
  "UPLOADS_DEFAULT_WIDTH",
  "UPLOADS_NO_GIT",
] as const;

export type UploadsConfigKey = (typeof UPLOADS_CONFIG_KEYS)[number];

export type UploadsConfigValues = Partial<Record<UploadsConfigKey, string>>;

export interface PutDefaults {
  prefix?: string;
  repo?: string;
  ref?: string;
  width?: number;
  noGit?: boolean;
}

const PUT_DEFAULT_KEY_MAP: Record<keyof PutDefaults, UploadsConfigKey> = {
  prefix: "UPLOADS_DEFAULT_PREFIX",
  repo: "UPLOADS_DEFAULT_REPO",
  ref: "UPLOADS_DEFAULT_REF",
  width: "UPLOADS_DEFAULT_WIDTH",
  noGit: "UPLOADS_NO_GIT",
};

export function putDefaultsToConfigValues(defaults: PutDefaults): UploadsConfigValues {
  const out: UploadsConfigValues = {};
  if (defaults.prefix) out.UPLOADS_DEFAULT_PREFIX = defaults.prefix;
  if (defaults.repo) out.UPLOADS_DEFAULT_REPO = defaults.repo;
  if (defaults.ref) out.UPLOADS_DEFAULT_REF = defaults.ref;
  if (defaults.width != null) out.UPLOADS_DEFAULT_WIDTH = String(defaults.width);
  if (defaults.noGit) out.UPLOADS_NO_GIT = "1";
  return out;
}

function parsePutDefaultsFromRaw(raw: UploadsConfigValues): PutDefaults {
  const out: PutDefaults = {};
  if (raw.UPLOADS_DEFAULT_PREFIX) out.prefix = raw.UPLOADS_DEFAULT_PREFIX;
  if (raw.UPLOADS_DEFAULT_REPO) out.repo = raw.UPLOADS_DEFAULT_REPO;
  if (raw.UPLOADS_DEFAULT_REF) out.ref = raw.UPLOADS_DEFAULT_REF;
  if (raw.UPLOADS_DEFAULT_WIDTH) {
    const n = Number.parseInt(raw.UPLOADS_DEFAULT_WIDTH, 10);
    if (Number.isFinite(n) && n > 0) out.width = n;
  }
  if (raw.UPLOADS_NO_GIT === "1" || raw.UPLOADS_NO_GIT?.toLowerCase() === "true") {
    out.noGit = true;
  }
  return out;
}

function parsePutDefaultsFromEnv(): PutDefaults {
  const raw: UploadsConfigValues = {};
  if (process.env.UPLOADS_DEFAULT_PREFIX)
    raw.UPLOADS_DEFAULT_PREFIX = process.env.UPLOADS_DEFAULT_PREFIX;
  if (process.env.UPLOADS_DEFAULT_REPO) raw.UPLOADS_DEFAULT_REPO = process.env.UPLOADS_DEFAULT_REPO;
  if (process.env.UPLOADS_DEFAULT_REF) raw.UPLOADS_DEFAULT_REF = process.env.UPLOADS_DEFAULT_REF;
  if (process.env.UPLOADS_DEFAULT_WIDTH)
    raw.UPLOADS_DEFAULT_WIDTH = process.env.UPLOADS_DEFAULT_WIDTH;
  if (process.env.UPLOADS_NO_GIT) raw.UPLOADS_NO_GIT = process.env.UPLOADS_NO_GIT;
  return parsePutDefaultsFromRaw(raw);
}

/** XDG default shared across buildinternet skills (github-screenshots, uploads, …). */
export function defaultConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME ?? `${homedir()}/.config`;
  return `${xdg}/buildinternet/config`;
}

/** Resolved config file path: explicit --env-file, then $BUILDINTERNET_CONFIG, then XDG default. */
export function resolveConfigPath(flags?: { envFile?: string }): string {
  if (flags?.envFile) return flags.envFile;
  if (process.env.BUILDINTERNET_CONFIG) return process.env.BUILDINTERNET_CONFIG;
  return defaultConfigPath();
}

function parseEnvLine(line: string): { key: string; value: string } | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return undefined;

  const exportPrefix = trimmed.startsWith("export ") ? trimmed.slice(7) : trimmed;
  const eq = exportPrefix.indexOf("=");
  if (eq === -1) return undefined;

  const key = exportPrefix.slice(0, eq).trim();
  let value = exportPrefix.slice(eq + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  } else {
    const comment = value.search(/\s#/);
    if (comment !== -1) value = value.slice(0, comment).trimEnd();
  }
  return { key, value };
}

function isUploadsConfigKey(key: string): key is UploadsConfigKey {
  return (UPLOADS_CONFIG_KEYS as readonly string[]).includes(key);
}

/** Parse UPLOADS_* keys from a dotenv-style file. Missing file → empty object. */
export function loadConfigFile(path: string): UploadsConfigValues {
  if (!existsSync(path)) return {};
  const out: UploadsConfigValues = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const parsed = parseEnvLine(line);
    if (!parsed || !isUploadsConfigKey(parsed.key)) continue;
    out[parsed.key] = parsed.value;
  }
  return out;
}

export function mergePutDefaults(...layers: PutDefaults[]): PutDefaults {
  const out: PutDefaults = {};
  for (const layer of layers) {
    if (layer.prefix) out.prefix = layer.prefix;
    if (layer.repo) out.repo = layer.repo;
    if (layer.ref) out.ref = layer.ref;
    if (layer.width != null) out.width = layer.width;
    if (layer.noGit != null) out.noGit = layer.noGit;
  }
  return out;
}

/** Put defaults from env, optional env-file, and user config (same precedence as client config). */
export function resolvePutDefaults(flags?: { envFile?: string }): PutDefaults {
  const fromEnv = parsePutDefaultsFromEnv();
  const fromEnvFile = flags?.envFile ? parsePutDefaultsFromRaw(loadConfigFile(flags.envFile)) : {};
  const fromUser = flags?.envFile
    ? {}
    : parsePutDefaultsFromRaw(loadConfigFile(resolveConfigPath(flags)));
  return mergePutDefaults(fromUser, fromEnvFile, fromEnv);
}

export function redactToken(token: string | undefined): string {
  if (!token) return "unset";
  if (token.length <= 12) return "set (redacted)";
  return `set (${token.slice(0, 12)}…)`;
}

const INIT_HEADER = `# uploads.sh CLI — shared buildinternet config
# Other skills (e.g. github-screenshots) use this same file with their own prefixed keys.
#
# Resolution order (first match wins, per key):
#   1. CLI flags (--api-url, --token, --workspace)
#   2. environment variables
#   3. --env-file <path>
#   4. $BUILDINTERNET_CONFIG
#   5. ~/.config/buildinternet/config
#
# Mint a token: uploads setup
# Put defaults (optional): UPLOADS_DEFAULT_PREFIX, UPLOADS_DEFAULT_REPO, UPLOADS_DEFAULT_REF
`;

/** Create or update UPLOADS_* keys in the shared config file. Preserves other keys. */
export function writeConfigKeys(
  path: string,
  keys: UploadsConfigValues,
  opts?: { force?: boolean },
): { path: string; created: boolean; updated: string[] } {
  const entries = Object.entries(keys).filter(([, v]) => v !== undefined && v !== "");
  for (const [key, value] of entries) {
    if (/[\r\n]/.test(value!)) throw new Error(`invalid newline in ${key}`);
  }
  if (entries.length === 0) {
    throw new Error("no config values to write");
  }

  mkdirSync(dirname(path), { recursive: true });
  const existed = existsSync(path);
  let lines = existed ? readFileSync(path, "utf8").split("\n") : [];

  if (!existed) {
    lines = INIT_HEADER.trimEnd().split("\n");
  }

  const updated: string[] = [];
  for (const [key, value] of entries) {
    const re = new RegExp(`^(?:export\\s+)?${key}=`);
    const idx = lines.findIndex((line) => re.test(line.trim()));
    const line = `${key}=${value}`;
    if (idx === -1) {
      if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
      lines.push(line);
      updated.push(key);
    } else if (opts?.force || !parseEnvLine(lines[idx]!)?.value) {
      lines[idx] = line;
      updated.push(key);
    }
  }

  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, lines.join("\n").replace(/\n*$/, "\n"), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    /* Windows/filesystems may not support modes. */
  }
  return { path, created: !existed, updated };
}

export function configValuesFromClient(
  config: Partial<UploadsClientConfig>,
  defaults?: PutDefaults,
): UploadsConfigValues {
  const out: UploadsConfigValues = {};
  if (config.apiUrl) out.UPLOADS_API_URL = config.apiUrl;
  if (config.workspace) out.UPLOADS_WORKSPACE = config.workspace;
  if (config.token) out.UPLOADS_TOKEN = config.token;
  Object.assign(out, putDefaultsToConfigValues(defaults ?? {}));
  return out;
}

export { PUT_DEFAULT_KEY_MAP };
