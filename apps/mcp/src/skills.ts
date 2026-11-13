/**
 * Skills over MCP (SEP-2640, `io.modelcontextprotocol/skills`): serves the
 * repo-root `skills/` — the same files `uploads install` and
 * `npx skills add buildinternet/uploads` install — as `skill://<name>/SKILL.md`.
 * Clients that support the extension discover them with `skills/list`; others
 * still see each SKILL.md in `resources/list`.
 *
 * The files are bundled at build time (`.md` imports are text modules, see
 * wrangler.jsonc `rules` and vitest.config.ts), so a deploy is what changes them.
 */
import { SkillsExtension, memorySkillFiles } from "@modelcontextprotocol/server/ext/skills";
import annotateScreenshots from "../../../skills/annotate-screenshots/SKILL.md";
import githubScreenshots from "../../../skills/github-screenshots/SKILL.md";
import uploadsCli from "../../../skills/uploads-cli/SKILL.md";

export const SKILL_FILES: Record<string, string> = {
  "annotate-screenshots/SKILL.md": annotateScreenshots,
  "github-screenshots/SKILL.md": githubScreenshots,
  "uploads-cli/SKILL.md": uploadsCli,
};

let catalog: Promise<SkillsExtension | undefined> | undefined;

/**
 * Built once per isolate; attach the result to each request's server. A skill
 * that breaks the Agent Skills rules is skipped with a log line (the test
 * suite loads these strictly), and a failed load serves no skills rather than
 * failing the request.
 */
export function loadSkills(): Promise<SkillsExtension | undefined> {
  catalog ??= SkillsExtension.load(memorySkillFiles(SKILL_FILES), {
    // Fixed per deploy and the same for every caller.
    cacheHint: { ttlMs: 3_600_000, cacheScope: "public" },
    onWarning: (warning) => console.error({ event: "mcp_skill_warning", ...warning }),
  }).catch((err: unknown) => {
    console.error({ event: "mcp_skills_load_failed", err });
    catalog = undefined;
    return undefined;
  });
  return catalog;
}
