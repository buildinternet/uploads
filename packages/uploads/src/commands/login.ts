import { hostname } from "node:os";
import { createInterface } from "node:readline/promises";
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
  createWorkspaceRequest,
  exchangeEnrollment,
  listMintWorkspaces,
  mintWorkspaceToken,
  requestDeviceCode,
  requestDeviceToken,
} from "../client.js";
import { flagBool, flagString, parseCommandArgs, UsageError } from "../cli-args.js";
import { parseScopes } from "./admin-enrollment.js";
import { writeCommandHelp } from "../cli-style.js";

const HELP = `uploads login [options]

Sign in and save workspace credentials. With no flags, opens a browser to
authorize this device — the recommended way to sign in. Pass an enrollment
code only if you were given one from before device login (fallback path).

Options:
  --workspace <name>  Workspace to mint a token for (device flow; required if
                      your account can access more than one)
  --create            With --workspace: create the workspace first if your
                      account doesn't have it yet (device flow only) — lets
                      scripted/agent logins provision without a prompt
  --scopes <list>     Comma-separated scopes (default:
                      files:read,files:write,files:delete)
  --label <text>      Token label (default: this machine's hostname)
  --auth-url <url>    Auth base (default: https://auth.uploads.sh)
  --no-open           Don't try to open a browser automatically
  --code <code>       Fallback: use a pre-existing enrollment code instead of
                      device login (visible in shell history)
  --code-stdin        Fallback: read a pre-existing enrollment code from stdin
  --non-interactive   Never prompt
  --api-url <url>     API base (default: https://api.uploads.sh)
  --path <file>       Config destination
  --force             Replace existing saved credentials
  --no-check          Skip doctor verification

Examples:
  uploads login
  uploads login --workspace acme
  uploads login --workspace acme --create         # provision if it doesn't exist
  uploads login --code upe_… --force              # fallback: pre-existing invite
  printf '%s' upe_… | uploads login --code-stdin --non-interactive
`;

export function validateEnrollmentCode(raw: string): string {
  const code = raw.trim();
  if (!/^upe_[A-Za-z0-9_-]{20,}$/.test(code)) throw new UsageError("invalid enrollment code");
  return code;
}

/**
 * Device-code scope vocabulary (issue #362). Mirrors `parseDeviceScope` /
 * `workspaceScopeValue` in apps/auth/src/device-workspace.ts — this package
 * ships with no workspace dependencies, so the two copies are deliberately
 * independent. Keep the vocabulary in sync.
 */
const WORKSPACE_SCOPE_PREFIX = "workspace:";
const CREATE_SCOPE_TOKEN = "create";

/** The scope the CLI sends with its device-code request. No workspace requested → no scope. */
export function formatDeviceScope(
  workspace: string | undefined,
  create: boolean,
): string | undefined {
  if (!workspace) return undefined;
  return create
    ? `${WORKSPACE_SCOPE_PREFIX}${workspace} ${CREATE_SCOPE_TOKEN}`
    : `${WORKSPACE_SCOPE_PREFIX}${workspace}`;
}

/**
 * Read back what the approval page decided. A surviving `create` token means
 * the page left the scope alone and deferred provisioning to the CLI; a bare
 * `workspace:<slug>` means the browser recorded a choice and wins.
 */
export function parseDeviceScope(scope: string | undefined): {
  workspace: string | undefined;
  create: boolean;
} {
  const tokens = (scope ?? "").split(/\s+/).filter(Boolean);
  const slug =
    tokens
      .find((t) => t.startsWith(WORKSPACE_SCOPE_PREFIX))
      ?.slice(WORKSPACE_SCOPE_PREFIX.length) ?? "";
  return { workspace: slug || undefined, create: tokens.includes(CREATE_SCOPE_TOKEN) };
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
  /** Whether the CLI can prompt the user (a real TTY, not a script/CI pipe). */
  isTTY: boolean;
  /** Prompt for a new workspace name when the account has zero. */
  promptWorkspaceName: () => Promise<string>;
}

async function promptWorkspaceName(): Promise<string> {
  const rl = createInterface({ input: stdin, output: process.stderr });
  try {
    return (
      await rl.question("no workspaces yet — enter a name to create one (lowercase, hyphens): ")
    ).trim();
  } finally {
    rl.close();
  }
}

export const defaultDeviceIo: DeviceLoginIo = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  openUrl,
  write: (text) => {
    process.stderr.write(text);
  },
  isTTY: Boolean(stdin.isTTY),
  promptWorkspaceName,
};

/** A completed device authorization: the session bearer plus the (possibly rewritten) scope. */
export interface DeviceSession {
  accessToken: string;
  scope: string;
}

/**
 * Browser device-authorization session only (no workspace token mint).
 * Shared by `uploads login` and `uploads invite create`.
 */
export async function obtainDeviceSession(
  authUrl: string,
  opts: { noOpen?: boolean; prompt?: string; scope?: string } = {},
  io: DeviceLoginIo = defaultDeviceIo,
): Promise<DeviceSession> {
  const code = await requestDeviceCode(authUrl, undefined, opts.scope);
  const verifyUrl = code.verification_uri_complete ?? code.verification_uri;
  const prompt = opts.prompt ?? "To sign in, open:";
  io.write(`${prompt}\n\n  ${verifyUrl}\n\nand confirm this code:\n\n  ${code.user_code}\n\n`);
  if (!opts.noOpen) io.openUrl(verifyUrl);
  io.write("Waiting for approval…\n");
  return pollForDeviceToken(authUrl, code, io);
}

/** Session bearer only — `invite create` has no workspace to resolve. */
export async function obtainDeviceAccessToken(
  authUrl: string,
  opts: { noOpen?: boolean; prompt?: string } = {},
  io: DeviceLoginIo = defaultDeviceIo,
): Promise<string> {
  return (await obtainDeviceSession(authUrl, opts, io)).accessToken;
}

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
  // Interactive login is the user's own credential: default to the full file
  // scope set (including delete) so the CLI's own `delete` command works out
  // of the box. Automation tokens minted elsewhere keep the server's
  // conservative read+write default — narrowness there is a deliberate
  // choice, not a surprise. `--scopes` still overrides.
  const scopes = parseScopes(flagString(parsed.flags, "--scopes")) ?? [
    "files:read",
    "files:write",
    "files:delete",
  ];
  const label = flagString(parsed.flags, "--label") ?? safeHostname();
  const requestedWorkspace = flagString(parsed.flags, "--workspace");

  // Make the target explicit: a bare `uploads login` on a self-hosted install
  // would otherwise silently sign in to the cloud service.
  io.write(
    `signing in to ${opts.authUrl} (self-hosted? pass --api-url or set UPLOADS_API_URL)\n\n`,
  );
  const create = flagBool(parsed.flags, "--create");
  const session = await obtainDeviceSession(
    opts.authUrl,
    { noOpen: opts.noOpen, scope: formatDeviceScope(requestedWorkspace, create) },
    io,
  );

  // The approval page is authoritative: it validated the workspace against the
  // signed-in account's memberships (and may have created a new one) before
  // approving. A scope that still carries `create` means the page deferred to
  // the CLI, and an empty one means an older server that doesn't echo a
  // choice — both fall back to the local resolution below.
  const chosen = parseDeviceScope(session.scope);
  const workspace =
    chosen.workspace && !chosen.create
      ? chosen.workspace
      : await resolveMintWorkspace(
          opts.apiUrl,
          session.accessToken,
          requestedWorkspace,
          io,
          create,
        );
  const minted = await mintWorkspaceToken(opts.apiUrl, session.accessToken, {
    workspace,
    scopes,
    label,
  });
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
export async function pollForDeviceToken(
  authUrl: string,
  code: { device_code: string; interval: number; expires_in: number },
  io: DeviceLoginIo,
): Promise<DeviceSession> {
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
        return { accessToken: result.accessToken, scope: result.scope };
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
 * Pick the workspace to mint for. An explicit --workspace wins (with --create,
 * it's provisioned first when the account doesn't have it); otherwise, if the
 * account can access exactly one workspace, use it — and if it can access
 * several, require the flag rather than guessing.
 */
async function resolveMintWorkspace(
  apiUrl: string,
  accessToken: string,
  requested: string | undefined,
  io: DeviceLoginIo,
  create = false,
): Promise<string> {
  if (requested) {
    if (!create) return requested;
    // Idempotent from the caller's view: an existing membership just mints.
    const { workspaces } = await listMintWorkspaces(apiUrl, accessToken);
    if (workspaces.some((w) => w.workspace === requested)) return requested;
    const created = await createWorkspaceRequest(apiUrl, accessToken, requested);
    io.write(
      `created workspace "${created.name}" — files will get public URLs under ${created.publicBaseUrl}/\n`,
    );
    return created.name;
  }
  const { workspaces } = await listMintWorkspaces(apiUrl, accessToken);
  if (workspaces.length === 1) return workspaces[0]!.workspace;
  if (workspaces.length === 0) {
    if (!io.isTTY) {
      throw new UsageError(
        "your account has no workspace access yet — pass `--workspace <name> --create` to provision one, run `uploads login` interactively, or ask an administrator for an invitation",
      );
    }
    const name = (await io.promptWorkspaceName()).trim();
    if (!name) throw new UsageError("workspace creation cancelled");
    const created = await createWorkspaceRequest(apiUrl, accessToken, name);
    io.write(
      `created workspace "${created.name}" — files will get public URLs under ${created.publicBaseUrl}/\n`,
    );
    return created.name;
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
    writeCommandHelp(HELP);
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

  if (flagBool(parsed.flags, "--create") && !flagString(parsed.flags, "--workspace"))
    throw new UsageError("--create requires --workspace <name>");

  let result: LoginResult;
  if (hasEnrollmentSource(parsed)) {
    if (flagBool(parsed.flags, "--create"))
      throw new UsageError("--create is device-flow only; enrollment codes are workspace-bound");
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
    apiUrl: savedApiUrl,
    workspace: result.workspace,
    token: redactToken(result.token),
    doctor: checked ? doctor : { skipped: true },
  };
  if (opts.json) process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  else {
    process.stdout.write(
      `saved credentials to ${path}\napi: ${savedApiUrl}\nworkspace: ${result.workspace}\ntoken: ${redactToken(result.token)}\n`,
    );
    process[doctor.ok ? "stdout" : "stderr"].write(
      `doctor: ${checked ? (doctor.ok ? "ok" : `failed — ${doctor.error}`) : "skipped"}\n`,
    );
    if (doctor.ok)
      process.stdout.write(
        "\nusing a coding agent? run `uploads install` to add the uploads skill + MCP server to Claude Code\n",
      );
  }
  return doctor.ok ? 0 : 1;
}
