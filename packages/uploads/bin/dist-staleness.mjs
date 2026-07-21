// Dev-only staleness guard for the linked `uploads` CLI (issue #295).
//
// A globally-linked `uploads` binary resolves to this monorepo package and
// imports the compiled `dist/cli.js`. `dist/` is only rebuilt by an explicit
// `pnpm --filter @buildinternet/uploads build`, so after pulling new source
// the linked CLI can silently keep running old compiled code while
// `--version` still reports the current package version.
//
// This module is intentionally plain, dependency-free JS (not compiled)
// so it can run before `dist/` is imported, and so it has no cost at all
// for a published npm install: `files` in package.json ships only
// `bin/`, `dist/`, and `README.md` — never `src/` — so `sourceDir` below
// simply won't exist there, and `checkDistStaleness` returns early after
// one `existsSync` call.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Recursively find the newest mtime (ms) among files under `dir`. */
function newestMtimeMs(dir) {
  let newest = -Infinity;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          const mtimeMs = statSync(full).mtimeMs;
          if (mtimeMs > newest) newest = mtimeMs;
        } catch {
          // ignore races (file removed between readdir and stat)
        }
      }
    }
  }
  return newest;
}

/**
 * Compare source mtime against dist mtime.
 *
 * @param {string} packageRoot absolute path to packages/uploads
 * @returns {{ stale: boolean, checked: boolean, reason?: string }}
 *   `checked` is false when there's no source tree to compare against
 *   (i.e. a published install) — the check is a no-op in that case.
 */
export function checkDistStaleness(packageRoot) {
  const sourceDir = join(packageRoot, "src");
  const distDir = join(packageRoot, "dist");

  // No src/ tree ships in the published npm package (see package.json
  // "files"), so this is the cheapest reliable signal that we're running
  // inside the monorepo (dev/linked context) rather than a published install.
  if (!existsSync(sourceDir)) {
    return { stale: false, checked: false };
  }

  if (!existsSync(distDir)) {
    return { stale: true, checked: true, reason: "dist/ is missing" };
  }

  const sourceMtime = newestMtimeMs(sourceDir);
  const distMtime = newestMtimeMs(distDir);

  if (sourceMtime > distMtime) {
    return { stale: true, checked: true, reason: "dist/ predates src/" };
  }

  return { stale: false, checked: true };
}

/** Print a one-line stderr warning if the dev build looks stale. Never throws. */
export function warnIfDistStale(packageRoot) {
  try {
    const result = checkDistStaleness(packageRoot);
    if (result.checked && result.stale) {
      process.stderr.write(
        `warning: uploads dev build is stale (${result.reason}) — run \`pnpm --filter @buildinternet/uploads build\`\n`,
      );
    }
  } catch {
    // Never let the staleness check itself break the CLI.
  }
}
