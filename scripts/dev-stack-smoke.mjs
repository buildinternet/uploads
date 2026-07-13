#!/usr/bin/env node
import { runSmoke } from "./dev-stack-common.mjs";

async function main() {
  const result = await runSmoke();
  console.log(JSON.stringify({ ok: true, smoke: result }));
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
