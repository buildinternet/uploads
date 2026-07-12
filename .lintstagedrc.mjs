/**
 * lint-staged config — ESM so we can filter staged files before passing to the tools.
 *
 * Pre-commit also runs `pnpm types` (see `.husky/pre-commit`) so type-aware
 * oxlint sees generated `worker-configuration.d.ts` the same way CI does.
 *
 * Files under an oxlintrc/oxfmtrc ignorePattern are excluded from the matching
 * pass: handing a fully-ignored list to the tool makes it exit non-zero with
 * "No files found to lint" / "Expected at least one target file" when only
 * those files are staged.
 */

import path from "node:path";

// Repo-relative prefixes from `.oxfmtrc.json` ignorePatterns.
const OXFMT_IGNORED_DIRS = [".superpowers/"];

// Extra oxlint-only ignores from `.oxlintrc.json`.
const OXLINT_IGNORED_DIRS = [".superpowers/", "apps/api/scripts/"];

const isIgnored = (file, dirs) => {
  const rel = path.relative(process.cwd(), file);
  return dirs.some((dir) => rel.startsWith(dir)) || rel.endsWith(".d.ts");
};

const oxfmtCommand = (stagedFiles) => {
  const formattable = stagedFiles.filter((f) => !isIgnored(f, OXFMT_IGNORED_DIRS));
  return formattable.length > 0
    ? [`oxfmt --no-error-on-unmatched-pattern --write ${formattable.join(" ")}`]
    : [];
};

export default {
  "*.{js,jsx,ts,tsx,mjs,cjs}": (stagedFiles) => {
    const lintable = stagedFiles.filter((f) => !isIgnored(f, OXLINT_IGNORED_DIRS));
    return [
      ...(lintable.length > 0
        ? [`oxlint --no-error-on-unmatched-pattern ${lintable.join(" ")}`]
        : []),
      ...oxfmtCommand(stagedFiles),
    ];
  },
  "*.{json,jsonc,md,yml,yaml,css}": oxfmtCommand,
};
