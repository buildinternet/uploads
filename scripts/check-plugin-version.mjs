/**
 * Lockstep plugin version: packages/plugin (changeset-owned) vs the four
 * manifests Claude and Codex actually read. Claude caches installs at
 * ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/, so a stale
 * number in one file leaves users on a previous cache tree.
 *
 * Independent of @buildinternet/uploads. MCP Registry versioning stays on
 * server.json.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(rel) {
  return JSON.parse(readFileSync(join(root, rel), "utf8"));
}

const pkg = readJson("packages/plugin/package.json");
const version = pkg.version;
assert.equal(pkg.name, "@uploads/plugin");
assert.equal(typeof version, "string");
assert.match(version, /^\d+\.\d+\.\d+$/, "@uploads/plugin version must be semver");

for (const rel of [
  "plugin.json",
  "plugins/claude/uploads/.claude-plugin/plugin.json",
  "plugins/claude/uploads-mod/.claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
]) {
  assert.equal(readJson(rel).version, version, `${rel} version`);
}

const marketplace = readJson(".claude-plugin/marketplace.json");
const names = (marketplace.plugins ?? []).map((p) => p.name);
assert.deepEqual(names, ["uploads", "uploads-mod"], ".claude-plugin/marketplace.json plugins");
for (const listed of marketplace.plugins) {
  assert.equal(listed.version, version, `marketplace.json ${listed.name} version`);
}

console.log(`plugin manifests ok (${version})`);
