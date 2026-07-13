/**
 * Workspace-admin email invite via ephemeral device session.
 * Does not use ADMIN_TOKEN or workspace upload tokens.
 */
import { spawn } from "node:child_process";
import {
  createWorkspaceInvite,
  listMintWorkspaces,
  requestDeviceCode,
  requestDeviceToken,
} from "../client.js";
import { flagBool, flagString, parseCommandArgs, UsageError } from "../cli-args.js";
import { resolveAuthUrl } from "./login.js";

const HELP = `uploads invite create [options]

Invite someone to a workspace by email. Opens a browser so you can approve
with your account (device login) — you must be an admin or owner of that
workspace. Does NOT use ADMIN_TOKEN or a workspace upload token.

The invitee gets an email, accepts at uploads.sh, then runs uploads login.

Options:
  --email <address>     Required. Invitee email
  --workspace <name>    Workspace to invite into (required if you admin more than one)
  --role member|admin   Org role for the invitee (default: member)
  --auth-url <url>      Auth base (default: derived from --api-url)
  --api-url <url>       API base (default: https://api.uploads.sh)
  --no-open             Don't open a browser automatically

Examples:
  uploads invite create --email teammate@example.com
  uploads invite create --workspace acme --email teammate@example.com --role member
`;

type DeviceIo = {
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  openUrl: (url: string) => void;
  write: (text: string) => void;
};

function openUrl(url: string): void {
  try {
    const isWin = process.platform === "win32";
    const command = process.platform === "darwin" ? "open" : isWin ? "cmd" : "xdg-open";
    const args = isWin ? ["/c", "start", "", url] : [url];
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // URL is printed for manual navigation.
  }
}

const defaultIo: DeviceIo = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  openUrl,
  write: (text) => {
    process.stderr.write(text);
  },
};

async function pollForDeviceToken(
  authUrl: string,
  code: { device_code: string; interval: number; expires_in: number },
  io: DeviceIo,
): Promise<string> {
  let intervalMs = Math.max(1, code.interval) * 1000;
  const deadline = io.now() + Math.max(1, code.expires_in) * 1000;
  while (io.now() < deadline) {
    await io.sleep(intervalMs);
    let result: Awaited<ReturnType<typeof requestDeviceToken>>;
    try {
      result = await requestDeviceToken(authUrl, { deviceCode: code.device_code });
    } catch {
      continue;
    }
    switch (result.status) {
      case "ok":
        return result.accessToken;
      case "pending":
        continue;
      case "slow_down":
        intervalMs += 5000;
        continue;
      case "denied":
        throw new UsageError("device authorization was denied");
      case "expired":
        throw new UsageError("the device code expired before it was approved");
      default:
        throw new UsageError(
          `device authorization failed: ${result.error}${
            result.description ? ` — ${result.description}` : ""
          }`,
        );
    }
  }
  throw new UsageError("timed out waiting for device authorization");
}

/** Exported for unit tests. */
export function resolveInviteWorkspace(
  workspaces: Array<{ workspace: string; role: string }>,
  requested: string | undefined,
): string {
  const adminable = workspaces.filter((w) => w.role === "admin" || w.role === "owner");
  if (requested) {
    const hit = adminable.find((w) => w.workspace === requested);
    if (!hit) {
      const roles = workspaces
        .filter((w) => w.workspace === requested)
        .map((w) => w.role)
        .join(", ");
      if (roles) {
        throw new UsageError(
          `you are ${roles} on ${requested}, not admin/owner — only workspace admins can invite`,
        );
      }
      throw new UsageError(`no admin access to workspace ${requested}`);
    }
    return hit.workspace;
  }
  if (adminable.length === 1) return adminable[0]!.workspace;
  if (adminable.length === 0) {
    throw new UsageError(
      "your account has no workspace admin access — ask a site operator or existing admin",
    );
  }
  const names = adminable.map((w) => w.workspace).join(", ");
  throw new UsageError(`multiple workspaces you admin (${names}); pass --workspace <name>`);
}

export async function runInvite(
  args: string[],
  opts: { json?: boolean; apiUrl?: string },
  help = false,
  io: DeviceIo = defaultIo,
): Promise<number> {
  const parsed = parseCommandArgs(args);
  if (help || parsed.help) {
    process.stderr.write(HELP);
    return 0;
  }
  if (parsed.positionals[0] !== "create") {
    throw new UsageError("expected: uploads invite create");
  }

  const email = flagString(parsed.flags, "--email");
  if (!email) throw new UsageError("--email is required");
  const roleRaw = flagString(parsed.flags, "--role") ?? "member";
  if (roleRaw !== "member" && roleRaw !== "admin") {
    throw new UsageError("--role must be member or admin");
  }
  const role = roleRaw as "member" | "admin";
  const requestedWorkspace = flagString(parsed.flags, "--workspace");
  const apiUrl = flagString(parsed.flags, "--api-url") ?? opts.apiUrl ?? "https://api.uploads.sh";
  const authUrl = resolveAuthUrl(parsed, apiUrl);

  if (flagBool(parsed.flags, "--non-interactive")) {
    throw new UsageError("invite requires a browser for device approval");
  }

  const code = await requestDeviceCode(authUrl);
  const verifyUrl = code.verification_uri_complete ?? code.verification_uri;
  io.write(
    `To invite as your account, open:\n\n  ${verifyUrl}\n\nand confirm this code:\n\n  ${code.user_code}\n\n`,
  );
  if (!flagBool(parsed.flags, "--no-open")) io.openUrl(verifyUrl);
  io.write("Waiting for approval…\n");

  const accessToken = await pollForDeviceToken(authUrl, code, io);
  const { workspaces } = await listMintWorkspaces(apiUrl, accessToken);
  const workspace = resolveInviteWorkspace(workspaces, requestedWorkspace);

  const result = await createWorkspaceInvite(apiUrl, accessToken, workspace, { email, role });
  const payload = {
    ok: true,
    workspace,
    email: result.invitation.email,
    role: result.invitation.role,
    invitationId: result.invitation.id,
    status: result.invitation.status,
  };
  if (opts.json) process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  else {
    process.stdout.write(
      `Invited ${email} to ${workspace} as ${role} (${result.invitation.status}).\nThey should check email, accept, then run uploads login.\n`,
    );
  }
  return 0;
}
