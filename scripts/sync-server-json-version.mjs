/**
 * Copy packages/uploads/package.json version into server.json. Called from
 * `changeset:version` so the version PR includes the registry bump, and from
 * the Release publish job as a safety net before `mcp-publisher publish`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = join(root, "packages/uploads/package.json");
const serverPath = join(root, "server.json");

const version = JSON.parse(readFileSync(pkgPath, "utf8")).version;
if (typeof version !== "string" || version.length === 0) {
  throw new Error("packages/uploads/package.json is missing version");
}

const server = JSON.parse(readFileSync(serverPath, "utf8"));
const npm = server.packages?.[0];
if (!npm) {
  throw new Error("server.json is missing packages[0]");
}

if (server.version === version && npm.version === version) {
  console.log(`server.json already at ${version}`);
  process.exit(0);
}

server.version = version;
npm.version = version;
writeFileSync(serverPath, `${JSON.stringify(server, null, 2)}\n`);
console.log(`server.json version → ${version}`);
