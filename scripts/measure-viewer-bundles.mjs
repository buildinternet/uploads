/** Reproducible local code-size comparison; this does not measure platform startup. */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const api = fileURLToPath(new URL("../apps/api/", import.meta.url));
mkdirSync(join(api, ".wrangler"), { recursive: true });
const temporary = mkdtempSync(join(api, ".wrangler/viewer-variants-"));
const results = [];
try {
  for (const families of [["files"], ["files", "galleries"], ["files", "galleries", "feeds"]]) {
    const label = families.join("-");
    const entry = join(temporary, `${label}.ts`);
    const imports = families
      .map(
        (name) =>
          `import { public${name[0].toUpperCase()}${name.slice(1)} as ${name} } from "../../src/routes/public-${name}";`,
      )
      .join("\n");
    const routes = families.map((name) => `.route("/public/${name}", ${name})`).join("\n");
    writeFileSync(
      entry,
      `import { Hono } from "hono";
import { NotFoundError } from "@uploads/errors";
import { respondError } from "../../src/error-response";
import { requestDbSession } from "../../src/request-db-session";
${imports}
const app = new Hono().use("*", requestDbSession).get("/health", (c) => c.json({ ok: true }))
${routes}
.onError((err, c) => respondError(c, err))
.notFound((c) => respondError(c, new NotFoundError()));
export default { fetch: app.fetch.bind(app) };
`,
    );
    const output = join(api, ".wrangler/viewer-comparison", label);
    const run = spawnSync(
      "pnpm",
      [
        "exec",
        "wrangler",
        "deploy",
        entry,
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
    if (run.error) throw run.error;
    if (run.status !== 0) throw new Error(`Bundle failed: ${label}`);
    const meta = JSON.parse(readFileSync(join(output, "meta.json"), "utf8"));
    const bytes = Object.entries(meta.outputs)
      .filter(([path]) => /\.[cm]?js$/.test(path))
      .reduce((sum, [, artifact]) => sum + artifact.bytes, 0);
    results.push({ surfaces: label, javaScriptBytes: bytes });
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
console.log(JSON.stringify({ kind: "local-bundle-sizes", results }, null, 2));
