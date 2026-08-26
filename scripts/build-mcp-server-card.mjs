/**
 * Write apps/web/public/.well-known/mcp/server-card.json from server.json.
 * Version, homepage, icons, and the streamable-http endpoint come from the
 * registry manifest so the card cannot drift. Card-only fields (protocol
 * versions, capabilities, auth copy) live here.
 *
 *   node scripts/build-mcp-server-card.mjs         # write
 *   node scripts/build-mcp-server-card.mjs --check # fail if stale
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cardPath = join(root, "apps/web/public/.well-known/mcp/server-card.json");

function buildCard(server) {
  const endpoint = server.remotes?.[0]?.url;
  if (typeof endpoint !== "string" || endpoint.length === 0) {
    throw new Error("server.json is missing remotes[0].url");
  }
  return {
    $schema: "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
    supportedVersions: ["2026-07-28", "2025-06-18"],
    serverInfo: {
      name: "uploads-mcp",
      version: server.version,
      description:
        "Host files on uploads.sh from an agent — put (including branch staging and PR attach), promote, list, delete, usage, galleries, and GitHub attachment comments.",
      homepage: `${String(server.websiteUrl).replace(/\/+$/, "")}/`,
      icons: server.icons ?? [],
    },
    transport: {
      type: "streamable-http",
      endpoint,
    },
    capabilities: {
      tools: true,
      resources: false,
      prompts: false,
    },
    authentication: {
      required: true,
      schemes: ["bearer", "oauth2"],
      description:
        "Bearer token — either a per-workspace token (Authorization: Bearer up_<workspace>_…, via invitation + `uploads login`) or an OAuth 2.1 access token from the uploads-auth authorization server (browser consent flow; see /.well-known/oauth-protected-resource). See https://uploads.sh/auth.md",
    },
  };
}

const server = JSON.parse(readFileSync(join(root, "server.json"), "utf8"));
const next = `${JSON.stringify(buildCard(server), null, 2)}\n`;

if (process.argv.includes("--check")) {
  const prev = readFileSync(cardPath, "utf8");
  if (JSON.stringify(JSON.parse(prev)) !== JSON.stringify(JSON.parse(next))) {
    console.error(
      "apps/web/public/.well-known/mcp/server-card.json is stale. Run:\n" +
        "  node scripts/build-mcp-server-card.mjs",
    );
    process.exit(1);
  }
  console.log(`server-card.json ok (${server.name} ${server.version})`);
} else {
  writeFileSync(cardPath, next);
  try {
    execFileSync("pnpm", ["exec", "oxfmt", cardPath], { cwd: root, stdio: "inherit" });
  } catch {
    // oxfmt is optional; CI's format:check still gates the committed file.
  }
  console.log(`server-card.json → ${server.version}`);
}
