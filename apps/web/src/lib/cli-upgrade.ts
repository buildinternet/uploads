/**
 * Account UI: compare session.cliVersion to the published npm latest and
 * decide whether to show an upgrade callout (issue #459).
 */

export const CLI_PACKAGE = "@buildinternet/uploads";
export const CLI_INSTALL_CMD = `npm i -g ${CLI_PACKAGE}`;
/** Shown to users who already have the CLI, so it can name the CLI's own verb. */
export const CLI_UPDATE_CMD = "uploads update";
/** Session-storage dismiss key prefix; full key includes the latest version. */
export const CLI_UPGRADE_DISMISS_PREFIX = "uploads:cli-upgrade-dismissed:";

/** Parse major.minor.patch (ignores pre-release). Same rules as CLI update-check. */
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
    if (a[i]! > b[i]!) return true;
    if (a[i]! < b[i]!) return false;
  }
  return false;
}

export type SessionLike = {
  cliVersion?: string | null;
  userAgent?: string | null;
  updatedAt?: string | Date | null;
};

/** Prefer explicit cliVersion, else parse create-time UA; pick the freshest CLI session. */
export function bestCliVersion(sessions: SessionLike[] | null | undefined): string | null {
  if (!sessions?.length) return null;
  const cli = sessions
    .map((s) => {
      const fromField = typeof s.cliVersion === "string" ? s.cliVersion.trim() : "";
      const fromUa = s.userAgent?.match(/@buildinternet\/uploads\/([\w.-]+)/i)?.[1] ?? "";
      const version = fromField || fromUa || null;
      if (!version) return null;
      const t = s.updatedAt ? new Date(s.updatedAt).getTime() : 0;
      return { version, t: Number.isFinite(t) ? t : 0 };
    })
    .filter((x): x is { version: string; t: number } => x != null);
  if (!cli.length) return null;
  cli.sort((a, b) => b.t - a.t);
  return cli[0]!.version;
}

export type UpgradePrompt = {
  current: string;
  latest: string;
  installCmd: string;
  message: string;
};

/** Null when current is missing, latest is missing, or already up to date. */
export function resolveUpgradePrompt(
  current: string | null | undefined,
  latest: string | null | undefined,
): UpgradePrompt | null {
  const cur = current?.trim();
  const lat = latest?.trim();
  if (!cur || !lat) return null;
  if (!isNewerVersion(lat, cur)) return null;
  return {
    current: cur,
    latest: lat,
    installCmd: CLI_UPDATE_CMD,
    message: `You’re on CLI ${cur}; ${lat} is available. Update: ${CLI_UPDATE_CMD}`,
  };
}

export function dismissStorageKey(latest: string): string {
  return `${CLI_UPGRADE_DISMISS_PREFIX}${latest.trim()}`;
}

export function isUpgradeDismissed(
  latest: string,
  storage: Pick<Storage, "getItem"> | null | undefined,
): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(dismissStorageKey(latest)) === "1";
  } catch {
    return false;
  }
}

export function dismissUpgrade(
  latest: string,
  storage: Pick<Storage, "setItem"> | null | undefined,
): void {
  if (!storage) return;
  try {
    storage.setItem(dismissStorageKey(latest), "1");
  } catch {
    // private mode / quota — ignore
  }
}
