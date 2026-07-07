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
