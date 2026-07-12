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
 * Prefers GNU/BSD `timeout` / `gtimeout` (kills the process group). Falls back
 * to a detached spawn where the child leads its own process group and the whole
 * group gets SIGTERM, then SIGKILL after 5s — a plain child-only SIGKILL would
 * orphan wrangler/miniflare grandchildren, the exact failure this guards against.
 *
 * Exit codes (CLI): command's status, or 124 on timeout (GNU timeout convention).
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SELF_PATH = fileURLToPath(import.meta.url);

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
      maxBuffer: 20 * 1024 * 1024,
    });
    // GNU timeout exits 124 on deadline, 137 (128+9) when --kill-after escalates to SIGKILL.
    const timedOut = r.status === 124 || r.status === 137;
    return {
      status: r.status,
      signal: r.signal,
      stdout: r.stdout,
      stderr: r.stderr,
      error: r.error,
      timedOut,
    };
  }

  // No timeout binary: re-invoke this script's CLI, which does a detached
  // process-group spawn + kill(-pgid). spawnSync's own `timeout` option only
  // SIGKILLs the direct child, orphaning wrangler/miniflare grandchildren.
  const r = spawnSync(process.execPath, [SELF_PATH, String(timeoutSec), "--", cmd, ...args], {
    stdio,
    encoding: stdio === "inherit" ? undefined : encoding,
    env: env ?? process.env,
    cwd,
    maxBuffer: 20 * 1024 * 1024,
  });
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

/**
 * Async fallback used by the CLI when no `timeout` binary exists. The child is
 * detached so it leads its own process group; on deadline the whole group gets
 * SIGTERM, then SIGKILL after a 5s grace, so grandchildren die too. Parent
 * SIGINT/SIGTERM are forwarded to the group (detached children don't share the
 * terminal's foreground group, so Ctrl-C wouldn't reach them otherwise).
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ timeoutSec: number }} opts
 */
async function runDetachedGroup(cmd, args, { timeoutSec }) {
  const child = spawn(cmd, args, {
    stdio: "inherit",
    detached: true,
    env: process.env,
  });

  const killGroup = (signal) => {
    try {
      if (process.platform === "win32") {
        // No Unix process groups on Windows; taskkill /T kills the whole tree.
        spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        process.kill(-child.pid, signal);
      }
    } catch {
      // group already gone
    }
  };

  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), 5000).unref();
    },
    Math.round(timeoutSec * 1000),
  );
  timer.unref();

  const forward = (signal) => () => killGroup(signal);
  const onInt = forward("SIGINT");
  const onTerm = forward("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);

  const [status, signal] = await new Promise((res) => {
    child.on("error", () => res([1, null]));
    child.on("exit", (code, sig) => {
      // On the timeout path the child may die from SIGTERM while grandchildren
      // linger, and the unref'd SIGKILL timer would die with this process —
      // force-kill any group stragglers before resolving.
      if (timedOut) killGroup("SIGKILL");
      res([code, sig]);
    });
  });

  clearTimeout(timer);
  process.off("SIGINT", onInt);
  process.off("SIGTERM", onTerm);
  return { status, signal, timedOut };
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
    /** @type {Error & { timedOut?: boolean }} */
    const err = new Error(
      `wrangler kv key ${op} timed out after ${timeoutSec}s (${local ? "local" : "remote"})`,
    );
    err.timedOut = true;
    throw err;
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
  // Windows' System32\timeout.exe is a wait command, not a killer; and the
  // escape hatch lets tests exercise the detached-group fallback.
  if (process.platform === "win32" || process.env.RUN_TIMED_FORCE_FALLBACK) {
    return null;
  }
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

async function main() {
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

  const result = findTimeoutBin()
    ? runTimed(cmd, args, { timeoutSec: seconds, stdio: "inherit" })
    : await runDetachedGroup(cmd, args, { timeoutSec: seconds });
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

const isCli = Boolean(process.argv[1]) && resolve(process.argv[1]) === SELF_PATH;
if (isCli) {
  await main();
}
