#!/usr/bin/env node
/**
 * Run a command with a wall-clock bound so hung wrangler/miniflare children
 * cannot orphan and balloon RAM after an agent/shell dies.
 *
 * Usage:
 *   node scripts/run-timed.mjs <seconds> -- <cmd> [args…]
 *
 * Library:
 *   import { runTimed, wranglerKvKey } from "./run-timed.mjs";
 *
 * Prefers GNU `timeout` / `gtimeout` (kills the process group). Falls back to
 * Node's spawnSync timeout + SIGKILL.
 *
 * Exit codes (CLI): command's status, or 124 on timeout (GNU timeout convention).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{
 *   timeoutSec: number;
 *   stdio?: "inherit" | "pipe";
 *   encoding?: BufferEncoding;
 *   env?: NodeJS.ProcessEnv;
 *   cwd?: string;
 * }} opts
 */
export function runTimed(cmd, args, opts) {
  const { timeoutSec, stdio = "pipe", encoding = "utf8", env, cwd } = opts;
  const timeoutBin = findTimeoutBin();

  if (timeoutBin) {
    const r = spawnSync(timeoutBin, ["--kill-after=5s", `${timeoutSec}s`, cmd, ...args], {
      stdio,
      encoding: stdio === "inherit" ? undefined : encoding,
      env: env ?? process.env,
      cwd,
    });
    // GNU timeout exits 124 when the deadline fires.
    const timedOut = r.status === 124;
    return {
      status: r.status,
      signal: r.signal,
      stdout: r.stdout,
      stderr: r.stderr,
      error: r.error,
      timedOut,
    };
  }

  const r = spawnSync(cmd, args, {
    stdio,
    encoding: stdio === "inherit" ? undefined : encoding,
    env: env ?? process.env,
    cwd,
    timeout: Math.round(timeoutSec * 1000),
    killSignal: "SIGKILL",
    maxBuffer: 20 * 1024 * 1024,
  });
  const timedOut = r.error?.code === "ETIMEDOUT";
  return {
    status: timedOut ? 124 : r.status,
    signal: r.signal,
    stdout: r.stdout,
    stderr: r.stderr,
    error: timedOut ? null : r.error,
    timedOut,
  };
}

/**
 * Bound wrangler REGISTRY KV get/put. Local miniflare boots get short caps;
 * remote keeps a longer ceiling so slow network does not false-timeout.
 *
 * @param {{
 *   op: "get" | "put";
 *   key: string;
 *   value?: string;
 *   local: boolean;
 *   binding?: string;
 *   timeoutSec?: number;
 *   stdio?: "inherit" | "pipe";
 * }} opts
 */
export function wranglerKvKey(opts) {
  const { op, key, value, local, binding = "REGISTRY", stdio = "pipe" } = opts;
  const timeoutSec = opts.timeoutSec ?? (local ? (op === "get" ? 30 : 60) : 120);

  const args = ["exec", "wrangler", "kv", "key", op, key];
  if (op === "put") {
    if (value === undefined) throw new Error("wranglerKvKey put requires value");
    args.push(value);
  }
  args.push("--binding", binding, local ? "--local" : "--remote");

  const result = runTimed("pnpm", args, {
    timeoutSec,
    stdio,
    encoding: "utf8",
  });

  if (result.timedOut) {
    throw new Error(
      `wrangler kv key ${op} timed out after ${timeoutSec}s (${local ? "local" : "remote"})`,
    );
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = result.stderr != null ? String(result.stderr).trim() : "";
    const err = new Error(
      `wrangler kv key ${op} exited ${result.status}${detail ? `: ${detail}` : ""}`,
    );
    /** @type {Error & { status?: number | null; stdout?: string; stderr?: string }} */
    const e = err;
    e.status = result.status;
    e.stdout = result.stdout != null ? String(result.stdout) : "";
    e.stderr = result.stderr != null ? String(result.stderr) : "";
    throw e;
  }

  return result.stdout != null ? String(result.stdout) : "";
}

function findTimeoutBin() {
  const names = ["timeout", "gtimeout"];
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  for (const candidate of [
    "/opt/homebrew/bin/timeout",
    "/opt/homebrew/bin/gtimeout",
    "/usr/local/bin/timeout",
    "/usr/local/bin/gtimeout",
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function main() {
  const argv = process.argv.slice(2);
  const sep = argv.indexOf("--");
  if (sep < 1 || sep === argv.length - 1) {
    console.error("usage: node scripts/run-timed.mjs <seconds> -- <cmd> [args…]");
    process.exit(2);
  }

  const seconds = Number(argv[0]);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    console.error(`invalid timeout seconds: ${argv[0]}`);
    process.exit(2);
  }

  const cmd = argv[sep + 1];
  const args = argv.slice(sep + 2);

  const result = runTimed(cmd, args, { timeoutSec: seconds, stdio: "inherit" });
  if (result.timedOut) {
    console.error(`[run-timed] killed after ${seconds}s: ${cmd} ${args.join(" ")}`.trim());
    process.exit(124);
  }
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  process.exit(result.status === null ? 1 : result.status);
}

const isCli =
  Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  main();
}
