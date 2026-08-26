/**
 * Lockstep: server.json vs packages/uploads. The MCP Registry verifies `mcpName`
 * on the npm tarball against `server.json` `name`; clients install from
 * `packages[0].identifier` / `version`. Drift fails publish or installs the
 * wrong binary.
 *
 * Static by design: no network, no mcp-publisher. Schema validation runs in
 * the Release workflow via `mcp-publisher validate` before publish.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(rel) {
  return JSON.parse(readFileSync(join(root, rel), "utf8"));
}

const pkg = readJson("packages/uploads/package.json");
const server = readJson("server.json");
const NAME = "sh.uploads/mcp";

assert.equal(pkg.mcpName, NAME, "packages/uploads/package.json mcpName");
assert.equal(server.name, NAME, "server.json name");
assert.equal(server.version, pkg.version, "server.json version must equal the CLI version");

assert.equal(typeof server.description, "string");
assert.ok(server.description.length >= 1, "server.json description is required");
assert.ok(
  server.description.length <= 100,
  `server.json description must be ≤100 characters (got ${server.description.length})`,
);

assert.equal(server.websiteUrl, "https://uploads.sh");
assert.equal(server.repository?.url, "https://github.com/buildinternet/uploads");
assert.equal(server.repository?.source, "github");
assert.equal(server.repository?.id, "1291468384");

const npm = server.packages?.[0];
assert.ok(npm, "server.json must declare the npm package");
assert.equal(npm.registryType, "npm");
assert.equal(npm.identifier, pkg.name);
assert.equal(npm.version, pkg.version);
assert.equal(npm.transport?.type, "stdio");
assert.deepEqual(npm.packageArguments, [{ type: "positional", value: "mcp" }]);

const remote = server.remotes?.[0];
assert.ok(remote, "server.json must declare the hosted remote");
assert.equal(remote.type, "streamable-http");
assert.equal(remote.url, "https://agents.uploads.sh/mcp");

const proof = readFileSync(
  join(root, "apps/web/public/.well-known/mcp-registry-auth"),
  "utf8",
).trim();
assert.match(
  proof,
  /^v=MCPv1; k=ed25519; p=[A-Za-z0-9+/]+=*$/,
  "uploads.sh HTTP proof at /.well-known/mcp-registry-auth",
);

console.log(`server.json ok (${server.name} ${server.version})`);
