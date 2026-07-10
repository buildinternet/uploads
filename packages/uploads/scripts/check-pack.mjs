import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const packageRoot = new URL("..", import.meta.url);
const outputDirectory = mkdtempSync(join(tmpdir(), "uploads-pack-"));
const packArguments = ["pack", "--json", "--pack-destination", outputDirectory];
const packageManager = process.env.npm_execpath
  ? { command: process.execPath, arguments: [process.env.npm_execpath, ...packArguments] }
  : { command: "pnpm", arguments: packArguments };
try {
  const result = JSON.parse(
    execFileSync(packageManager.command, packageManager.arguments, {
      cwd: packageRoot,
      encoding: "utf8",
    }),
  );
  const packed = Array.isArray(result) ? result[0] : result;
  const files = new Set(packed.files.map(({ path }) => path));
  for (const required of [
    "README.md",
    "bin/uploads.js",
    "dist/index.js",
    "dist/index.d.ts",
    "dist/agent.js",
    "dist/agent.d.ts",
    "dist/mcp/server.js",
    "dist/mcp/server.d.ts",
    "dist/cli.js",
  ]) {
    assert(files.has(required), `packed artifact is missing ${required}`);
  }
  assert(
    [...files].every((path) => !path.startsWith("src/")),
    "packed artifact must not contain TypeScript source files",
  );
  const tarballPath = join(outputDirectory, basename(packed.filename));
  const manifest = JSON.parse(
    execFileSync("tar", ["-xOf", tarballPath, "package/package.json"], {
      encoding: "utf8",
    }),
  );
  assert.equal(manifest.private, undefined, "package must not be marked private");
  assert.equal(manifest.publishConfig?.access, "public");
  assert.equal(
    manifest.bin?.uploads?.replace(/^\.\//, ""),
    "bin/uploads.js",
    "packed manifest must retain the uploads executable",
  );
  console.log(`Verified ${packed.filename} (${packed.files.length} files)`);
} finally {
  rmSync(outputDirectory, { recursive: true, force: true });
}
