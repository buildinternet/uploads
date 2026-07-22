import { execFileSync } from "node:child_process";
import { UsageError } from "./cli-args.js";
import {
  ATTACHMENTS_MARKER,
  ghMetadataFromTarget,
  isValidRepo,
  parseRepoFromRemoteUrl,
  type GhTarget,
} from "./github.js";
import { META_VALUE_MAX, isMetaValueSafe } from "./metadata.js";

/** Runs a command and returns stdout; throws on non-zero exit. Injectable for tests. */
export type CommandRunner = (cmd: string, args: string[], input?: string) => string;

export const execRunner: CommandRunner = (cmd, args, input) =>
  execFileSync(cmd, args, { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] });

/**
 * A `CommandRunner` bounded by `timeoutMs` (node's native `execFileSync`
 * `timeout` option). There is no other subprocess-timeout wrapper in this
 * codebase to reuse, so this is the minimal one: for a best-effort lookup
 * that must never block its caller for long (e.g. the bare-`put` nudge's `gh
 * pr view` check, issue #393), pass this instead of the default `execRunner`.
 */
export const timedExecRunner =
  (timeoutMs: number): CommandRunner =>
  (cmd, args, input) =>
    execFileSync(cmd, args, {
      encoding: "utf8",
      input,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: timeoutMs,
    });

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

/** Resolve the current git branch (`--branch` with no value). Throws UsageError on detached HEAD or outside a git repo. */
export function resolveCurrentBranch(run: CommandRunner = execRunner): string {
  let branch: string;
  try {
    branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  } catch {
    throw new UsageError(
      "could not determine the current git branch — pass --branch <name> or run inside a git repo",
    );
  }
  if (branch === "" || branch === "HEAD") {
    throw new UsageError(
      "could not determine the current branch (detached HEAD) — pass --branch <name>",
    );
  }
  return branch;
}

/**
 * Best-effort default-branch name via the local `origin/HEAD` ref (no
 * network call — just reads the ref git already cached from the last
 * fetch/clone). Returns undefined when it can't be determined (no origin,
 * `origin/HEAD` never set, not a git repo) — callers should treat that as
 * "unknown", not "no default branch exists".
 */
export function resolveDefaultBranch(run: CommandRunner = execRunner): string | undefined {
  try {
    const out = run("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).trim();
    if (!out) return undefined;
    const slash = out.indexOf("/");
    const branch = slash === -1 ? out : out.slice(slash + 1);
    return branch || undefined;
  } catch {
    return undefined;
  }
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

/**
 * Best-effort PR/issue title lookup via local `gh`. Returns undefined on any
 * failure (gh missing, unauthenticated, network, 404) — mirrors
 * `resolveCurrentPullRequest`/`classifyGhNumber`'s degrade-don't-throw
 * pattern. A title is a nice-to-have annotation, never a blocker: callers
 * must never let this failure abort an upload.
 */
export function resolveGhTitle(
  target: GhTarget,
  run: CommandRunner = execRunner,
): string | undefined {
  try {
    const out = run("gh", [
      target.kind === "pull" ? "pr" : "issue",
      "view",
      String(target.num),
      "--repo",
      target.repo,
      "--json",
      "title",
      "--jq",
      ".title",
    ]).trim();
    return out.length > 0 ? out : undefined;
  } catch {
    // gh missing / unauthenticated / not found / network — caller skips
    return undefined;
  }
}

/**
 * `ghMetadataFromTarget`'s 4 pairs, plus a best-effort `gh.title` (issue #267)
 * when `resolveGhTitle` yields one that also satisfies the metadata-value
 * rule every other pair follows (1-512 printable ASCII — `metadata.ts`'s
 * `META_VALUE_MAX`/`isMetaValueSafe`). Truncated to `META_VALUE_MAX` first;
 * a title left empty or unsafe by truncation (e.g. non-ASCII — real titles
 * often contain emoji or curly quotes) is silently omitted rather than
 * sanitized, matching `resolveGhTitle`'s own "degrade, don't fail the
 * upload" contract.
 */
export function ghMetadataFromTargetWithTitle(
  target: GhTarget,
  run: CommandRunner = execRunner,
): Record<string, string> {
  const base = ghMetadataFromTarget(target);
  const title = resolveGhTitle(target, run);
  if (title === undefined) return base;
  const truncated = title.length > META_VALUE_MAX ? title.slice(0, META_VALUE_MAX) : title;
  return isMetaValueSafe(truncated) ? { ...base, "gh.title": truncated } : base;
}

interface GhComment {
  id: number;
  body: string;
}

/**
 * PR comments live on the issues endpoint, so one path covers PRs and issues.
 * `--paginate` follows Link headers and merges every page into one array, so the
 * marker comment is found even on threads past 100 comments.
 *
 * Hunts for `marker` (the namespaced, per-workspace marker) first; when none
 * is found, falls back to a comment carrying the shared legacy
 * `ATTACHMENTS_MARKER` (pre-4b, unnamespaced) so it can be adopted and
 * migrated in place. When `marker` IS the legacy marker (no workspace to
 * namespace with) this collapses to a single hunt, unchanged from pre-4b
 * behavior.
 */
function findManagedComment(
  target: GhTarget,
  run: CommandRunner,
  marker: string,
): GhComment | undefined {
  const raw = run("gh", [
    "api",
    `repos/${target.repo}/issues/${target.num}/comments?per_page=100`,
    "--paginate",
  ]);
  const comments = JSON.parse(raw) as GhComment[];
  const namespacedHit = comments.find((c) => typeof c.body === "string" && c.body.includes(marker));
  if (namespacedHit) return namespacedHit;
  if (marker === ATTACHMENTS_MARKER) return undefined;
  return comments.find((c) => typeof c.body === "string" && c.body.includes(ATTACHMENTS_MARKER));
}

/**
 * Create the managed attachments comment, or edit it in place if it already
 * exists. Never touches any other comment. Body is passed via stdin
 * (`-F body=@-`) so it is never shell-interpolated.
 *
 * `marker` identifies which comment to hunt for (see `findManagedComment`);
 * `body` is expected to already carry that same marker as its first line
 * (built via `attachmentsCommentBody(items, galleries, marker)`), so patching
 * an adopted legacy comment migrates it to the namespaced marker in place.
 * Defaults to the shared legacy marker for backward compatibility.
 */
export function upsertAttachmentsComment(
  target: GhTarget,
  body: string,
  run: CommandRunner = execRunner,
  marker: string = ATTACHMENTS_MARKER,
): { created: boolean } {
  const existing = findManagedComment(target, run, marker);
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
