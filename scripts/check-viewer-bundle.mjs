/** Build the actual independent Worker and reject heavy runtime dependencies. */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createRequire } from "node:module";

const api = fileURLToPath(new URL("../apps/api/", import.meta.url));
const requireApi = createRequire(join(api, "package.json"));
const { unstable_readConfig: readConfig } = requireApi("wrangler");
for (const isPreview of [false, true]) {
  const source = readConfig(
    { config: join(api, "wrangler.jsonc") },
    { isPreview, hideWarnings: true },
  );
  const viewer = readConfig(
    { config: join(api, "wrangler.viewer.jsonc") },
    { isPreview, hideWarnings: true },
  );
  for (const [group, field, excluded] of [
    ["r2_buckets", "bucket_name", ["UPLOADS_HELD"]],
    ["kv_namespaces", "id", []],
    ["d1_databases", "database_id", []],
  ]) {
    for (const binding of source[group]) {
      if (excluded.includes(binding.binding)) continue;
      const counterpart = viewer[group].find((item) => item.binding === binding.binding);
      if (!counterpart || counterpart[field] !== binding[field]) {
        throw new Error(
          `Viewer ${isPreview ? "preview" : "production"} binding drift: ${binding.binding}`,
        );
      }
    }
  }
}

const output = join(api, ".wrangler/viewer-bundle-check");
const result = spawnSync(
  "pnpm",
  [
    "exec",
    "wrangler",
    "deploy",
    "--config",
    "wrangler.viewer.jsonc",
    "--dry-run",
    "--outdir",
    output,
    "--metafile",
    join(output, "meta.json"),
  ],
  { cwd: api, stdio: "inherit", timeout: 120_000 },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const meta = JSON.parse(readFileSync(join(output, "meta.json"), "utf8"));
const linked = new Set();
let bytes = 0;
for (const [path, artifact] of Object.entries(meta.outputs)) {
  if (!/\.[cm]?js$/.test(path)) continue;
  bytes += artifact.bytes;
  for (const [input, contribution] of Object.entries(artifact.inputs)) {
    if (contribution.bytesInOutput > 0) linked.add(input.replaceAll("\\", "/"));
  }
}
// Check emitted contributions, not esbuild's parsed inputs: a shared module
// may contain owner functionality that tree shaking correctly removes.
const forbidden =
  /(?:^(?:.*apps\/api\/)?src\/index\.ts$|(?:^|\/)src\/(?:pdf-preview|poster-overlay|classifier)\.ts$|\/routes\/(?:files|admin|render|github-webhook)\.ts$|\/(?:clawpdf|mediabunny|jpeg-js|pngjs)(?:\/|@)|\.wasm$)/;
const violations = [...linked].filter((path) => forbidden.test(path));
function wasmFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? wasmFiles(path) : name.endsWith(".wasm") ? [path] : [];
  });
}
violations.push(...wasmFiles(output));
// A code-size regression ceiling, not a claim about platform startup latency.
const maxBytes = 1_600_000;
console.log(
  JSON.stringify({ viewerJavaScriptBytes: bytes, maxBytes, linkedModules: linked.size }, null, 2),
);
if (bytes === 0 || bytes > maxBytes || violations.length) {
  console.error("Viewer bundle budget failed", { bytes, maxBytes, forbidden: violations });
  process.exit(1);
}

// The public URL dispatcher must remain independent of both application bundles.
const edgeConfig = readConfig(
  { config: join(api, "wrangler.public-edge.jsonc") },
  { hideWarnings: true },
);
if (
  edgeConfig.routes.length ||
  edgeConfig.vars.PUBLIC_VIEWER_ROLLOUT !== "off" ||
  edgeConfig.services.some((binding) => binding.binding === "PUBLIC_VIEWER")
) {
  throw new Error("Public edge must remain unbound and off until rollout review");
}
const edgeOutput = join(api, ".wrangler/public-edge-bundle-check");
const edgeBuild = spawnSync(
  "pnpm",
  [
    "exec",
    "wrangler",
    "deploy",
    "--config",
    "wrangler.public-edge.jsonc",
    "--dry-run",
    "--outdir",
    edgeOutput,
    "--metafile",
    join(edgeOutput, "meta.json"),
  ],
  { cwd: api, stdio: "inherit", timeout: 120_000 },
);
if (edgeBuild.error) throw edgeBuild.error;
if (edgeBuild.status !== 0) process.exit(edgeBuild.status ?? 1);
const edgeMeta = JSON.parse(readFileSync(join(edgeOutput, "meta.json"), "utf8"));
const edgeBytes = Object.entries(edgeMeta.outputs)
  .filter(([path]) => /\.[cm]?js$/.test(path))
  .reduce((sum, [, artifact]) => sum + artifact.bytes, 0);
if (edgeBytes === 0 || edgeBytes > 8192)
  throw new Error(`Public edge exceeds 8 KiB budget: ${edgeBytes}`);
console.log(JSON.stringify({ publicEdgeJavaScriptBytes: edgeBytes, maxBytes: 8192 }));
