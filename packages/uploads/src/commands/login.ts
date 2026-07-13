import { hostname } from "node:os";
import { spawn } from "node:child_process";
import { stdin, stdout } from "node:process";
import {
  loadConfigFile,
  redactToken,
  resolveConfigPath,
  writeConfigKeys,
  workspaceFromToken,
} from "../config.js";
import {
  createUploadsClient,
  exchangeEnrollment,
  listMintWorkspaces,
  mintWorkspaceToken,
  requestDeviceCode,
  requestDeviceToken,
} from "../client.js";
import { flagBool, flagString, parseCommandArgs, UsageError } from "../cli-args.js";
import { parseScopes } from "./admin-enrollment.js";

const HELP = `uploads login [options]

Sign in and save workspace credentials. With no code, opens a browser to
authorize this device (recommended). Pass an enrollment code to use the
one-time code path instead.

Options:
  --workspace <name>  Workspace to mint a token for (device flow; required if
                      your account can access more than one)
  --scopes <list>     Comma-separated scopes (default: files:read,files:write)
  --label <text>      Token label (default: this machine's hostname)
  --auth-url <url>    Auth base (default: https://auth.uploads.sh)
  --no-open           Don't try to open a browser automatically
  --code <code>       Enrollment code in argv (visible in shell history)
  --code-stdin        Read an enrollment code from stdin
  --non-interactive   Never prompt
  --api-url <url>     API base (default: https://api.uploads.sh)
  --path <file>       Config destination
  --force             Replace existing saved credentials
  --no-check          Skip doctor verification

Examples:
  uploads login
  uploads login --workspace acme
  uploads login --code upe_… --force
  printf '%s' upe_… | uploads login --code-stdin --non-interactive
`;

export function validateEnrollmentCode(raw: string): string {
  const code = raw.trim();
  if (!/^upe_[A-Za-z0-9_-]{20,}$/.test(code)) throw new UsageError("invalid enrollment code");
  return code;
}

async function readLine(): Promise<string> {
  let out = "";
  for await (const chunk of stdin) {
    out += String(chunk);
    if (out.includes("\n")) break;
  }
  return out.split(/\r?\n/, 1)[0] ?? "";
}

async function hiddenPrompt(): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") return readLine();
  stdout.write("Enrollment code: ");
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      stdin.off("data", onData);
      stdin.off("error", onError);
      try {
        stdin.setRawMode(false);
      } finally {
        stdin.pause();
        stdout.write("\n");
      }
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\r" || char === "\n") return done();
        if (char === "\u0003") return done(new UsageError("login cancelled"));
        if (char === "\u007f") value = value.slice(0, -1);
        else value += char;
      }
    };
    const onError = (err: Error) => done(err);
    stdin.on("data", onData);
    stdin.on("error", onError);
  });
}

export async function resolveEnrollmentCode(
  parsed: ReturnType<typeof parseCommandArgs>,
  io: { isTTY: boolean; readLine: () => Promise<string>; hiddenPrompt: () => Promise<string> } = {
    isTTY: Boolean(stdin.isTTY),
    readLine,
    hiddenPrompt,
  },
): Promise<string> {
  const direct = flagString(parsed.flags, "--code");
  const env = process.env.UPLOADS_ENROLLMENT_CODE;
  const fromStdin = flagBool(parsed.flags, "--code-stdin");
  const sources = [Boolean(direct), Boolean(env), fromStdin].filter(Boolean).length;
  if (sources > 1) throw new UsageError("provide enrollment code through only one source");
  if (direct) return validateEnrollmentCode(direct);
  if (env) return validateEnrollmentCode(env);
  if (fromStdin) return validateEnrollmentCode(await io.readLine());
  if (flagBool(parsed.flags, "--non-interactive"))
    throw new UsageError("enrollment code required in non-interactive mode");
  if (!io.isTTY) return validateEnrollmentCode(await io.readLine());
  return validateEnrollmentCode(await io.hiddenPrompt());
}

/** True when the caller supplied an enrollment code (via flag, stdin, or env). */
function hasEnrollmentSource(parsed: ReturnType<typeof parseCommandArgs>): boolean {
  return (
    Boolean(flagString(parsed.flags, "--code")) ||
    flagBool(parsed.flags, "--code-stdin") ||
    Boolean(process.env.UPLOADS_ENROLLMENT_CODE)
  );
}

/**
 * Auth worker base URL: explicit flag > UPLOADS_AUTH_URL > swap an `api.` host
 * label for `auth.` > the production default. Local multi-worker dev (where
 * auth runs on a different loopback port than the API) needs an explicit
 * --auth-url / UPLOADS_AUTH_URL.
 */
export function resolveAuthUrl(
  parsed: ReturnType<typeof parseCommandArgs>,
  apiUrl: string,
): string {
  const explicit = flagString(parsed.flags, "--auth-url") ?? process.env.UPLOADS_AUTH_URL;
  if (explicit) return explicit.replace(/\/$/, "");
  try {
    const url = new URL(apiUrl);
    if (url.hostname.startsWith("api.")) {
      url.hostname = `auth.${url.hostname.slice(4)}`;
      return url.origin;
    }
  } catch {
    // fall through to the default
  }
  return "https://auth.uploads.sh";
}

/** Best-effort browser open. The URL is always printed too, so failures are silent. */
function openUrl(url: string): void {
  try {
    const isWin = process.platform === "win32";
    const command = process.platform === "darwin" ? "open" : isWin ? "cmd" : "xdg-open";
    const args = isWin ? ["/c", "start", "", url] : [url];
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // ignore — the URL is printed for manual navigation.
  }
}

export interface DeviceLoginIo {
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  openUrl: (url: string) => void;
  write: (text: string) => void;
}

const defaultDeviceIo: DeviceLoginIo = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  openUrl,
  write: (text) => {
    process.stderr.write(text);
  },
};

interface LoginResult {
  workspace: string;
  token: string;
  apiUrl?: string;
}

/**
 * Device-authorization login (RFC 8628): request a code, have the user approve
 * it in a browser, poll for the session token, then mint a workspace token.
 */
async function runDeviceLogin(
  parsed: ReturnType<typeof parseCommandArgs>,
  opts: { apiUrl: string; authUrl: string; noOpen: boolean },
  io: DeviceLoginIo,
): Promise<LoginResult> {
  const scopes = parseScopes(flagString(parsed.flags, "--scopes"));
  const label = flagString(parsed.flags, "--label") ?? safeHostname();
  const requestedWorkspace = flagString(parsed.flags, "--workspace");

  const code = await requestDeviceCode(opts.authUrl);
  const verifyUrl = code.verification_uri_complete ?? code.verification_uri;
  io.write(
    `To sign in, open:\n\n  ${verifyUrl}\n\nand confirm this code:\n\n  ${code.user_code}\n\n`,
  );
  if (!opts.noOpen) io.openUrl(verifyUrl);
  io.write("Waiting for approval…\n");

  const accessToken = await pollForDeviceToken(opts.authUrl, code, io);

  const workspace = await resolveMintWorkspace(opts.apiUrl, accessToken, requestedWorkspace);
  const minted = await mintWorkspaceToken(opts.apiUrl, accessToken, { workspace, scopes, label });
  return { workspace: minted.workspace, token: minted.token, apiUrl: opts.apiUrl };
}

function safeHostname(): string {
  try {
    return hostname() || "cli";
  } catch {
    return "cli";
  }
}

/** Poll device/token honoring interval / slow_down / pending until approved or expired. */
async function pollForDeviceToken(
  authUrl: string,
  code: { device_code: string; interval: number; expires_in: number },
  io: DeviceLoginIo,
): Promise<string> {
  let intervalMs = Math.max(1, code.interval) * 1000;
  const deadline = io.now() + Math.max(1, code.expires_in) * 1000;
  while (io.now() < deadline) {
    await io.sleep(intervalMs);
    let result: Awaited<ReturnType<typeof requestDeviceToken>>;
    try {
      result = await requestDeviceToken(authUrl, { deviceCode: code.device_code });
    } catch {
      // A transient network blip mid-poll shouldn't abort a login the user may
      // already have approved — keep polling until the device code's deadline.
      continue;
    }
    switch (result.status) {
      case "ok":
        return result.accessToken;
      case "pending":
        continue;
      case "slow_down":
        // RFC 8628 §3.5: back off by 5s and keep polling.
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

/**
 * Pick the workspace to mint for. An explicit --workspace wins; otherwise, if
 * the account can access exactly one workspace, use it — and if it can access
 * several, require the flag rather than guessing.
 */
async function resolveMintWorkspace(
  apiUrl: string,
  accessToken: string,
  requested: string | undefined,
): Promise<string> {
  if (requested) return requested;
  const { workspaces } = await listMintWorkspaces(apiUrl, accessToken);
  if (workspaces.length === 1) return workspaces[0]!.workspace;
  if (workspaces.length === 0) {
    throw new UsageError(
      "your account has no workspace access yet — ask an administrator for an invitation",
    );
  }
  const names = workspaces.map((w) => w.workspace).join(", ");
  throw new UsageError(`multiple workspaces available (${names}); pass --workspace <name>`);
}

export async function runLogin(
  args: string[],
  opts: { json?: boolean; apiUrl?: string },
  help = false,
  deviceIo: DeviceLoginIo = defaultDeviceIo,
): Promise<number> {
  const parsed = parseCommandArgs(args);
  if (help || parsed.help) {
    process.stderr.write(HELP);
    return 0;
  }
  const apiUrl = flagString(parsed.flags, "--api-url") ?? opts.apiUrl ?? "https://api.uploads.sh";
  const path = flagString(parsed.flags, "--path") ?? resolveConfigPath();
  const force = flagBool(parsed.flags, "--force");
  const existing = loadConfigFile(path);
  if (existing.UPLOADS_TOKEN && !force)
    throw new UsageError(`credentials already exist in ${path}; use --force to replace them`);
  if (process.env.UPLOADS_TOKEN && !force)
    throw new UsageError(
      "UPLOADS_TOKEN is already set in the environment; unset it or use --force",
    );

  let result: LoginResult;
  if (hasEnrollmentSource(parsed)) {
    const code = await resolveEnrollmentCode(parsed);
    result = await exchangeEnrollment(apiUrl, code);
  } else {
    // The device flow is inherently interactive (browser approval, then a poll
    // that runs to the device code's ~30-min deadline). Fail fast rather than
    // hanging a non-interactive/CI invocation that has no code to fall back on.
    if (flagBool(parsed.flags, "--non-interactive")) {
      throw new UsageError(
        "device login requires a browser; run interactively, or pass --code for the enrollment path",
      );
    }
    const authUrl = resolveAuthUrl(parsed, apiUrl);
    result = await runDeviceLogin(
      parsed,
      { apiUrl, authUrl, noOpen: flagBool(parsed.flags, "--no-open") },
      deviceIo,
    );
  }

  const encoded = workspaceFromToken(result.token);
  if (!encoded || encoded !== result.workspace || /[\r\n]/.test(result.token))
    throw new UsageError("login returned invalid credentials");
  const savedApiUrl = result.apiUrl ?? apiUrl;
  const write = writeConfigKeys(
    path,
    {
      UPLOADS_API_URL: savedApiUrl,
      UPLOADS_WORKSPACE: result.workspace,
      UPLOADS_TOKEN: result.token,
    },
    { force },
  );
  if (
    !["UPLOADS_API_URL", "UPLOADS_WORKSPACE", "UPLOADS_TOKEN"].every((key) =>
      write.updated.includes(key),
    )
  )
    throw new UsageError("credentials were not fully written; retry with --force");
  const checked = !flagBool(parsed.flags, "--no-check");
  let doctor = { ok: true, error: undefined as string | undefined };
  if (checked) {
    try {
      const client = createUploadsClient({
        apiUrl: savedApiUrl,
        workspace: result.workspace,
        token: result.token,
      });
      const health = await client.health();
      if (!health.ok) throw new Error("API unhealthy");
      await client.list({ limit: 1 });
    } catch (err) {
      doctor = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  const payload = {
    ok: doctor.ok,
    configPath: path,
    workspace: result.workspace,
    token: redactToken(result.token),
    doctor: checked ? doctor : { skipped: true },
  };
  if (opts.json) process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  else {
    process.stdout.write(
      `saved credentials to ${path}\nworkspace: ${result.workspace}\ntoken: ${redactToken(result.token)}\n`,
    );
    process[doctor.ok ? "stdout" : "stderr"].write(
      `doctor: ${checked ? (doctor.ok ? "ok" : `failed — ${doctor.error}`) : "skipped"}\n`,
    );
  }
  return doctor.ok ? 0 : 1;
}
