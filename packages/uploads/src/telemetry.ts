/**
 * Anonymous, opt-out usage telemetry for the CLI and MCP server.
 *
 * Sends command names, timing, exit codes, and optional error codes only —
 * never arguments, paths, tokens, workspace names, or content.
 *
 * Opt out:
 *   UPLOADS_TELEMETRY_DISABLED=1
 *   DO_NOT_TRACK=1
 *   uploads telemetry disable
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { DEFAULT_API_URL } from "./config.js";
import { packageVersion } from "./package-version.js";

const ANON_ID_FILE = "telemetry-id";
const DISABLE_FILE = "telemetry-disabled";
const NOTICE_FILE = "telemetry-notice-shown";
const POST_TIMEOUT_MS = 1500;
const MAX_COMMAND = 120;

/** Known root commands that take a subcommand as the second positional. */
const NESTED_COMMANDS = new Set([
  "admin",
  "completion",
  "completions",
  "config",
  "gallery",
  "install",
  "meta",
  "telemetry",
]);

export type TelemetrySurface = "cli" | "mcp";
export type TelemetryClientKind = "external" | "ci" | "agent";

export interface TelemetryEventInput {
  surface: TelemetrySurface;
  command: string;
  exitCode?: number;
  durationMs?: number;
  /** UploadsError code or USAGE — never free-form messages. */
  errorCode?: string;
}

export interface RecordEventOptions {
  /** Override data directory (tests). */
  dataDir?: string;
  /** Override API base URL (tests / --api-url). */
  apiUrl?: string;
  fetchImpl?: typeof fetch;
  now?: number;
  version?: string;
}

function truthyEnv(name: string): boolean {
  const v = process.env[name];
  if (!v) return false;
  const lower = v.toLowerCase();
  return lower !== "0" && lower !== "false" && lower !== "no";
}

/** XDG data dir for long-lived telemetry state (anon id, disable marker). */
export function defaultTelemetryDataDir(): string {
  const base = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(base, "uploads");
}

function filePath(name: string, dataDir?: string): string {
  return join(dataDir ?? defaultTelemetryDataDir(), name);
}

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

function safeWrite(path: string, content: string, mode?: number): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
    if (mode !== undefined) chmodSync(path, mode);
  } catch {
    // Telemetry must never throw or break the CLI.
  }
}

export function getOrCreateAnonId(dataDir?: string): string {
  const path = filePath(ANON_ID_FILE, dataDir);
  const existing = safeRead(path);
  if (existing && existing.length > 0) return existing;
  const id = randomUUID();
  safeWrite(path, id, 0o600);
  return id;
}

export function isTelemetryEnabled(dataDir?: string): boolean {
  if (truthyEnv("UPLOADS_TELEMETRY_DISABLED")) return false;
  if (process.env.DO_NOT_TRACK === "1") return false;
  // Vitest sets VITEST=true — never open a network connection from other suites.
  // Opt in for this package's own telemetry tests with UPLOADS_TELEMETRY_TEST=1.
  if (process.env.VITEST && process.env.UPLOADS_TELEMETRY_TEST !== "1") return false;
  if (existsSync(filePath(DISABLE_FILE, dataDir))) return false;
  return true;
}

export function setTelemetryEnabled(enabled: boolean, dataDir?: string): void {
  const path = filePath(DISABLE_FILE, dataDir);
  if (enabled) {
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {
      // ignore
    }
  } else {
    safeWrite(path, "disabled\n");
  }
}

export function detectClientKind(): {
  kind: TelemetryClientKind;
  agentName?: string;
} {
  const envKind = process.env.UPLOADS_CLIENT_KIND;
  if (envKind === "external" || envKind === "ci" || envKind === "agent") {
    return { kind: envKind, agentName: process.env.UPLOADS_CLIENT_AGENT };
  }
  if (process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") {
    return { kind: "ci" };
  }
  // Coarse agent-host markers only (no PII).
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE) {
    return { kind: "agent", agentName: process.env.UPLOADS_CLIENT_AGENT ?? "claude" };
  }
  if (process.env.CURSOR_AGENT || process.env.CURSOR_TRACE_ID) {
    return { kind: "agent", agentName: process.env.UPLOADS_CLIENT_AGENT ?? "cursor" };
  }
  return { kind: "external" };
}

export function detectRuntime(): string {
  const bun = (globalThis as { Bun?: { version?: string } }).Bun;
  if (bun?.version) return `bun-${bun.version}`;
  if (typeof process !== "undefined" && process.versions?.node) {
    return `node-${process.versions.node}`;
  }
  return "unknown";
}

function endpoint(apiUrl?: string): string {
  const base = (apiUrl ?? process.env.UPLOADS_API_URL ?? DEFAULT_API_URL).replace(/\/$/, "");
  return base;
}

/**
 * Build a safe command label from argv. Only the root command (+ subcommand
 * for known nested commands). Never includes file paths or flag values.
 */
export function telemetryCommandName(argv: string[]): string {
  const positional = argv.slice(2).filter((a) => !a.startsWith("-"));
  const root = positional[0];
  if (!root) return "(root)";
  if (!NESTED_COMMANDS.has(root)) return root.slice(0, MAX_COMMAND);
  const sub = positional[1];
  if (!sub) return root.slice(0, MAX_COMMAND);
  return `${root} ${sub}`.slice(0, MAX_COMMAND);
}

/** One-time stderr notice for interactive external users. */
export function maybeShowFirstRunNotice(
  opts: {
    dataDir?: string;
    write?: (text: string) => void;
    /** When false, skip (MCP stdio, --json, non-TTY). */
    interactive?: boolean;
  } = {},
): void {
  if (!isTelemetryEnabled(opts.dataDir)) return;
  if (opts.interactive === false) return;
  if (detectClientKind().kind !== "external") return;
  // Default: only when stderr looks interactive.
  if (opts.interactive === undefined && !process.stderr.isTTY) return;

  const marker = filePath(NOTICE_FILE, opts.dataDir);
  if (existsSync(marker)) return;

  const write = opts.write ?? ((t: string) => process.stderr.write(t));
  write(
    [
      "",
      "uploads collects anonymous usage data (command name, version, OS, exit code).",
      "No arguments, paths, tokens, or file content are sent. Opt out with:",
      "  uploads telemetry disable   # or set UPLOADS_TELEMETRY_DISABLED=1",
      "",
    ].join("\n"),
  );
  safeWrite(marker, new Date().toISOString());
}

export async function recordEvent(
  input: TelemetryEventInput,
  opts: RecordEventOptions = {},
): Promise<void> {
  if (!isTelemetryEnabled(opts.dataDir)) return;
  try {
    const ctx = detectClientKind();
    const command = input.command.trim().slice(0, MAX_COMMAND);
    if (!command) return;

    const body = {
      anonId: getOrCreateAnonId(opts.dataDir),
      timestamp: opts.now ?? Date.now(),
      surface: input.surface,
      clientKind: ctx.kind,
      agentName: ctx.agentName ?? null,
      command,
      exitCode: input.exitCode ?? null,
      durationMs: input.durationMs ?? null,
      errorCode: input.errorCode ?? null,
      cliVersion: opts.version ?? packageVersion(),
      os: process.platform,
      arch: process.arch,
      runtime: detectRuntime(),
    };

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
    const fetchImpl = opts.fetchImpl ?? fetch;
    try {
      await fetchImpl(`${endpoint(opts.apiUrl)}/v1/telemetry`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": `uploads-cli/${body.cliVersion}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(t);
    }
  } catch {
    // fire-and-forget
  }
}

export function telemetryStatus(opts: { dataDir?: string; apiUrl?: string } = {}): {
  enabled: boolean;
  anonId: string;
  clientKind: TelemetryClientKind;
  agentName?: string;
  endpoint: string;
  reason?: string;
} {
  const dataDir = opts.dataDir;
  const enabled = isTelemetryEnabled(dataDir);
  let reason: string | undefined;
  if (truthyEnv("UPLOADS_TELEMETRY_DISABLED")) reason = "UPLOADS_TELEMETRY_DISABLED=1";
  else if (process.env.DO_NOT_TRACK === "1") reason = "DO_NOT_TRACK=1";
  else if (existsSync(filePath(DISABLE_FILE, dataDir))) {
    reason = `${filePath(DISABLE_FILE, dataDir)} present`;
  }
  const ctx = detectClientKind();
  return {
    enabled,
    anonId: getOrCreateAnonId(dataDir),
    clientKind: ctx.kind,
    agentName: ctx.agentName,
    endpoint: `${endpoint(opts.apiUrl)}/v1/telemetry`,
    reason,
  };
}

/** Map thrown CLI errors to a short, allowlisted code for telemetry. */
export function errorCodeFromUnknown(err: unknown): string | undefined {
  if (
    err &&
    typeof err === "object" &&
    "code" in err &&
    typeof (err as { code: unknown }).code === "string"
  ) {
    const code = (err as { code: string }).code;
    // UploadsError codes + UsageError uses name USAGE via exit path
    return code.slice(0, 64);
  }
  if (
    err &&
    typeof err === "object" &&
    "name" in err &&
    (err as { name: string }).name === "UsageError"
  ) {
    return "USAGE";
  }
  return undefined;
}
