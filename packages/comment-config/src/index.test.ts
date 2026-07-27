import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AUTO_COMMENT_OPTIONS,
  parseRepoCommentConfig,
  resolveCommentOptions,
  type RepoCommentConfig,
  type WorkspaceCommentDefaults,
} from "./index";

/**
 * Parity fixture (issue #307) shared with the CLI copy
 * (packages/uploads/test/comment-config.test.ts) — see the module doc
 * comment in ./index.ts and packages/uploads/src/comment-config.ts for the
 * cross-reference. Generated from THIS (canonical) package; asserted from
 * both sides so the two copies can never drift silently.
 */
function loadGolden() {
  return JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../../../test/fixtures/comment-config-golden.json", import.meta.url)),
      "utf8",
    ),
  ) as {
    parseCases: {
      name: string;
      text: string;
      format: "yaml" | "json";
      expected: { config: RepoCommentConfig | null; warnings: string[] };
    }[];
    resolveCases: {
      name: string;
      repo: RepoCommentConfig | null;
      workspace: WorkspaceCommentDefaults | null;
      expected: ReturnType<typeof resolveCommentOptions>;
    }[];
  };
}

const golden = loadGolden();

describe("parseRepoCommentConfig", () => {
  it("parses a full valid yaml config", () => {
    const { config, warnings } = parseRepoCommentConfig(
      `comment:\n  imageWidth: full\n  maxInlineImages: 8\n  meta:\n    path: false\n    state: true\n  linkToFilePage: false\n  note: "Staging shots only."\n`,
      "yaml",
    );
    expect(warnings).toEqual([]);
    expect(config).toEqual({
      imageWidth: "full",
      maxInlineImages: 8,
      metaPath: false,
      metaState: true,
      linkToFilePage: false,
      note: "Staging shots only.",
    });
  });
  it("parses json format", () => {
    const { config } = parseRepoCommentConfig(
      JSON.stringify({ comment: { imageWidth: 640 } }),
      "json",
    );
    expect(config).toEqual({ imageWidth: 640 });
  });
  it("clamps numeric imageWidth to 160–1000", () => {
    expect(parseRepoCommentConfig("comment:\n  imageWidth: 40\n", "yaml").config).toEqual({
      imageWidth: 160,
    });
    expect(parseRepoCommentConfig("comment:\n  imageWidth: 5000\n", "yaml").config).toEqual({
      imageWidth: 1000,
    });
  });
  it("clamps maxInlineImages to 1–48", () => {
    expect(parseRepoCommentConfig("comment:\n  maxInlineImages: 0\n", "yaml").config).toEqual({
      maxInlineImages: 1,
    });
    expect(parseRepoCommentConfig("comment:\n  maxInlineImages: 99\n", "yaml").config).toEqual({
      maxInlineImages: 48,
    });
  });
  it("drops an invalid key with a warning, keeps the rest", () => {
    const { config, warnings } = parseRepoCommentConfig(
      "comment:\n  imageWidth: enormous\n  maxInlineImages: 4\n",
      "yaml",
    );
    expect(config).toEqual({ maxInlineImages: 4 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("imageWidth");
  });
  it("ignores unknown keys silently", () => {
    const { config, warnings } = parseRepoCommentConfig(
      "comment:\n  banana: true\n  linkToFilePage: false\nother: 1\n",
      "yaml",
    );
    expect(config).toEqual({ linkToFilePage: false });
    expect(warnings).toEqual([]);
  });
  it("drops an over-500-char note whole, with a warning — never truncates", () => {
    const { config, warnings } = parseRepoCommentConfig(
      `comment:\n  note: "${"x".repeat(501)}"\n`,
      "yaml",
    );
    expect(config).toEqual({});
    expect(warnings[0]).toContain("note");
  });
  it("treats empty/whitespace note as absent", () => {
    expect(parseRepoCommentConfig('comment:\n  note: "   "\n', "yaml").config).toEqual({});
  });
  it("returns null config + warning for unparseable yaml", () => {
    const { config, warnings } = parseRepoCommentConfig("comment: [unclosed", "yaml");
    expect(config).toBeNull();
    expect(warnings).toHaveLength(1);
  });
  it("returns null config for a non-object root or missing comment key", () => {
    expect(parseRepoCommentConfig("- a\n- b\n", "yaml").config).toBeNull();
    expect(parseRepoCommentConfig("other: 1\n", "yaml").config).toBeNull();
  });
  it("never throws on hostile input", () => {
    for (const text of ["", "\0", "!!js/function 'x'", "{", "comment: 3"]) {
      expect(() => parseRepoCommentConfig(text, "yaml")).not.toThrow();
    }
  });
});

describe("resolveCommentOptions", () => {
  it("returns AUTO options with all-auto sources for null inputs", () => {
    const { options, source } = resolveCommentOptions(null, null);
    expect(options).toEqual(AUTO_COMMENT_OPTIONS);
    expect(Object.values(source).every((s) => s === "auto")).toBe(true);
  });
  it("applies per-key precedence repo > workspace > auto", () => {
    const { options, source } = resolveCommentOptions(
      { imageWidth: "full" },
      { imageWidth: 640, maxInlineImages: 4 },
    );
    expect(options.imageWidth).toBe("full");
    expect(source.imageWidth).toBe("repo");
    expect(options.maxInlineImages).toBe(4);
    expect(source.maxInlineImages).toBe("workspace");
    expect(options.metaPath).toBe(true);
    expect(source.metaPath).toBe("auto");
  });
  it("maps workspace showMetadata:false to both meta fields", () => {
    const { options, source } = resolveCommentOptions(null, { showMetadata: false });
    expect(options.metaPath).toBe(false);
    expect(options.metaState).toBe(false);
    expect(source.metaPath).toBe("workspace");
  });
  it("repo meta override beats workspace showMetadata", () => {
    const { options } = resolveCommentOptions({ metaPath: true }, { showMetadata: false });
    expect(options.metaPath).toBe(true);
    expect(options.metaState).toBe(false);
  });
});

describe("comment-config-golden.json parity (canonical side)", () => {
  it.each(golden.parseCases)("parse: $name", ({ text, format, expected }) => {
    expect(parseRepoCommentConfig(text, format)).toEqual(expected);
  });

  it.each(golden.resolveCases)("resolve: $name", ({ repo, workspace, expected }) => {
    expect(resolveCommentOptions(repo, workspace)).toEqual(expected);
  });
});
