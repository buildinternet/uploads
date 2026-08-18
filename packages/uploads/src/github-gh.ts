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

type ExecFileOpts = {
  encoding: "utf8";
  input?: string;
  stdio: ["pipe", "pipe", "pipe"];
  timeout?: number;
};

/**
 * Windows npm shims are `.cmd`/`.bat`; bare `execFileSync` ENOENTs them.
 * Retry once with `shell: true` so PATHEXT resolves the shim. Other platforms
 * and non-ENOENT errors stay on the no-shell path. Args are from our CLI, not
 * free-form shell strings.
 */
function execFileSyncCompat(cmd: string, args: string[], opts: ExecFileOpts): string {
  try {
    return execFileSync(cmd, args, opts);
  } catch (err) {
    const isWinShim =
      process.platform === "win32" &&
      (err as NodeJS.ErrnoException).code === "ENOENT" &&
      !/\.(cmd|bat|exe|com)$/i.test(cmd);
    if (isWinShim) return execFileSync(cmd, args, { ...opts, shell: true });
    throw err;
  }
}

export const execRunner: CommandRunner = (cmd, args, input) =>
  execFileSyncCompat(cmd, args, { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] });

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
    execFileSyncCompat(cmd, args, {
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
 * marker comment is found even on threads past 100 comments. GitHub returns
 * comments oldest-first, so `hits[0]` (after merging paginated pages, which
 * preserve that order) is the oldest exact-`marker` hit.
 *
 * Hunts for `marker` (the namespaced, per-workspace marker) first; when none
 * is found, falls back to a comment carrying the shared legacy
 * `ATTACHMENTS_MARKER` (pre-4b, unnamespaced) so it can be adopted and
 * migrated in place. When `marker` IS the legacy marker (no workspace to
 * namespace with) this collapses to a single hunt, unchanged from pre-4b
 * behavior.
 *
 * Collects EVERY comment carrying `marker` (a create race can leave more
 * than one — issue #486, mirroring the bot path's #470 fix): the oldest is
 * `comment`, the rest come back as `extras` for the caller to delete. Only
 * exact-`marker` hits are ever extras — a legacy (unnamespaced) comment may
 * belong to a different workspace, so it is adopted at most, never deleted.
 */
function findManagedComment(
  target: GhTarget,
  run: CommandRunner,
  marker: string,
): { comment?: GhComment; extras?: GhComment[] } {
  const raw = run("gh", [
    "api",
    `repos/${target.repo}/issues/${target.num}/comments?per_page=100`,
    "--paginate",
  ]);
  const comments = JSON.parse(raw) as GhComment[];
  const hits = comments.filter((c) => typeof c.body === "string" && c.body.includes(marker));
  if (hits.length > 0) {
    // In legacy mode (no workspace to namespace with) our "exact" marker IS
    // the shared one, so a second hit is not our own duplicate — it may be
    // another workspace's comment. Adopt the oldest and never delete: the
    // adopt-only contract is about the marker being ambiguous, which is just
    // as true when it is the marker we are hunting on.
    const extras = marker === ATTACHMENTS_MARKER ? undefined : hits.slice(1);
    return { comment: hits[0], extras };
  }
  if (marker === ATTACHMENTS_MARKER) return {};
  const legacyHit = comments.find(
    (c) => typeof c.body === "string" && c.body.includes(ATTACHMENTS_MARKER),
  );
  return { comment: legacyHit };
}

/**
 * Create the managed attachments comment, or edit it in place if it already
 * exists. Never touches any other comment except best-effort deletes of
 * duplicate marker comments (see below). Body is passed via stdin
 * (`-F body=@-`) so it is never shell-interpolated.
 *
 * `marker` identifies which comment to hunt for (see `findManagedComment`);
 * `body` is expected to already carry that same marker as its first line
 * (built via `attachmentsCommentBody(items, galleries, marker)`), so patching
 * an adopted legacy comment migrates it to the namespaced marker in place.
 * Defaults to the shared legacy marker for backward compatibility.
 *
 * Self-healing dedupe (issue #486, mirroring the bot path's #470/#484 fix):
 * a create race (two concurrent `uploads attach` runs, neither finding an
 * existing comment) can leave more than one marker comment on the thread.
 * This path has no id cache, so unlike the bot path a duplicate here never
 * heals on its own — every sync just patches the oldest and leaves the rest
 * stale. After patching (or creating), any extra exact-`marker` hits are
 * deleted best-effort via `gh api -X DELETE`; a failed delete is swallowed
 * and never fails the caller's command, and the next sync retries anyway.
 *
 * A create additionally re-hunts once it has written (issue #553, mirroring
 * the bot path): find-or-create is not atomic, so a concurrent writer can
 * create its own comment in the same window. Both writers independently agree
 * the OLDEST marker comment wins, fold their body into it and delete the rest
 * — including their own create — so the race converges instead of leaving a
 * stale orphan behind for a PR that never syncs again.
 *
 * On why this duplicates the bot path rather than deferring to it: the gh
 * fallback is a supported path, not a stopgap, so it is held at behavioral
 * parity deliberately. This file already reimplements the hunt, the legacy
 * adoption and the create-vs-patch gate against a different transport (the
 * `gh` subprocess, not the App's token), and #486 existed precisely because
 * the two drifted. Treat any behavior change to `upsertBotComment`
 * (apps/api/src/github-comment.ts) as owing a matching change here. Note
 * this is the one place the CLI deletes a GitHub resource under the
 * invoking human's own credentials — bounded to comments carrying this
 * workspace's exact namespaced marker, whose content is always
 * regenerable.
 */
export function upsertAttachmentsComment(
  target: GhTarget,
  body: string,
  run: CommandRunner = execRunner,
  marker: string = ATTACHMENTS_MARKER,
  opts: { createIfMissing?: boolean } = {},
): { action: "created" | "updated" | "skipped" } {
  const createIfMissing = opts.createIfMissing ?? true;
  const { comment: existing, extras } = findManagedComment(target, run, marker);

  if (existing) {
    patchComment(target, run, existing.id, body);
    deleteComments(target, run, extras);
    return { action: "updated" };
  }
  // Patch-only (createIfMissing false, i.e. an empty body) with no existing
  // comment: nothing to do — never create one just to say it's empty.
  if (!createIfMissing) return { action: "skipped" };
  // No existing marker hit means `extras` is necessarily empty here (see
  // `findManagedComment`) — nothing to delete before the create.
  const created = run(
    "gh",
    ["api", `repos/${target.repo}/issues/${target.num}/comments`, "-F", "body=@-"],
    body,
  );
  return reconcileAfterCreate(target, body, run, marker, created) ?? { action: "created" };
}

/**
 * Re-hunt right after a create and collapse whatever a concurrent writer left
 * behind (issue #553). Returns `{ action: "updated" }` when this run lost the
 * race — its body has been folded into the older winning comment and its own
 * create deleted — or null when nothing needed folding, including every
 * failure: a verification problem must never fail a successful create.
 *
 * The winner is patched BEFORE any delete, so a failed fold leaves both
 * comments (the next sync's hunt retries) rather than deleting the one that
 * carries the current body.
 */
function reconcileAfterCreate(
  target: GhTarget,
  body: string,
  run: CommandRunner,
  marker: string,
  createdRaw: string,
): { action: "updated" } | null {
  let createdId: number | undefined;
  try {
    createdId = (JSON.parse(createdRaw) as GhComment).id;
  } catch {
    // `gh` printed something unparseable — fall through to the hunt, which
    // identifies the winner on its own.
  }
  try {
    const { comment: winner, extras } = findManagedComment(target, run, marker);
    // `extras` is undefined in legacy mode, where a second hit may belong to
    // another workspace — the adopt-only contract holds here too.
    if (!winner || !extras?.length) return null;
    if (winner.id === createdId) {
      // Ours is the oldest and already carries the body we just wrote — only
      // the other writer's duplicate needs to go.
      deleteComments(target, run, extras);
      return null;
    }
    patchComment(target, run, winner.id, body);
    deleteComments(target, run, extras);
    return { action: "updated" };
  } catch {
    // A failed listing or fold leaves the freshly created comment in place —
    // correct content, one duplicate, healed by the next sync's hunt.
    return null;
  }
}

// --- link adoption (issue #708, local-gh fallback parity with the bot's
// #701/apps/api/src/github-link-adopt.ts) ---

/** Cheap, regex-only reject: no http(s) URL at all means nothing to scan for.
 * Mirrors `hasLinkCandidate` in apps/api/src/github-link-adopt.ts. */
export function hasLinkCandidate(text: string): boolean {
  return /https?:\/\//i.test(text);
}

const URL_RE = /https?:\/\/[^\s)"'<>\]]+/gi;

/**
 * Distinct http(s) URLs found in `text`, trailing prose punctuation
 * stripped, order preserved, first occurrence wins on duplicates. Ported
 * verbatim from apps/api/src/github-link-adopt.ts's `extractCandidateUrls`
 * so the two paths recognize the same URL spellings — resolution itself
 * (storage host / embed host / `/f/` page → key, and the bound-workspace
 * check) happens server-side inside `POST .../github/attach`, so this file
 * doesn't need its own copy of that logic.
 */
export function extractCandidateUrls(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(/[.,;:]+$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

/**
 * Best-effort concatenation of a PR/issue's current body plus every comment's
 * current body, for link-adoption scanning. Returns "" on any `gh` failure
 * (not authenticated, network, repo/number not found) — adoption degrades to
 * a no-op rather than blocking the comment sync it rides along with.
 *
 * Unlike the webhook path (which re-scans one specific body/comment ref per
 * event), the CLI has no per-event ref to key off of — `uploads comment` is
 * one ad-hoc invocation — so this scans the PR/issue body and every comment
 * on the thread in one pass every time it runs. That's a documented
 * divergence: harmless (adoption is idempotent) but does mean a link posted
 * in comment #1 gets rescanned on every later `uploads comment` run too.
 */
export function fetchAdoptionCandidateText(target: GhTarget, run: CommandRunner): string {
  let body = "";
  try {
    body = run("gh", ["api", `repos/${target.repo}/issues/${target.num}`, "--jq", '.body // ""']);
  } catch {
    // Not found / no access — fall through with an empty body; comments may
    // still be readable.
  }
  let comments = "";
  try {
    comments = run("gh", [
      "api",
      `repos/${target.repo}/issues/${target.num}/comments?per_page=100`,
      "--paginate",
      "--jq",
      '[.[].body] | join("\\n")',
    ]);
  } catch {
    // Same degrade — an empty comments blob just means nothing more to scan.
  }
  return `${body}\n${comments}`;
}

/** PATCH one comment's body via stdin, so the body is never shell-interpolated. */
function patchComment(target: GhTarget, run: CommandRunner, id: number, body: string): void {
  run(
    "gh",
    ["api", `repos/${target.repo}/issues/comments/${id}`, "-X", "PATCH", "-F", "body=@-"],
    body,
  );
}

/** Best-effort delete: a failed delete must never fail the caller's command,
 * and the next sync's hunt retries anyway. */
function deleteComments(
  target: GhTarget,
  run: CommandRunner,
  comments: GhComment[] | undefined,
): void {
  for (const c of comments ?? []) {
    try {
      run("gh", ["api", `repos/${target.repo}/issues/comments/${c.id}`, "-X", "DELETE"]);
    } catch {
      // Best effort only.
    }
  }
}
