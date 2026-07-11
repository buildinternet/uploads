import { createEnrollment } from "../client.js";
import { flagBool, flagInt, flagString, parseCommandArgs, UsageError } from "../cli-args.js";

const HELP = `uploads admin invite create [options]

Admin-only: create a short-lived invitation for an existing workspace.
Prints one magic link whose URL fragment carries the single-use code — treat the
link like a password. Pass --separate-code for the legacy two-channel output (a
non-secret page URL plus a code you share separately). The legacy
"admin enrollment create" spelling is accepted.

Options:
  --admin-token <token>  Or ADMIN_TOKEN (UPLOADS_ADMIN_TOKEN is a legacy alias)
  --workspace <name>     Default: default
  --label <label>
  --expires-in <seconds> Default: server policy
  --token-expires-in <seconds>  Upload token lifetime (default: server policy)
  --scopes <list>        Comma-separated files:read,files:write,files:delete
  --email <address>      Email the invite link to this recipient (from invites@uploads.sh)
  --separate-code        Two-channel output: non-secret page URL + separate code
  --api-url <url>        Default: https://api.uploads.sh
  --web-url <url>        Invite-page origin (defaults from --api-url)
`;

type FileScope = "files:read" | "files:write" | "files:delete";
const FILE_SCOPES = new Set<FileScope>(["files:read", "files:write", "files:delete"]);

export function invitePageUrl(apiUrl: string, pageId: string, webUrl?: string): string {
  let url: URL;
  try {
    url = new URL(webUrl ?? apiUrl);
  } catch {
    throw new UsageError("invalid invite web URL");
  }
  if (!webUrl && url.hostname.startsWith("api.")) url.hostname = url.hostname.slice(4);
  url.pathname = "/invite";
  url.search = "";
  url.hash = "";
  url.searchParams.set("id", pageId);
  return url.toString();
}

// Compose the self-contained magic link. The one-time code rides in the URL
// fragment (#code=…), which browsers never send to the server, so opening the
// page neither leaks nor consumes it — only the CLI's exchange call redeems it.
export function inviteMagicLink(pageUrl: string, code: string): string {
  return `${pageUrl}#code=${encodeURIComponent(code)}`;
}

export function parseScopes(raw: string | undefined): FileScope[] | undefined {
  if (raw === undefined) return undefined;
  const scopes = raw
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
  if (scopes.length === 0) throw new UsageError("--scopes must contain at least one scope");
  const invalid = scopes.find((scope) => !FILE_SCOPES.has(scope as FileScope));
  if (invalid)
    throw new UsageError(
      `invalid scope: ${invalid} (expected files:read, files:write, or files:delete)`,
    );
  return [...new Set(scopes)] as FileScope[];
}

export async function runAdmin(
  args: string[],
  opts: { json?: boolean; apiUrl?: string },
  help = false,
): Promise<number> {
  const parsed = parseCommandArgs(args);
  if (help || parsed.help) {
    process.stderr.write(HELP);
    return 0;
  }
  if (
    !["invite", "enrollment"].includes(parsed.positionals[0] ?? "") ||
    parsed.positionals[1] !== "create"
  )
    throw new UsageError("expected: uploads admin invite create");
  const adminToken =
    flagString(parsed.flags, "--admin-token") ??
    process.env.ADMIN_TOKEN ??
    process.env.UPLOADS_ADMIN_TOKEN;
  if (!adminToken) throw new UsageError("ADMIN_TOKEN is required for admin enrollment creation");
  const apiUrl = flagString(parsed.flags, "--api-url") ?? opts.apiUrl ?? "https://api.uploads.sh";
  const webUrl = flagString(parsed.flags, "--web-url");
  const workspace = flagString(parsed.flags, "--workspace") ?? "default";
  const label = flagString(parsed.flags, "--label");
  const email = flagString(parsed.flags, "--email");
  const result = await createEnrollment(apiUrl, adminToken, {
    workspace,
    label,
    email,
    enrollmentSeconds: flagInt(parsed.flags, "--expires-in", "--expires-in"),
    tokenExpiresInSeconds: flagInt(parsed.flags, "--token-expires-in", "--token-expires-in"),
    scopes: parseScopes(flagString(parsed.flags, "--scopes")),
  });
  const separateCode = flagBool(parsed.flags, "--separate-code");
  const pageUrl = invitePageUrl(apiUrl, result.pageId, webUrl);
  const link = separateCode ? pageUrl : inviteMagicLink(pageUrl, result.code);
  const footer = `workspace: ${workspace}\nexpires: ${result.expiresAt}\n`;
  if (opts.json) {
    process.stdout.write(
      JSON.stringify({ workspace, label: label ?? null, url: link, ...result }, null, 2) + "\n",
    );
    return 0;
  }
  if (email && result.emailed) {
    process.stdout.write(`Invite emailed to ${email}\n${footer}`);
    return 0;
  }
  if (email && result.emailed === false)
    process.stderr.write("warning: email delivery failed; share this link instead\n");
  if (separateCode)
    process.stdout.write(
      `Invite page: ${pageUrl}\nOne-time code (share separately): ${result.code}\n${footer}`,
    );
  else
    process.stdout.write(
      `Invite link (contains the one-time code — treat like a password):\n${link}\n${footer}`,
    );
  return 0;
}
