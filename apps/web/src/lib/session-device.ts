/**
 * Labels for Better Auth session User-Agent strings + CLI detection.
 * Keep the CLI prefix in sync with packages/uploads `cliUserAgent()`.
 */

const BROWSERS: [RegExp, string][] = [
  [/Edg\//, "Edge"],
  [/OPR\/|Opera/, "Opera"],
  [/Firefox\//, "Firefox"],
  [/Chrome\//, "Chrome"],
  [/Safari\//, "Safari"],
];
const OSES: [RegExp, string][] = [
  [/iPhone|iPad|iPod/, "iOS"],
  [/Android/, "Android"],
  [/Mac OS X|Macintosh/, "macOS"],
  [/Windows/, "Windows"],
  [/Linux/, "Linux"],
];

export const CLI_USER_AGENT_RE = /@buildinternet\/uploads(?:\/[\w.-]+)?/i;

export function isCliUserAgent(ua?: string | null): boolean {
  return Boolean(ua && CLI_USER_AGENT_RE.test(ua));
}

/**
 * "Chrome on macOS" / "uploads CLI 1.2.3" / "Unknown device".
 * Prefer session.cliVersion when present (refreshed after CLI upgrade).
 */
export function deviceLabel(ua?: string | null, opts?: { cliVersion?: string | null }): string {
  const cliVersion = opts?.cliVersion?.trim();
  if (cliVersion || isCliUserAgent(ua)) {
    const version = cliVersion || ua?.match(/@buildinternet\/uploads\/([\w.-]+)/i)?.[1];
    return version ? `uploads CLI ${version}` : "uploads CLI";
  }
  if (!ua) return "Unknown device";
  const browser = BROWSERS.find(([re]) => re.test(ua))?.[1] ?? "Browser";
  const os = OSES.find(([re]) => re.test(ua))?.[1] ?? "";
  return os ? `${browser} on ${os}` : browser;
}

export function formatSessionTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
