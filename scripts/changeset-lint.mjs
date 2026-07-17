/**
 * Fail if any changeset targets a package in the changesets `ignore` list.
 *
 * Such a changeset can never produce a release (the package is versioned out of
 * band — Workers Builds, not npm), yet it makes `changeset version` yield an
 * empty diff. The Release workflow's changesets/action then dies creating the
 * version PR ("No commits between main and changeset-release/main") *before*
 * the publish step, silently blocking every npm publish. This guard keeps such
 * a changeset from ever landing. See the uploads-release-changeset-poison note.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const changesetDir = join(dirname(fileURLToPath(import.meta.url)), "..", ".changeset");
const config = JSON.parse(readFileSync(join(changesetDir, "config.json"), "utf8"));
const ignored = new Set(config.ignore ?? []);

const files = readdirSync(changesetDir).filter(
  (f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md",
);

const offenders = [];
for (const file of files) {
  const text = readFileSync(join(changesetDir, file), "utf8");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!frontmatter) continue;
  for (const line of frontmatter[1].split(/\r?\n/)) {
    // Frontmatter entries look like: "@uploads/web": patch
    const match = /^\s*["']?(@?[\w./-]+)["']?\s*:/.exec(line);
    if (match && ignored.has(match[1])) offenders.push({ file, pkg: match[1] });
  }
}

if (offenders.length > 0) {
  console.error(
    "changeset-lint: changeset(s) target packages in the changesets `ignore` list.\n" +
      "These can never be released (they deploy via Workers Builds, not npm) and\n" +
      "will BLOCK the npm publish — the version PR comes out empty and the Release\n" +
      'workflow fails with "No commits between main and changeset-release/main".\n' +
      "Remove the changeset(s) below (the underlying change ships on its own):\n",
  );
  for (const { file, pkg } of offenders) console.error(`  - .changeset/${file} → ${pkg}`);
  process.exit(1);
}

console.log(`changeset-lint: ${files.length} changeset(s) OK — none target ignored packages.`);
