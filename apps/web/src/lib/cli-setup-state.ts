/**
 * Account overview CLI setup card: list-sessions + sticky `cliOnboardedAt`.
 */

import { isCliUserAgent } from "./session-device";

export type CliSetupKind = "checking" | "ready" | "reconnect" | "setup";

export type CliSetupPresentation = {
  kind: CliSetupKind;
  statusText: string;
  statusState?: "muted" | "ready";
};

export function resolveCliSetupState(input: {
  sessions: Array<{ userAgent?: string | null }> | null;
  cliOnboardedAt?: string | Date | null;
  loaded: boolean;
}): CliSetupPresentation {
  if (!input.loaded) {
    return {
      kind: "checking",
      statusText: "Checking for a CLI sign-in…",
      statusState: "muted",
    };
  }

  const hasCli = input.sessions?.some((s) => isCliUserAgent(s.userAgent)) ?? false;
  if (hasCli) {
    return {
      kind: "ready",
      statusText: "CLI sign-in found on an active session. You’re set.",
      statusState: "ready",
    };
  }

  // Sticky flag survives expired CLI sessions (list-sessions is active-only).
  if (input.cliOnboardedAt != null && input.cliOnboardedAt !== "") {
    return {
      kind: "reconnect",
      statusText: "You’ve set up the CLI before. Run uploads login on a machine that needs tokens.",
    };
  }

  // list-sessions failed: still nudge install — don't frame it as a hard error.
  if (input.sessions === null) {
    return {
      kind: "setup",
      statusText:
        "Install the CLI and run uploads login to connect this account from your terminal.",
    };
  }

  return {
    kind: "setup",
    statusText: "No CLI session yet. Finish setup below so your terminal and agents can upload.",
  };
}
