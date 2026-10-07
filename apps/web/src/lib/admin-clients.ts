/**
 * Pure helpers for the admin Clients view (`/admin/clients` and the workspace
 * drawer's Clients section): who a client-activity row belongs to, a label
 * for its surface, and whether its version trails the published CLI.
 */
import type { AdminClientActivity } from "./admin-api";
import { isNewerVersion, parseSemver } from "./cli-upgrade";

type ClientVersionStatus = "current" | "outdated" | "unknown";

/** Surfaces that run our npm package, so their version can be outdated. */
function runsCliPackage(row: Pick<AdminClientActivity, "surface">): boolean {
  return row.surface === "cli" || row.surface === "mcp-local";
}

/**
 * `outdated` when a CLI / local-MCP row's version trails `latest`; `unknown`
 * for hosted-MCP rows (the version is the MCP host's, not ours), a missing
 * latest, or an unparseable version.
 */
export function clientVersionStatus(
  row: Pick<AdminClientActivity, "surface" | "clientVersion">,
  latest: string | null,
): ClientVersionStatus {
  if (!runsCliPackage(row) || !latest || !row.clientVersion) return "unknown";
  if (!parseSemver(row.clientVersion) || !parseSemver(latest)) return "unknown";
  return isNewerVersion(latest, row.clientVersion) ? "outdated" : "current";
}

const SURFACE_LABELS: Record<string, string> = {
  cli: "CLI",
  "mcp-local": "Local MCP",
  "mcp-remote": "Hosted MCP",
};

export function surfaceLabel(surface: string): string {
  return SURFACE_LABELS[surface] ?? surface;
}

/**
 * Who the row's credential belongs to: the user's email, a service token's
 * label, the token label, or (legacy KV tokens carry neither) the token's
 * hash prefix.
 */
export function clientOwnerLabel(
  row: Pick<AdminClientActivity, "email" | "tokenLabel" | "serviceToken" | "principal">,
): string {
  if (row.serviceToken) return row.tokenLabel ?? "service token";
  const named = row.email ?? row.tokenLabel;
  if (named) return named;
  if (row.principal.startsWith("legacy:")) return `legacy token ${row.principal.slice(7)}`;
  return row.principal;
}

/** Client name + version for display; hosted MCP rows name the MCP host. */
export function clientLabel(row: Pick<AdminClientActivity, "clientName" | "surface">): string {
  if (runsCliPackage(row)) return "uploads";
  return row.clientName ?? "unknown";
}

interface ClientsSummary {
  /** CLI / local-MCP rows with a known status. */
  tracked: number;
  outdated: number;
}

export function summarizeClients(
  rows: AdminClientActivity[],
  latest: string | null,
): ClientsSummary {
  let tracked = 0;
  let outdated = 0;
  for (const row of rows) {
    const status = clientVersionStatus(row, latest);
    if (status === "unknown") continue;
    tracked += 1;
    if (status === "outdated") outdated += 1;
  }
  return { tracked, outdated };
}

let latestCliVersion: Promise<string | null> | undefined;

/**
 * Published CLI version from the same-origin `/cli-version.json` (cached at
 * the edge; see pages/cli-version.json.ts), fetched once per page and shared
 * by the Clients table and every drawer. Null when npm is unreachable (the
 * next call retries) — the views then show versions without an outdated
 * judgment.
 */
export function fetchLatestCliVersion(): Promise<string | null> {
  latestCliVersion ??= fetch("/cli-version.json")
    .then(async (res) => {
      if (!res.ok) return null;
      const body = (await res.json()) as { latest?: unknown };
      return typeof body.latest === "string" && body.latest.trim() ? body.latest.trim() : null;
    })
    .catch(() => null)
    .then((latest) => {
      if (latest === null) latestCliVersion = undefined;
      return latest;
    });
  return latestCliVersion;
}
