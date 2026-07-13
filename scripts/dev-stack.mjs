#!/usr/bin/env node
/**
 * Lifecycle-only supervisor for the real local auth + API + web stack. Every
 * Worker runs in its own process group so SIGINT, startup errors, and crashes
 * reap Wrangler/miniflare descendants instead of leaking local state processes.
 */
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  API_ORIGIN,
  AUTH_ORIGIN,
  PREVIEW_URL,
  WEB_ORIGIN,
  runSmoke,
  seedFixtures,
  waitFor,
} from "./dev-stack-common.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const children = [];
let stopping = false;
let resolveShutdown;

function requestStop(exitCode) {
  void stop(exitCode).then(() => resolveShutdown?.());
}

function run(command, args, { capture = false } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: root, stdio: capture ? "pipe" : "inherit" });
    let output = "";
    if (capture) {
      child.stdout.on("data", (chunk) => {
        output += chunk;
        process.stdout.write(chunk);
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
        process.stderr.write(chunk);
      });
    }
    child.on("error", rejectRun);
    child.on("exit", (code, signal) => {
      if (code === 0) resolveRun(output);
      else
        rejectRun(new Error(`${command} ${args.join(" ")} exited ${code ?? signal ?? "unknown"}`));
    });
  });
}

function start(name, args, env = process.env) {
  if (stopping) throw new Error("dev stack stopped before all services started");
  const child = spawn("pnpm", args, {
    cwd: root,
    env,
    detached: process.platform !== "win32",
    stdio: "inherit",
  });
  children.push(child);
  child.once("error", (err) => {
    if (!stopping) {
      console.error(`${name} could not start: ${err.message}`);
      requestStop(1);
    }
  });
  child.once("exit", (code, signal) => {
    if (!stopping) {
      console.error(`${name} stopped unexpectedly (${code ?? signal ?? "unknown"})`);
      requestStop(1);
    }
  });
  return child;
}

function killGroup(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    // The process group already exited.
  }
}

async function stop(exitCode) {
  if (stopping) return;
  stopping = true;
  for (const child of children) killGroup(child, "SIGTERM");
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
  for (const child of children) killGroup(child, "SIGKILL");
  process.exitCode = exitCode;
}

function workspaceToken(output) {
  const token = output.match(/^token\s+: (up_dev-demo_[\w-]+)$/m)?.[1];
  if (!token) throw new Error("dev-demo workspace registration did not print a bearer token");
  return token;
}

async function main() {
  const shutdown = new Promise((finish) => {
    resolveShutdown = finish;
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => requestStop(0));
  }

  // Bootstrap is idempotent and supplies auth/API migrations and local secrets
  // before we run any Worker process. It never overwrites existing env files.
  await run("pnpm", ["bootstrap"]);
  if (stopping) return;
  const token = workspaceToken(
    await run("pnpm", ["workspace:add", "dev-demo", "--local"], { capture: true }),
  );
  if (stopping) return;

  start("auth", [
    "--filter",
    "@uploads/auth",
    "exec",
    "wrangler",
    "dev",
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    "8788",
    "--var",
    "LOCAL_STACK:true",
    "--var",
    "ENVIRONMENT:development",
    "--var",
    `BETTER_AUTH_URL:${AUTH_ORIGIN}`,
    "--var",
    `WEB_ORIGIN:${WEB_ORIGIN}`,
  ]);
  await waitFor(`${AUTH_ORIGIN}/health`, "auth");
  if (stopping) return;

  start("api", [
    "--filter",
    "@uploads/api",
    "exec",
    "wrangler",
    "dev",
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    "8787",
    "--var",
    `WEB_ORIGIN:${WEB_ORIGIN}`,
  ]);
  await waitFor(`${API_ORIGIN}/health`, "api");
  if (stopping) return;

  start(
    "web",
    ["--filter", "@uploads/web", "exec", "astro", "dev", "--host", "127.0.0.1", "--port", "4321"],
    {
      ...process.env,
      UPLOADS_AUTH_ORIGIN: AUTH_ORIGIN,
      UPLOADS_API_ORIGIN: API_ORIGIN,
      // Astro exposes PUBLIC_* values to the inline browser clients used by
      // /login, /device, and invitations as well as to the SSR account shell.
      PUBLIC_UPLOADS_AUTH_ORIGIN: AUTH_ORIGIN,
      PUBLIC_UPLOADS_API_ORIGIN: API_ORIGIN,
      // Astro 7's CLI auto-detects "agentic" shells (via am-i-vibing) and
      // silently forks `astro dev` into a detached background daemon,
      // exiting the foreground process with code 0. This supervisor treats
      // any exit of a started child as a crash (see start()), so an
      // unpatched astro dev tears down the whole stack the instant it
      // daemonizes, leaving the orphaned daemon running at :4321. Setting
      // ASTRO_DEV_BACKGROUND short-circuits astro's agent detection
      // (dist/cli/dev/index.js: `!process.env.ASTRO_DEV_BACKGROUND &&
      // isRunByAgent()`) so it stays in the foreground and is supervised
      // like auth/api.
      ASTRO_DEV_BACKGROUND: "1",
    },
  );
  await waitFor(PREVIEW_URL, "web");
  if (stopping) return;

  await seedFixtures(token);
  if (stopping) return;
  const smoke = await runSmoke();
  if (stopping) return;
  console.log(JSON.stringify({ ready: true, previewUrl: PREVIEW_URL, smoke }));

  await shutdown;
}

main().catch(async (err) => {
  if (stopping) return;
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  await stop(1);
});
