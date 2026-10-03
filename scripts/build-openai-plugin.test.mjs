import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { stageOpenAIPlugin } from "./build-openai-plugin.mjs";

const repository = join(dirname(fileURLToPath(import.meta.url)), "..");

function fixture(t) {
  const temporary = mkdtempSync(join(tmpdir(), "uploads-plugin-test-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const source = join(temporary, "source");
  for (const path of [
    "plugin.json",
    ".codex-plugin/plugin.json",
    ".mcp.json",
    "packages/plugin/package.json",
    "plugins/codex/review-cases.json",
    "assets/logo.png",
    "skills",
  ]) {
    mkdirSync(dirname(join(source, path)), { recursive: true });
    cpSync(join(repository, path), join(source, path), { recursive: true });
  }
  return { source, destination: join(temporary, "package") };
}

await test("directory package excludes local hooks, credentials, and repository contents", (t) => {
  const { source, destination } = fixture(t);
  writeFileSync(join(source, ".env"), "TOKEN=do-not-package");
  mkdirSync(join(source, "hooks"));
  writeFileSync(join(source, "hooks/hooks.json"), "{}");
  const manifest = stageOpenAIPlugin(source, destination);
  assert.deepEqual(readdirSync(destination).sort(), [
    "assets",
    "mcp.json",
    "plugin.json",
    "skills",
  ]);
  assert.equal(manifest.extensions["com.openai"].hooks, undefined);
  assert.equal(manifest.extensions["com.openai"].review, undefined);
  assert.deepEqual(JSON.parse(readFileSync(join(destination, "mcp.json"), "utf8")).mcpServers, {
    uploads: { type: "streamable-http", url: "https://agents.uploads.sh/mcp" },
  });
});

await test("skill symlinks cannot pull private files into the ZIP", (t) => {
  const { source, destination } = fixture(t);
  writeFileSync(join(source, ".env"), "TOKEN=do-not-package");
  symlinkSync(join(source, ".env"), join(source, "skills/uploads-cli/private.txt"));
  assert.throws(() => stageOpenAIPlugin(source, destination), /cannot be symlinks/);
});

await test("review cases use the configured fixture and reject credential fields", (t) => {
  const { source, destination } = fixture(t);
  const config = {
    beforePngUrl: "https://example.com/before.png",
    afterPngUrl: "https://example.com/after.png",
    repo: "example/review-fixtures",
    pullRequest: 12,
    branch: "openai-review",
    demoRecordingUrl: "https://example.com/walkthrough",
  };
  const manifest = stageOpenAIPlugin(source, destination, config);
  const review = manifest.extensions["com.openai"].review;
  assert.equal(review.test_cases.positive.length, 5);
  assert.equal(review.test_cases.negative.length, 3);
  assert.deepEqual(review.test_cases.positive[2].file_attachment_urls, [
    config.beforePngUrl,
    config.afterPngUrl,
  ]);
  assert.match(review.test_cases.positive[1].prompt, /pull request 12 in example\/review-fixtures/);
  assert.doesNotMatch(JSON.stringify(review), /\{\{/);
  assert.throws(
    () =>
      stageOpenAIPlugin(source, join(dirname(destination), "invalid"), {
        ...config,
        password: "private",
      }),
    /credentials in the portal/,
  );
});

await test("package refuses MCP credentials and a stale plugin version", (t) => {
  const { source, destination } = fixture(t);
  const remote = JSON.parse(readFileSync(join(source, ".mcp.json"), "utf8"));
  remote.uploads.headers = { Authorization: "Bearer private" };
  writeFileSync(join(source, ".mcp.json"), JSON.stringify(remote));
  assert.throws(() => stageOpenAIPlugin(source, destination), /headers or credentials/);
  const manifest = JSON.parse(readFileSync(join(source, "plugin.json"), "utf8"));
  manifest.version = "0.0.0";
  writeFileSync(join(source, "plugin.json"), JSON.stringify(manifest));
  assert.throws(() => stageOpenAIPlugin(source, destination), /version must match/);
});
