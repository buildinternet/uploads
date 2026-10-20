/**
 * Remembers tokens the API has called expired (`token_expired` 401), so later
 * calls with the same token fail locally instead of reaching the server.
 * Background callers (the Claude Code mod refreshing its band, hooks, scripts)
 * otherwise keep sending a dead token on every refresh.
 *
 * Expiry is final: `uploads login` mints a new token, which has a different
 * hash, so nothing here needs clearing. Stored next to the config file as
 * `expired-tokens.json`, keyed by a SHA-256 prefix of the token (never the
 * token itself). Every read and write is best-effort.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExpiredTokenStore } from "./client.js";
import { resolveConfigPath } from "./config-file.js";

const MAX_ENTRIES = 20;

type Entries = Record<string, { message: string; at: string }>;

function tokenKey(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 32);
}

function load(path: string): Entries {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Entries) : {};
  } catch {
    return {};
  }
}

export function expiredTokensPath(configPath = resolveConfigPath()): string {
  return join(dirname(configPath), "expired-tokens.json");
}

export function fileExpiredTokenStore(path = expiredTokensPath()): ExpiredTokenStore {
  return {
    lookup(token) {
      if (!token) return undefined;
      return load(path)[tokenKey(token)]?.message;
    },
    remember(token, message) {
      if (!token) return;
      try {
        const entries = load(path);
        entries[tokenKey(token)] = { message, at: new Date().toISOString() };
        const kept = Object.entries(entries)
          .sort((a, b) => b[1].at.localeCompare(a[1].at))
          .slice(0, MAX_ENTRIES);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `${JSON.stringify(Object.fromEntries(kept), null, 2)}\n`, {
          mode: 0o600,
        });
      } catch {
        // best-effort: the next call just asks the server again
      }
    },
  };
}
