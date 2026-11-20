/**
 * Copy packages/plugin/package.json version into the four plugin manifests.
 * Called from `changeset:version` so the version PR includes the cache-busting
 * stamp Claude and Codex actually read.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(rel) {
  return JSON.parse(readFileSync(join(root, rel), "utf8"));
}

function writeJson(rel, value) {
  writeFileSync(join(root, rel), `${JSON.stringify(value, null, 2)}\n`);
}

const version = readJson("packages/plugin/package.json").version;
if (typeof version !== "string" || version.length === 0) {
  throw new Error("packages/plugin/package.json is missing version");
}

const files = [
  "plugin.json",
  "plugins/claude/uploads/.claude-plugin/plugin.json",
  "plugins/claude/uploads-mod/.claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
];
let changed = 0;
for (const rel of files) {
  const json = readJson(rel);
  if (json.version === version) continue;
  json.version = version;
  writeJson(rel, json);
  changed += 1;
}

const marketplace = readJson(".claude-plugin/marketplace.json");
if (!marketplace.plugins?.length) {
  throw new Error(".claude-plugin/marketplace.json is missing plugins");
}
let marketplaceChanged = false;
for (const listed of marketplace.plugins) {
  if (listed.version === version) continue;
  listed.version = version;
  marketplaceChanged = true;
}
if (marketplaceChanged) {
  writeJson(".claude-plugin/marketplace.json", marketplace);
  changed += 1;
}

if (changed === 0) {
  console.log(`plugin manifests already at ${version}`);
} else {
  console.log(`plugin manifests version → ${version} (${changed} file(s))`);
}
