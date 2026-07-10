import { createEnrollment } from "../client.js";
import { flagInt, flagString, parseCommandArgs, UsageError } from "../cli-args.js";

const HELP = `uploads admin enrollment create [options]

Admin-only: create a short-lived, one-time enrollment code.

Options:
  --admin-token <token>  Or ADMIN_TOKEN (UPLOADS_ADMIN_TOKEN is a legacy alias)
  --workspace <name>     Default: default
  --label <label>
  --expires-in <seconds> Default: server policy
  --token-expires-in <seconds>  Upload token lifetime (default: server policy)
  --scopes <list>        Comma-separated files:read,files:write,files:delete
  --api-url <url>        Default: https://api.uploads.sh
`;

type FileScope = "files:read" | "files:write" | "files:delete";
const FILE_SCOPES = new Set<FileScope>(["files:read", "files:write", "files:delete"]);

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
  if (parsed.positionals[0] !== "enrollment" || parsed.positionals[1] !== "create")
    throw new UsageError("expected: uploads admin enrollment create");
  const adminToken =
    flagString(parsed.flags, "--admin-token") ??
    process.env.ADMIN_TOKEN ??
    process.env.UPLOADS_ADMIN_TOKEN;
  if (!adminToken) throw new UsageError("ADMIN_TOKEN is required for admin enrollment creation");
  const apiUrl = flagString(parsed.flags, "--api-url") ?? opts.apiUrl ?? "https://api.uploads.sh";
  const workspace = flagString(parsed.flags, "--workspace") ?? "default";
  const label = flagString(parsed.flags, "--label");
  const result = await createEnrollment(apiUrl, adminToken, {
    workspace,
    label,
    enrollmentSeconds: flagInt(parsed.flags, "--expires-in", "--expires-in"),
    tokenExpiresInSeconds: flagInt(parsed.flags, "--token-expires-in", "--token-expires-in"),
    scopes: parseScopes(flagString(parsed.flags, "--scopes")),
  });
  if (opts.json)
    process.stdout.write(
      JSON.stringify({ workspace, label: label ?? null, ...result }, null, 2) + "\n",
    );
  else
    process.stdout.write(
      `Enrollment code (share once): ${result.code}\nworkspace: ${workspace}\nexpires: ${result.expiresAt}\n`,
    );
  return 0;
}
