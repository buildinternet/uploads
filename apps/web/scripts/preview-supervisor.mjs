#!/usr/bin/env node
/**
 * Supervise `astro preview` so it stays healthy.
 *
 * The Cloudflare vite plugin proxies preview requests into a workerd child via
 * miniflare. That bridge can die after long uptime (every request then 500s
 * with `TypeError: fetch failed … at _Miniflare.dispatchFetch` until restart;
 * closest upstream ticket: cloudflare/workers-sdk#7376 — no released fix as of
 * miniflare 4.20260708.1 / wrangler 4.110.0). This wrapper health-checks the
 * server and restarts it when the bridge breaks, instead of leaving a dead
 * preview behind.
 *
 * Usage: node scripts/preview-supervisor.mjs [astro preview args…]
 *
 * The child leads its own process group so a restart also reaps the workerd
 * grandchild (same rationale as apps/api/scripts/run-timed.mjs).
 */
import { spawn } from "node:child_process";

const CHECK_INTERVAL_MS = 20_000;
const CHECK_TIMEOUT_MS = 10_000;
const FAILURES_BEFORE_RESTART = 2;
const RESTART_DELAY_MS = 1_000;

let child;
let previewUrl;
let shuttingDown = false;

function log(msg) {
  console.error(`[preview-supervisor] ${msg}`);
}

function killGroup(proc, signal) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  try {
    process.kill(-proc.pid, signal);
  } catch {
    try {
      proc.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

function start() {
  previewUrl = undefined;
  child = spawn("pnpm", ["exec", "astro", "preview", ...process.argv.slice(2)], {
    detached: true,
    stdio: ["ignore", "pipe", "inherit"],
  });
  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    if (!previewUrl) {
      const m = String(chunk).match(/https?:\/\/localhost:\d+\//);
      if (m) {
        previewUrl = m[0];
        log(`health-checking ${previewUrl} every ${CHECK_INTERVAL_MS / 1000}s`);
      }
    }
  });
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    log(
      `astro preview exited (code=${code} signal=${signal}); restarting in ${RESTART_DELAY_MS}ms`,
    );
    setTimeout(start, RESTART_DELAY_MS);
  });
}

async function healthy() {
  if (!previewUrl) return true; // still booting; exit handler covers boot failures
  try {
    const res = await fetch(previewUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    // Only 5xx counts as unhealthy — the dead workerd bridge turns every
    // request into a 500, whereas 2xx–4xx means the server is serving.
    return res.status < 500;
  } catch {
    return false;
  }
}

let consecutiveFailures = 0;
setInterval(async () => {
  if (shuttingDown) return;
  if (await healthy()) {
    consecutiveFailures = 0;
    return;
  }
  consecutiveFailures += 1;
  log(`health check failed (${consecutiveFailures}/${FAILURES_BEFORE_RESTART})`);
  if (consecutiveFailures < FAILURES_BEFORE_RESTART) return;
  consecutiveFailures = 0;
  log("restarting astro preview (miniflare→workerd bridge looks dead)");
  const proc = child; // capture: `child` is reassigned once the restart happens
  killGroup(proc, "SIGTERM");
  setTimeout(() => killGroup(proc, "SIGKILL"), 5_000).unref();
  // child's exit handler schedules the restart
}, CHECK_INTERVAL_MS).unref();

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    shuttingDown = true;
    killGroup(child, "SIGTERM");
    setTimeout(() => {
      killGroup(child, "SIGKILL");
      process.exit(0);
    }, 5_000).unref();
    child?.on("exit", () => process.exit(0));
  });
}

start();
// Keep the event loop alive even while the child is restarting.
setInterval(() => {}, 60_000);
