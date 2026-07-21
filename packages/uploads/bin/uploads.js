#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { warnIfDistStale } from "./dist-staleness.mjs";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
warnIfDistStale(packageRoot);

const { runCli } = await import("../dist/cli.js");

runCli(process.argv)
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
