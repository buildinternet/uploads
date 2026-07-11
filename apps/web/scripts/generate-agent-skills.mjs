#!/usr/bin/env node
/**
 * Generate apps/web/public/.well-known/agent-skills/ from monorepo skill sources.
 *
 * Single source of truth: skills/<name>/SKILL.md at the repo root.
 * Do not hand-edit the generated public/.well-known/agent-skills tree —
 * it is gitignored and rewritten on every web dev/build.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const webRoot = join(__dirname, "..");
const repoRoot = join(webRoot, "../..");
const outRoot = join(webRoot, "public/.well-known/agent-skills");

/** @type {{ sourceRel: string }[]} */
const SKILLS = [{ sourceRel: "skills/uploads-cli/SKILL.md" }];

/**
 * Minimal YAML frontmatter parse for Agent Skills SKILL.md files.
 * Supports `name: value` and folded `description: >-` / `description: |` blocks.
 * @param {string} markdown
 */
function parseSkillFrontmatter(markdown) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    throw new Error("SKILL.md is missing YAML frontmatter (--- … ---)");
  }
  const block = match[1];
  const lines = block.split(/\r?\n/);
  /** @type {Record<string, string>} */
  const fields = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) {
      i += 1;
      continue;
    }
    const key = kv[1];
    const raw = kv[2];
    if (raw === ">-" || raw === ">" || raw === "|" || raw === "|-") {
      const folded = raw.startsWith(">");
      const parts = [];
      i += 1;
      while (i < lines.length && /^(?: {2}|\t)/.test(lines[i])) {
        parts.push(lines[i].replace(/^(?: {2}|\t)/, ""));
        i += 1;
      }
      fields[key] = folded ? parts.join(" ").replace(/\s+/g, " ").trim() : parts.join("\n").trim();
      continue;
    }
    fields[key] = raw.replace(/^["']|["']$/g, "").trim();
    i += 1;
  }
  if (!fields.name) throw new Error("SKILL.md frontmatter missing name");
  if (!fields.description) throw new Error("SKILL.md frontmatter missing description");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fields.name) || fields.name.length > 64) {
    throw new Error(`invalid skill name in frontmatter: ${fields.name}`);
  }
  if (fields.description.length > 1024) {
    throw new Error(`skill description exceeds 1024 characters: ${fields.name}`);
  }
  return { name: fields.name, description: fields.description };
}

async function main() {
  await rm(outRoot, { recursive: true, force: true });
  await mkdir(outRoot, { recursive: true });

  const skills = [];
  for (const { sourceRel } of SKILLS) {
    const sourcePath = join(repoRoot, sourceRel);
    const bytes = await readFile(sourcePath);
    const text = bytes.toString("utf8");
    const { name, description } = parseSkillFrontmatter(text);
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

    const skillDir = join(outRoot, name);
    await mkdir(skillDir, { recursive: true });
    const outSkill = join(skillDir, "SKILL.md");
    await writeFile(outSkill, bytes);

    skills.push({
      name,
      type: "skill-md",
      description,
      url: `/.well-known/agent-skills/${name}/SKILL.md`,
      digest,
    });

    console.log(`agent-skills: ${name} → ${digest} (from ${sourceRel})`);
  }

  const index = {
    $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
    skills,
  };
  const indexPath = join(outRoot, "index.json");
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  console.log(`agent-skills: wrote ${skills.length} skill(s) → ${indexPath}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
