import { execFileSync } from "node:child_process";
import { UsageError } from "./cli-args.js";
import {
  ATTACHMENTS_MARKER,
  isValidRepo,
  parseRepoFromRemoteUrl,
  type GhTarget,
} from "./github.js";

/** Runs a command and returns stdout; throws on non-zero exit. Injectable for tests. */
export type CommandRunner = (cmd: string, args: string[], input?: string) => string;

export const execRunner: CommandRunner = (cmd, args, input) =>
  execFileSync(cmd, args, { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] });

/**
 * Resolve "owner/name". Order: explicit --repo (validated) → `gh repo view`
 * (fork-aware) → parse the origin remote → UsageError.
 */
export function resolveRepo(explicit: string | undefined, run: CommandRunner = execRunner): string {
  if (explicit !== undefined) {
    if (!isValidRepo(explicit)) {
      throw new UsageError(`--repo must be owner/name (got: ${explicit})`);
    }
    return explicit;
  }
  try {
    const out = run("gh", [
      "repo",
      "view",
      "--json",
      "nameWithOwner",
      "--jq",
      ".nameWithOwner",
    ]).trim();
    if (isValidRepo(out)) return out;
  } catch {
    // gh missing, unauthenticated, or not in a repo — fall through
  }
  try {
    const url = run("git", ["config", "--get", "remote.origin.url"]).trim();
    const parsed = parseRepoFromRemoteUrl(url);
    if (parsed) return parsed;
  } catch {
    // not a git repo — fall through
  }
  throw new UsageError("could not infer repository from git — pass --repo owner/name");
}

/** Resolve the pull request associated with the current branch. */
export function resolveCurrentPullRequest(repo: string, run: CommandRunner = execRunner): GhTarget {
  try {
    // `gh pr view --repo` requires an explicit selector (it refuses to infer
    // from the current branch), so pass the branch name as the selector.
    const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    if (branch === "" || branch === "HEAD") throw new Error("detached HEAD");
    const out = run("gh", [
      "pr",
      "view",
      branch,
      "--repo",
      repo,
      "--json",
      "number",
      "--jq",
      ".number",
    ]).trim();
    if (/^\d+$/.test(out) && Number(out) > 0) {
      return { repo, kind: "pull", num: Number.parseInt(out, 10) };
    }
  } catch {
    // Normalize gh's varying errors into a stable, actionable CLI message.
  }
  throw new UsageError(
    "could not infer a pull request for the current branch — pass --pr <num> or --issue <num>",
  );
}

/**
 * Classify a bare PR/issue number via the GitHub API so the default `put`
 * path can stamp the right `gh.kind`. Returns undefined on any failure (gh
 * missing, 404, network) — the caller treats that as "no gh context" and
 * uploads without metadata.
 */
export function classifyGhNumber(
  repo: string,
  num: number,
  run: CommandRunner = execRunner,
): GhTarget | undefined {
  try {
    const out = run("gh", [
      "api",
      `repos/${repo}/issues/${num}`,
      "--jq",
      'if .pull_request then "pull" else "issue" end',
    ]).trim();
    if (out === "pull") return { repo, kind: "pull", num };
    if (out === "issue") return { repo, kind: "issues", num };
  } catch {
    // gh missing / not found / network — caller skips
  }
  return undefined;
}

interface GhComment {
  id: number;
  body: string;
}

/**
 * PR comments live on the issues endpoint, so one path covers PRs and issues.
 * Only the first 100 comments are searched (accepted v1 limitation).
 */
function findManagedComment(target: GhTarget, run: CommandRunner): GhComment | undefined {
  const raw = run("gh", ["api", `repos/${target.repo}/issues/${target.num}/comments?per_page=100`]);
  const comments = JSON.parse(raw) as GhComment[];
  return comments.find((c) => typeof c.body === "string" && c.body.includes(ATTACHMENTS_MARKER));
}

/**
 * Create the managed attachments comment, or edit it in place if it already
 * exists. Never touches any other comment. Body is passed via stdin
 * (`-F body=@-`) so it is never shell-interpolated.
 */
export function upsertAttachmentsComment(
  target: GhTarget,
  body: string,
  run: CommandRunner = execRunner,
): { created: boolean } {
  const existing = findManagedComment(target, run);
  if (existing) {
    run(
      "gh",
      [
        "api",
        `repos/${target.repo}/issues/comments/${existing.id}`,
        "-X",
        "PATCH",
        "-F",
        "body=@-",
      ],
      body,
    );
    return { created: false };
  }
  run("gh", ["api", `repos/${target.repo}/issues/${target.num}/comments`, "-F", "body=@-"], body);
  return { created: true };
}
