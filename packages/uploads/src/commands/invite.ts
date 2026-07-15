/**
 * Workspace-admin email invite via ephemeral device session.
 * Not ADMIN_TOKEN, not a workspace upload token.
 */
import { createWorkspaceInvite, listMintWorkspaces } from "../client.js";
import { flagBool, flagString, parseCommandArgs, UsageError } from "../cli-args.js";
import {
  defaultDeviceIo,
  obtainDeviceAccessToken,
  resolveAuthUrl,
  type DeviceLoginIo,
} from "./login.js";

const HELP = `uploads invite create [options]

Invite someone to a workspace by email. Opens a browser so you approve as
yourself (device login). You must be an admin or owner of that workspace.

The invitee gets email when Email Sending is configured; either way the
CLI prints an accept URL you can share. After accepting they run uploads login.

Options:
  --email <address>     Required
  --workspace <name>    Required if you admin more than one workspace
  --role member|admin   Invitee org role (default: member)
  --auth-url <url>      Auth origin (default: derived from --api-url)
  --api-url <url>       API origin (default: https://api.uploads.sh)
  --no-open             Print the approval URL only

Examples:
  uploads invite create --email teammate@example.com
  uploads invite create --workspace acme --email teammate@example.com
`;

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
  io: DeviceLoginIo = defaultDeviceIo,
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

  const accessToken = await obtainDeviceAccessToken(
    authUrl,
    {
      noOpen: flagBool(parsed.flags, "--no-open"),
      prompt: "To invite as your account, open:",
    },
    io,
  );
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
    acceptUrl: result.acceptUrl ?? null,
    emailConfigured: result.emailConfigured ?? null,
  };
  if (opts.json) process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  else {
    process.stdout.write(
      `Invited ${email} to ${workspace} as ${role} (${result.invitation.status}).\n`,
    );
    if (result.emailConfigured === true) {
      process.stdout.write(`Invitation emailed to ${email}.\n`);
    } else if (result.emailConfigured === false) {
      process.stdout.write(
        "Email isn't configured on this install — share the accept link yourself.\n",
      );
    }
    if (result.acceptUrl) {
      const label =
        result.emailConfigured === true
          ? "Accept link (backup)"
          : result.emailConfigured === false
            ? "Accept link"
            : "Accept link (share if email isn't configured)";
      process.stdout.write(`${label}:\n  ${result.acceptUrl}\n`);
    }
    process.stdout.write("They accept, then run: uploads login\n");
  }
  return 0;
}
