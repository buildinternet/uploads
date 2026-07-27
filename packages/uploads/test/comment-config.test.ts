import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AUTO_COMMENT_OPTIONS,
  parseRepoCommentConfig,
  readLocalRepoCommentConfig,
  resolveCommentOptions,
} from "../src/comment-config.js";

let dirs: string[] = [];

function tmpRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uploads-comment-config-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("readLocalRepoCommentConfig", () => {
  it("prefers .uploads.yml at root over .github/uploads.yml", () => {
    const root = tmpRepo();
    fs.writeFileSync(path.join(root, ".uploads.yml"), "comment:\n  imageWidth: full\n");
    fs.mkdirSync(path.join(root, ".github"));
    fs.writeFileSync(path.join(root, ".github", "uploads.yml"), "comment:\n  imageWidth: 640\n");
    const { config, path: matched, warnings } = readLocalRepoCommentConfig(root);
    expect(matched).toBe(".uploads.yml");
    expect(config).toEqual({ imageWidth: "full" });
    expect(warnings).toEqual([]);
  });

  it("parses .uploads.json as JSON", () => {
    const root = tmpRepo();
    fs.writeFileSync(
      path.join(root, ".uploads.json"),
      JSON.stringify({ comment: { maxInlineImages: 4 } }),
    );
    const { config, path: matched } = readLocalRepoCommentConfig(root);
    expect(matched).toBe(".uploads.json");
    expect(config).toEqual({ maxInlineImages: 4 });
  });

  it("falls back to .github/uploads.yaml when no root-level file exists", () => {
    const root = tmpRepo();
    fs.mkdirSync(path.join(root, ".github"));
    fs.writeFileSync(
      path.join(root, ".github", "uploads.yaml"),
      "comment:\n  linkToFilePage: false\n",
    );
    const { config, path: matched } = readLocalRepoCommentConfig(root);
    expect(matched).toBe(".github/uploads.yaml");
    expect(config).toEqual({ linkToFilePage: false });
  });

  it("returns config: null, path: null when no candidate file exists", () => {
    const root = tmpRepo();
    const { config, path: matched, warnings } = readLocalRepoCommentConfig(root);
    expect(config).toBeNull();
    expect(matched).toBeNull();
    expect(warnings).toEqual([]);
  });

  it("returns config: null with one warning for malformed YAML", () => {
    const root = tmpRepo();
    fs.writeFileSync(path.join(root, ".uploads.yml"), "comment: [unclosed");
    const { config, path: matched, warnings } = readLocalRepoCommentConfig(root);
    expect(config).toBeNull();
    expect(matched).toBe(".uploads.yml");
    expect(warnings).toHaveLength(1);
  });

  it("treats an unreadable file as absent and continues", () => {
    const root = tmpRepo();
    // A directory at the candidate path fails a utf8 read (EISDIR) — treat
    // as absent and move on to the next candidate rather than throwing.
    fs.mkdirSync(path.join(root, ".uploads.yml"));
    fs.writeFileSync(path.join(root, ".uploads.json"), JSON.stringify({ comment: { note: "hi" } }));
    const { config, path: matched } = readLocalRepoCommentConfig(root);
    expect(matched).toBe(".uploads.json");
    expect(config).toEqual({ note: "hi" });
  });
});

// Smoke subset of the parser/resolver cases (full coverage lives in
// packages/comment-config/src/index.test.ts — this is a byte-copy).
describe("parseRepoCommentConfig / resolveCommentOptions (smoke)", () => {
  it("clamps numeric imageWidth to 160-1000", () => {
    expect(parseRepoCommentConfig("comment:\n  imageWidth: 40\n", "yaml").config).toEqual({
      imageWidth: 160,
    });
  });

  it("drops an over-500-char note whole, with a warning", () => {
    const { config, warnings } = parseRepoCommentConfig(
      `comment:\n  note: "${"x".repeat(501)}"\n`,
      "yaml",
    );
    expect(config).toEqual({});
    expect(warnings[0]).toContain("note");
  });

  it("returns AUTO options with all-auto sources for null inputs", () => {
    const { options, source } = resolveCommentOptions(null, null);
    expect(options).toEqual(AUTO_COMMENT_OPTIONS);
    expect(Object.values(source).every((s) => s === "auto")).toBe(true);
  });
});
