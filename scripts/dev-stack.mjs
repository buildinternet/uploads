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
  isLocalDemoWebOrigin,
  PORTLESS_BASE,
  PREVIEW_URL,
  USE_PORTLESS,
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

  // Only WEB gets a portless-named origin (`portless run` assigns a free port
  // via $PORT, registers the named HTTPS route, and prefixes worktree branch
  // names). Auth and api are internal upstreams web proxies to, so they run as
  // plain loopback wrangler processes on the ports encoded in AUTH_ORIGIN /
  // API_ORIGIN — dynamic in portless mode, the pinned 8788/8787 under
  // PORTLESS=0 (also the dev GitHub OAuth callback path).
  const portlessWrap = (name, script) =>
    USE_PORTLESS ? ["exec", "portless", "run", "--name", name, "sh", "-c", script] : null;
  const authPort = new URL(AUTH_ORIGIN).port;
  const apiPort = new URL(API_ORIGIN).port;

  // #731 phase C: BETTER_AUTH_URL is the WEB origin, not this worker's own
  // AUTH_ORIGIN — the auth worker still binds/listens on AUTH_ORIGIN (see
  // waitFor below and UPLOADS_AUTH_ORIGIN passed to web further down), but
  // Better Auth is configured as if it's served through web's same-origin
  // proxy, so deriveCookieDomain (auth.ts) emits a host-only cookie locally
  // the same way it will in production.
  //
  // --persist-to points auth's local D1 simulation at apps/api's own
  // .wrangler/state directory (issue #754 item 1 cutover): both workers now
  // bind the same database_id, and wrangler's local D1 state is otherwise
  // keyed by cwd, so without this each worker would get its own empty local
  // copy instead of sharing the one apps/api's migrate:d1:local populates.
  start("auth", [
    "--filter",
    "@uploads/auth",
    "exec",
    "wrangler",
    "dev",
    "--local",
    "--persist-to",
    "../api/.wrangler/state",
    "--ip",
    "127.0.0.1",
    "--port",
    authPort,
    "--var",
    "LOCAL_STACK:true",
    "--var",
    "ENVIRONMENT:development",
    "--var",
    `BETTER_AUTH_URL:${WEB_ORIGIN}`,
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
    apiPort,
    "--var",
    `WEB_ORIGIN:${WEB_ORIGIN}`,
  ]);
  await waitFor(`${API_ORIGIN}/health`, "api");
  if (stopping) return;

  // Web starts via `exec astro dev` (below) instead of `pnpm run dev`, so the
  // `predev` hook that builds @uploads/ui never fires. Build it explicitly:
  // a fresh checkout has no packages/ui/dist, and the account shell imports
  // `@uploads/ui/styles.css`, so without this web 500s on a missing module.
  // Idempotent and quick when already built.
  await run("pnpm", ["--filter", "@uploads/ui", "build"]);
  if (stopping) return;

  start(
    "web",
    portlessWrap(
      PORTLESS_BASE,
      `pnpm --filter @uploads/web exec astro dev --host 127.0.0.1 --port "$PORT"`,
    ) ?? [
      "--filter",
      "@uploads/web",
      "exec",
      "astro",
      "dev",
      "--host",
      "127.0.0.1",
      "--port",
      "4321",
    ],
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
      // like auth/api. 7.0.6 only checks the var's presence, but "0" is
      // Astro's documented opt-out and the intent-correct value (background
      // off) — future-proof if a later version parses the value.
      ASTRO_DEV_BACKGROUND: "0",
    },
  );
  await waitFor(PREVIEW_URL, "web");
  if (stopping) return;

  await seedFixtures(token);
  if (stopping) return;
  // The bypass is gated on WEB_ORIGIN's shape (auth's localDemoEnabled).
  // AUTH_ORIGIN is always a bare loopback port and no longer signals the mode.
  // The owned `uploads.local.buildinternet.dev` zone is local (DNS → 127.0.0.1)
  // and is the default portless origin, so smoke runs there too.
  const smoke = isLocalDemoWebOrigin(WEB_ORIGIN)
    ? await runSmoke()
    : "skipped (WEB_ORIGIN is not a recognized local-stack origin)";
  if (stopping) return;
  console.log(JSON.stringify({ ready: true, previewUrl: PREVIEW_URL, smoke }));

  await shutdown;
}

main().catch(async (err) => {
  if (stopping) return;
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  await stop(1);
});
