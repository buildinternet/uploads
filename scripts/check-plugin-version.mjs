/**
 * Lockstep plugin version across the Agent Plugins root manifest and the
 * Claude / Codex adapters. Claude caches installs at
 * ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/, so a stale
 * number in one file leaves users on a previous cache tree.
 *
 * Independent of @buildinternet/uploads: a plugin-only cache bust must not
 * force an npm publish. MCP Registry versioning stays on server.json.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(rel) {
  return JSON.parse(readFileSync(join(root, rel), "utf8"));
}

const rootPlugin = readJson("plugin.json");
const version = rootPlugin.version;
assert.equal(typeof version, "string");
assert.match(version, /^\d+\.\d+\.\d+$/, "plugin.json version must be semver");

const claude = readJson(".claude-plugin/plugin.json");
assert.equal(claude.version, version, ".claude-plugin/plugin.json version");

const marketplace = readJson(".claude-plugin/marketplace.json");
const listed = marketplace.plugins?.[0];
assert.ok(listed, ".claude-plugin/marketplace.json must list a plugin");
assert.equal(listed.name, "uploads");
assert.equal(listed.version, version, "marketplace.json plugins[0].version");

const codex = readJson(".codex-plugin/plugin.json");
assert.equal(codex.version, version, ".codex-plugin/plugin.json version");

console.log(`plugin manifests ok (${version})`);
