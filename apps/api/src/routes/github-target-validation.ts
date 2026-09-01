/**
 * Shared request-validation for the GitHub routes' `repo` and `branch`
 * fields. `routes/github-promote.ts`, `routes/github-branch-rename.ts` and
 * `routes/github-comment.ts` all take the same owner/name grammar, and the
 * two branch-taking routes take the same branch grammar — one home for the
 * regexes and the error codes so a tightening in one place can't miss the
 * others.
 */
import { ValidationError } from "@uploads/errors";

/**
 * Owner/name grammar, plus a guard against dot-only segments (".", ".."):
 * this string is interpolated into R2 key segments (promote/attach) and into
 * server-side `api.github.com` paths (comment), where "../" would traverse.
 */
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const DOTS_ONLY_RE = /^\.+$/;

/**
 * Printable ASCII only, matching file-metadata.ts's META_VALUE_MAX /
 * VALUE_SAFE_RE — a branch name is stored verbatim as the `gh.branch` D1
 * metadata value and sanitized into an R2 key segment.
 */
const BRANCH_VALUE_RE = /^[\x20-\x7E]+$/;
const BRANCH_VALUE_MAX = 512;

/** Throws `ValidationError` (`invalid_repo`) unless `repo` is a safe owner/name. */
export function validateRepo(repo: unknown): string {
  const value = typeof repo === "string" ? repo : "";
  if (!REPO_RE.test(value) || value.split("/").some((seg) => DOTS_ONLY_RE.test(seg))) {
    throw new ValidationError("repo must be owner/name.", { code: "invalid_repo" });
  }
  return value;
}

/**
 * Throws `ValidationError` (`invalid_branch`) unless `branch` is a non-empty
 * printable-ASCII string within the metadata value length limit.
 * `field` names the offending field in the message (`from`/`to` for the
 * branch-rename route); it does not change the code.
 */
export function validateBranch(branch: unknown, field = "branch"): string {
  const value = typeof branch === "string" ? branch : "";
  if (value.length === 0 || value.length > BRANCH_VALUE_MAX || !BRANCH_VALUE_RE.test(value)) {
    throw new ValidationError(`${field} must be a non-empty printable-ASCII string.`, {
      code: "invalid_branch",
    });
  }
  return value;
}
