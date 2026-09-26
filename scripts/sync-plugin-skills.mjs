/**
 * Copy the public skills from skills/ into the Claude plugin folder.
 *
 * skills/ at the repo root is the source of truth: the Agent Plugins spec,
 * Codex, `npx skills add`, and the web worker all read it there. The Claude
 * plugin directory validates only the plugin folder and refuses files outside
 * it or symlinks, so plugins/claude/uploads/skills/ holds a generated copy.
 * Never edit the copy by hand.
 *
 *   node scripts/sync-plugin-skills.mjs          # write the copy
 *   node scripts/sync-plugin-skills.mjs --check  # exit 1 if the copy drifted
 */
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "skills");
const target = join(root, "plugins/claude/uploads/skills");
const check = process.argv.includes("--check");

function listFiles(base, dir = base) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === ".DS_Store") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...listFiles(base, path));
    else out.push(relative(base, path));
  }
  return out.sort();
}

if (check) {
  const want = listFiles(source);
  const have = listFiles(target);
  const problems = [];
  for (const rel of want) {
    if (!have.includes(rel)) problems.push(`missing: ${rel}`);
    else if (!readFileSync(join(source, rel)).equals(readFileSync(join(target, rel)))) {
      problems.push(`differs: ${rel}`);
    }
  }
  for (const rel of have) {
    if (!want.includes(rel)) problems.push(`extra: ${rel}`);
  }
  if (problems.length > 0) {
    console.error(
      `plugins/claude/uploads/skills/ is out of sync with skills/:\n  ${problems.join("\n  ")}\n` +
        "Run `pnpm plugin-skills:sync` and commit the result.",
    );
    process.exit(1);
  }
  console.log(`plugin skills ok (${want.length} file(s))`);
} else {
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, {
    recursive: true,
    filter: (path) => !path.endsWith(".DS_Store"),
  });
  console.log(`plugin skills → ${relative(root, target)} (${listFiles(target).length} file(s))`);
}
