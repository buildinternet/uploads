/**
 * CLI comment-config: shared parser from the generated copy of
 * `@uploads/comment-config`, plus the local working-tree reader.
 * `readLocalRepoCommentConfig` is CLI-only — it reads the six candidate
 * config paths off the working tree (the server instead fetches them from
 * GitHub's contents API — apps/api/src/repo-comment-config.ts).
 */

import fs from "node:fs";
import { join } from "node:path";
import {
  parseRepoCommentConfig,
  REPO_CONFIG_PATHS,
  type RepoCommentConfig,
} from "./comment-config.generated.js";

export {
  AUTO_COMMENT_OPTIONS,
  NOTE_MAX_CHARS,
  REPO_CONFIG_PATHS,
  parseRepoCommentConfig,
  resolveCommentOptions,
  type OptionSource,
  type RepoCommentConfig,
  type ResolvedCommentOptions,
  type WorkspaceCommentDefaults,
} from "./comment-config.generated.js";

/**
 * Read the repo's comment config off the local working tree — the CLI has no
 * GitHub App installation token to fetch via the contents API, so this reads
 * `rootDir` directly. Returns the first candidate that exists (readable or
 * not); an unreadable file (permissions, or a directory at that path) is
 * treated as absent and the search continues to the next candidate, matching
 * a 404 in the server-side fetch.
 */
export function readLocalRepoCommentConfig(rootDir: string): {
  config: RepoCommentConfig | null;
  path: string | null;
  warnings: string[];
} {
  for (const candidate of REPO_CONFIG_PATHS) {
    let text: string;
    try {
      text = fs.readFileSync(join(rootDir, candidate), "utf8");
    } catch {
      continue;
    }
    const format = candidate.endsWith(".json") ? "json" : "yaml";
    const { config, warnings } = parseRepoCommentConfig(text, format);
    return { config, path: candidate, warnings };
  }
  return { config: null, path: null, warnings: [] };
}
