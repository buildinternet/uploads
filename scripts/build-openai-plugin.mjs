/** Build the public-directory ZIP without local hooks or repository files. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

function copyTree(source, destination) {
  assert.ok(!lstatSync(source).isSymbolicLink(), `Submission files cannot be symlinks: ${source}`);
  if (lstatSync(source).isDirectory()) {
    mkdirSync(destination, { recursive: true });
    for (const name of readdirSync(source).sort()) {
      if (name === ".DS_Store") continue;
      assert.ok(!name.startsWith("."), `Hidden files cannot enter the submission: ${name}`);
      copyTree(join(source, name), join(destination, name));
    }
  } else {
    assert.ok(lstatSync(source).isFile(), `Submission input must be a regular file: ${source}`);
    copyFileSync(source, destination);
  }
}

function reviewMetadata(sourceRoot, config) {
  assert.deepEqual(
    Object.keys(config).sort(),
    ["afterPngUrl", "beforePngUrl", "branch", "demoRecordingUrl", "pullRequest", "repo"].sort(),
    "Review config accepts only public fixture details; enter credentials in the portal",
  );
  assert.match(config.repo, /^[\w.-]+\/[\w.-]+$/, "repo must be owner/name");
  assert.ok(
    Number.isSafeInteger(config.pullRequest) && config.pullRequest > 0,
    "pullRequest must be a positive integer",
  );
  assert.ok(typeof config.branch === "string" && config.branch.length > 0, "branch is required");
  for (const key of ["beforePngUrl", "afterPngUrl"]) {
    const url = new URL(config[key]);
    assert.equal(url.protocol, "https:", `${key} must use HTTPS`);
    assert.ok(!url.username && !url.password, "PNG URLs cannot contain credentials");
  }
  const recording = new URL(config.demoRecordingUrl);
  assert.equal(recording.protocol, "https:", "demoRecordingUrl must use HTTPS");
  assert.ok(
    !recording.username && !recording.password,
    "Recording URLs cannot contain credentials",
  );
  const cases = readJson(join(sourceRoot, "plugins/codex/review-cases.json"));
  assert.equal(cases.positive.length, 5);
  assert.equal(cases.negative.length, 3);
  const replace = (value) => {
    if (typeof value === "string") {
      return value.replace(
        /\{\{(repo|pullRequest|branch|beforePngUrl|afterPngUrl)\}\}/g,
        (_, key) => String(config[key]),
      );
    }
    if (Array.isArray(value)) return value.map(replace);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]));
  };
  return {
    test_cases: replace(cases),
    demo_recording_url: recording.href,
    commerce: false,
    commerce_description:
      "Users connect an existing uploads.sh account. The plugin does not sell products, process payments, or initiate subscriptions.",
  };
}

export function stageOpenAIPlugin(sourceRoot, destination, reviewConfig) {
  const identity = readJson(join(sourceRoot, "plugin.json"));
  const codex = readJson(join(sourceRoot, ".codex-plugin/plugin.json"));
  const version = readJson(join(sourceRoot, "packages/plugin/package.json")).version;
  assert.equal(identity.version, version, "Portable plugin version must match @uploads/plugin");
  assert.equal(codex.version, version, "Codex plugin version must match @uploads/plugin");
  const manifest = Object.fromEntries(
    [
      "$schema",
      "name",
      "version",
      "description",
      "author",
      "homepage",
      "repository",
      "license",
      "keywords",
    ].map((key) => [key, identity[key]]),
  );
  manifest.extensions = {
    "com.openai": {
      interface: codex.interface,
      ...(reviewConfig ? { review: reviewMetadata(sourceRoot, reviewConfig) } : {}),
      publication: {
        release_notes:
          "Initial OpenAI directory package with hosted file tools and screenshot workflows.",
      },
    },
  };
  assert.equal(manifest.extensions["com.openai"].interface.logo, "./assets/logo.png");
  assert.equal(manifest.extensions["com.openai"].interface.composerIcon, "./assets/logo.png");
  assert.ok(
    !/\bhook\b/i.test(codex.interface.longDescription),
    "Directory copy cannot promise local hooks",
  );
  const remote = readJson(join(sourceRoot, ".mcp.json")).uploads;
  assert.equal(remote.type, "http");
  assert.equal(remote.url, "https://agents.uploads.sh/mcp");
  assert.deepEqual(
    Object.keys(remote).sort(),
    ["type", "url"],
    "Do not package MCP headers or credentials",
  );
  mkdirSync(destination, { recursive: true });
  writeJson(join(destination, "plugin.json"), manifest);
  writeJson(join(destination, "mcp.json"), {
    $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    mcpServers: { uploads: { type: "streamable-http", url: remote.url } },
  });
  mkdirSync(join(destination, "assets"));
  copyTree(join(sourceRoot, "assets/logo.png"), join(destination, "assets/logo.png"));
  copyTree(join(sourceRoot, "skills"), join(destination, "skills"));
  for (const name of readdirSync(join(destination, "skills"))) {
    const skill = readFileSync(join(destination, "skills", name, "SKILL.md"), "utf8");
    assert.match(skill, /^---\r?\n/);
    assert.match(skill, /^name: .+/m);
    assert.match(skill, /^description: .+/m);
  }
  return manifest;
}

function main() {
  const { values } = parseArgs({
    options: { check: { type: "boolean" }, "review-config": { type: "string" } },
  });
  const temporary = mkdtempSync(join(tmpdir(), "uploads-openai-plugin-"));
  try {
    const staging = join(temporary, "package");
    const config = values["review-config"] ? readJson(resolve(values["review-config"])) : undefined;
    const manifest = stageOpenAIPlugin(root, staging, config);
    const output = values.check
      ? join(temporary, "plugin.zip")
      : join(root, "dist/plugins", `uploads-openai-${manifest.version}.zip`);
    mkdirSync(dirname(output), { recursive: true });
    const archive = join(temporary, "plugin.zip");
    execFileSync(
      "zip",
      ["-X", "-q", "-r", archive, "plugin.json", "mcp.json", "assets", "skills"],
      { cwd: staging },
    );
    execFileSync("unzip", ["-tq", archive]);
    if (!values.check) copyFileSync(archive, output);
    console.log(
      values.check ? "OpenAI directory package valid" : `OpenAI directory ZIP: ${output}`,
    );
    if (!config)
      console.log(
        "Draft package: review cases and recording still need portal entry or --review-config.",
      );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
