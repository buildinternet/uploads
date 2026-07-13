#!/usr/bin/env node
import {
  API_ORIGIN,
  AUTH_ORIGIN,
  PREVIEW_URL,
  WEB_ORIGIN,
  runSmoke,
  waitFor,
} from "./dev-stack-common.mjs";

async function main() {
  const json = process.argv.includes("--json");
  if (process.argv.slice(2).some((arg) => arg !== "--json")) {
    throw new Error("usage: pnpm dev:stack:check [--json]");
  }
  await Promise.all([
    waitFor(`${AUTH_ORIGIN}/health`, "auth"),
    waitFor(`${API_ORIGIN}/health`, "api"),
    waitFor(PREVIEW_URL, "web"),
  ]);
  const smoke = await runSmoke();
  const result = { ready: true, previewUrl: WEB_ORIGIN, workspaceUrl: PREVIEW_URL, smoke };
  console.log(json ? JSON.stringify(result) : `ready: ${PREVIEW_URL}`);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  if (process.argv.includes("--json"))
    console.log(JSON.stringify({ ready: false, error: message }));
  else console.error(message);
  process.exitCode = 1;
});
