/**
 * Fail if any changeset names a package that cannot be released. Two distinct
 * ways this breaks the Release workflow, both rejected here at PR time:
 *
 * 1. UNKNOWN — a name that is not a workspace package at all, e.g. the private
 *    root `uploads` instead of the published `@buildinternet/uploads`. This is a
 *    hard failure: `changeset version` throws "Found changeset X for package Y
 *    which is not in the workspace" and the Release job dies. Landed twice
 *    (#518, #629).
 *
 * 2. IGNORED — a package in the changesets `ignore` list. It can never produce a
 *    release (versioned out of band via Workers Builds, not npm), yet it makes
 *    `changeset version` yield an empty diff. The Release workflow's
 *    changesets/action then dies creating the version PR ("No commits between
 *    main and changeset-release/main") *before* the publish step, silently
 *    blocking every npm publish. See the uploads-release-changeset-poison note.
 *
 * 3. STALE IGNORE — an `ignore` entry that no longer names a workspace package
 *    (the package was deleted or renamed). changesets validates the list when it
 *    parses the config, so `changeset version` throws a ValidationError on main
 *    and blocks every npm publish. Landed once (#522, fixed in #523; #525).
 *
 * Why not `changeset status`? It catches (1) but not (2) — an ignored-package
 * changeset reports as a clean, empty release plan, exit 0. It also resolves the
 * base branch through git history, so it fails outright on CI's shallow checkout
 * ("Failed to find where HEAD diverged from main") before validating anything.
 * This check is purely static: no git, no network, same shallow clone as lint.
 *
 * The workspace package list comes from @manypkg/get-packages, the same resolver
 * changesets itself uses, so membership here means membership there.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getPackages } from "@manypkg/get-packages";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const changesetDir = join(root, ".changeset");
const config = JSON.parse(readFileSync(join(changesetDir, "config.json"), "utf8"));
const ignored = new Set(config.ignore ?? []);

// Mirrors how changesets resolves the workspace: the root package is excluded
// unless it is itself a workspace member, which is exactly why a changeset keyed
// "uploads" (the private root) is invalid.
const { packages } = await getPackages(root);
const known = new Set(packages.map((p) => p.packageJson.name));

const files = readdirSync(changesetDir).filter(
  (f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md",
);

// Entries with glob characters are micromatch expressions; only literal names
// can be checked by set membership.
const staleIgnores = [...ignored].filter((name) => !/[*?{}[\]!]/.test(name) && !known.has(name));

const unknown = [];
const ignoredHits = [];
for (const file of files) {
  const text = readFileSync(join(changesetDir, file), "utf8");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!frontmatter) continue;
  for (const line of frontmatter[1].split(/\r?\n/)) {
    // Frontmatter entries look like: "@uploads/web": patch
    const match = /^\s*["']?(@?[\w./-]+)["']?\s*:/.exec(line);
    if (!match) continue;
    const pkg = match[1];
    if (ignored.has(pkg)) ignoredHits.push({ file, pkg });
    else if (!known.has(pkg)) unknown.push({ file, pkg });
  }
}

if (unknown.length > 0) {
  console.error(
    "changeset-lint: changeset(s) name a package that is not in the workspace.\n" +
      '`changeset version` will throw "Found changeset ... which is not in the\n' +
      'workspace" and FAIL the Release job. Note the published CLI is\n' +
      "`@buildinternet/uploads` (CLI) or `@uploads/plugin` (Claude/Codex plugin).\n" +
      "`uploads` is the private root package, which is not a valid changeset\n" +
      "target. Fix the package name below:\n",
  );
  for (const { file, pkg } of unknown) console.error(`  - .changeset/${file} → ${pkg}`);
  console.error(`\nValid targets: ${[...known].sort().join(", ")}`);
}

if (ignoredHits.length > 0) {
  console.error(
    "changeset-lint: changeset(s) target packages in the changesets `ignore` list.\n" +
      "These can never be released (they deploy via Workers Builds, not npm) and\n" +
      "will BLOCK the npm publish — the version PR comes out empty and the Release\n" +
      'workflow fails with "No commits between main and changeset-release/main".\n' +
      "Remove the changeset(s) below (the underlying change ships on its own):\n",
  );
  for (const { file, pkg } of ignoredHits) console.error(`  - .changeset/${file} → ${pkg}`);
}

if (staleIgnores.length > 0) {
  console.error(
    "changeset-lint: the changesets `ignore` list names package(s) that are not in\n" +
      "the workspace. `changeset version` rejects the config and the Release job\n" +
      "FAILS on main. A package was probably deleted or renamed: remove or update\n" +
      "its entry in .changeset/config.json:\n",
  );
  for (const name of staleIgnores) console.error(`  - ${name}`);
}

if (unknown.length > 0 || ignoredHits.length > 0 || staleIgnores.length > 0) process.exit(1);

console.log(
  `changeset-lint: ${files.length} changeset(s) OK — all name releasable workspace packages.`,
);
