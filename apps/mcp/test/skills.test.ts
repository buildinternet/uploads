import { describe, expect, it } from "vitest";
import { SkillsExtension, memorySkillFiles } from "@modelcontextprotocol/server/ext/skills";
import { SKILL_FILES } from "../src/skills";

describe("skills served over MCP", () => {
  // The worker skips an invalid skill with a log line; this catches it in CI instead.
  it("are all valid Agent Skills", async () => {
    const catalog = await SkillsExtension.load(memorySkillFiles(SKILL_FILES), { strict: true });
    expect(catalog.entries.map((skill) => skill.frontmatter.name)).toEqual([
      "annotate-screenshots",
      "github-screenshots",
      "uploads-cli",
    ]);
  });
});
