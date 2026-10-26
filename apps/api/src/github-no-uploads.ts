/**
 * The "no uploads yet" path: a PR that changes UI files but has nothing
 * attached. UI files are `uiPaths` from the repo's `.uploads.yml`, else the
 * workspace's UI file paths setting, else `DEFAULT_UI_PATHS`. The `uploads.sh`
 * check then says UI files changed, and the managed comment carries a short
 * how-to unless `noUploadsComment` is "never". With "always", every PR with
 * nothing attached gets the how-to, UI files or not. A repo's `uiPaths: []`
 * turns the check off.
 *
 * The how-to is the same marker-owned comment: the first upload replaces it
 * in place with the normal attachments body, so a PR never gets two.
 */
import { githubFetch, githubHeaders, repoInstallationToken } from "./github-app";
import { checklistLine, type ChecklistEntry, type GhTarget } from "./github-comment-render";

/**
 * The files that count as UI changes when nothing sets `uiPaths`. Mirrors the
 * CLI's pre-PR hook (`VISUAL_EXT` and `EMAIL_PATH` in
 * packages/uploads/src/commands/hook.ts), so the agent and the App agree.
 */
export const DEFAULT_UI_PATHS: readonly string[] = [
  "*.astro",
  "*.tsx",
  "*.jsx",
  "*.vue",
  "*.svelte",
  "*.html",
  "*.css",
  "*.scss",
  "*.less",
  "**/email/**",
];

/** Pages of 100 changed files read before giving up (GitHub caps the list at 3000). */
const MAX_FILE_PAGES = 3;
/** Changed UI files the comment and check name before "and N more". */
const NAMED_FILES = 3;

function escapeRegExp(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/**
 * Gitignore-flavoured glob → RegExp. `**` crosses directories, `*` and `?`
 * don't. A pattern without a `/` matches a file name at any depth (`*.css`);
 * one with a `/` is anchored at the repo root. A trailing `/` or a plain
 * directory (`apps/web`) matches everything under it.
 */
export function uiPathMatcher(patterns: readonly string[]): (file: string) => boolean {
  const regexes = patterns.map((raw) => {
    let p = raw.replace(/^\.?\//, "");
    if (p.endsWith("/")) p += "**";
    const anchored = p.includes("/");
    let src = "";
    for (let i = 0; i < p.length; i++) {
      const ch = p[i];
      if (ch === "*" && p[i + 1] === "*") {
        if (p[i + 2] === "/") {
          src += "(?:.*/)?";
          i += 2;
        } else {
          src += ".*";
          i += 1;
        }
      } else if (ch === "*") src += "[^/]*";
      else if (ch === "?") src += "[^/]";
      else src += escapeRegExp(ch);
    }
    // No wildcard: also match the directory's contents (`apps/web` → `apps/web/…`).
    const dir = /[*?]/.test(p) ? "" : "(?:/.*)?";
    return new RegExp(`^${anchored ? "" : "(?:.*/)?"}${src}${dir}$`);
  });
  return (file) => regexes.some((re) => re.test(file));
}

/**
 * The PR's changed files that match `uiPaths`, in GitHub's order. Empty when
 * nothing matches, and on any GitHub failure (no App, not installed, a non-OK
 * page): a missed how-to comment is harmless, a wrong one is noise.
 */
export async function changedUiFiles(
  env: Env,
  target: GhTarget,
  uiPaths: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  if (target.kind !== "pull" || uiPaths.length === 0) return [];
  try {
    const token = await repoInstallationToken(env, target.repo, fetchImpl);
    if (!token) return [];
    const matches = uiPathMatcher(uiPaths);
    const found: string[] = [];
    for (let page = 1; page <= MAX_FILE_PAGES; page++) {
      const res = await githubFetch(
        fetchImpl,
        `https://api.github.com/repos/${target.repo}/pulls/${target.num}/files?per_page=100&page=${page}`,
        { headers: githubHeaders(token) },
      );
      if (!res.ok) return [];
      const files = (await res.json().catch(() => null)) as
        | { filename?: unknown; status?: unknown; changes?: unknown }[]
        | null;
      if (!Array.isArray(files)) return [];
      for (const f of files) {
        // A deleted file, or one moved without edits, has nothing to screenshot.
        if (f.status === "removed" || (f.status === "renamed" && f.changes === 0)) continue;
        if (typeof f.filename === "string" && matches(f.filename)) found.push(f.filename);
      }
      if (files.length < 100) break;
    }
    return found;
  } catch {
    return [];
  }
}

/** `` `a.astro`, `b.css` and 3 more `` — the first few files, then a count. */
export function describeUiFiles(files: readonly string[]): string {
  const named = files.slice(0, NAMED_FILES).map((f) => `<code>${escapeHtml(f)}</code>`);
  const rest = files.length - named.length;
  if (rest > 0) return `${named.join(", ")} and ${rest} more`;
  if (named.length <= 1) return named.join("");
  return `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The how-to body for a PR with nothing attached. `uiFiles` names the UI files
 * that changed; empty ("always" on a PR without UI changes) drops that line.
 * Images dragged in on GitHub count too; the comment mentions the import
 * only when the repo's attachment import is on, so it never promises an
 * import that won't happen.
 */
export function noUploadsCommentBody(
  marker: string,
  target: Pick<GhTarget, "num">,
  uiFiles: readonly string[],
  opts: { importsAttachments: boolean; checklist?: readonly ChecklistEntry[] },
): string {
  const lines = [
    marker,
    "**No uploads on this PR yet**",
    "",
    uiFiles.length > 0
      ? `This PR changes UI files (${describeUiFiles(uiFiles)}). Screenshots help reviewers see what changed.`
      : "Screenshots help reviewers see what changed.",
    "",
    `- From the CLI: <code>uploads put before.png after.png --pr ${target.num}</code>`,
    "- From an agent: ask it to attach screenshots with uploads.sh",
  ];
  lines.push(
    opts.importsAttachments
      ? "- By hand: drag images into the PR description and they're imported automatically"
      : "- By hand: drag images into the PR description",
  );
  if (opts.checklist?.length) lines.push("", checklistLine(opts.checklist));
  lines.push(
    "",
    `<sub>Workspace admins can turn this comment off in Settings → GitHub · <a href="https://uploads.sh/docs/require-screenshots#no-uploads-comment">docs</a></sub>`,
  );
  return lines.join("\n");
}
