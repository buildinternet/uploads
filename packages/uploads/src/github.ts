import { sanitizeKeySegment } from "./keys.js";
import { UsageError } from "./cli-args.js";
import { isMetaValueSafe } from "./metadata.js";
import {
  ghPrivateAttachmentKey,
  ghPrivateBranchAttachmentKey,
  parseGhPrivateKey,
  type GhTarget,
  type GhTargetKind,
} from "./github-comment.generated.js";

export {
  AUTO_RENDER_OPTIONS,
  ATTACHMENT_IMAGE_WIDTH_DEFAULT,
  ATTACHMENT_IMAGE_WIDTH_PAIR,
  ATTACHMENT_IMAGE_WIDTH_PORTRAIT,
  ATTACHMENT_IMAGE_WIDTH_WIDE,
  ATTACHMENTS_MARKER,
  GH_PRIVATE_ROOT,
  MAX_INLINE_ATTACHMENT_IMAGES,
  attachmentDensityForCount,
  attachmentImageWidth,
  attachmentPairWidth,
  attachmentsCommentBody,
  attachmentsMarker,
  ghKeyPrefix,
  ghPrivateAttachmentKey,
  ghPrivateBranchAttachmentKey,
  ghPrivateBranchKeyPrefix,
  ghPrivateKeyPrefix,
  parseGhPrivateKey,
  type AttachmentDensity,
  type AttachmentItem,
  type CommentRenderOptions,
  type GalleryCommentItem,
  type GhTarget,
  type GhTargetKind,
} from "./github-comment.generated.js";

/** A normalized GitHub issue/PR coordinate used for gallery references. */
export interface GithubCoordinate {
  coordinate: string;
  canonicalUrl: string;
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function isValidRepo(repo: string): boolean {
  return REPO_RE.test(repo);
}

/** Parse "owner/name" from a git remote URL (SSH or HTTPS), else undefined. */
export function parseRepoFromRemoteUrl(url: string): string | undefined {
  const match = url.trim().match(/[/:]([^/:\s]+\/[^/:\s]+?)(?:\.git)?\/?$/);
  const repo = match?.[1];
  return repo && isValidRepo(repo) ? repo : undefined;
}

/** Normalize a GitHub issue or pull-request coordinate for gallery linking. */
export function normalizeGithubCoordinate(value: string): GithubCoordinate | undefined {
  const input = value.trim();
  let match = /^([^/\s#]+)\/([^/\s#]+)#([1-9][0-9]*)$/.exec(input);
  if (!match) {
    try {
      const url = new URL(input);
      if (
        url.protocol !== "https:" ||
        url.hostname.toLowerCase() !== "github.com" ||
        url.port ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        return undefined;
      match = /^\/([^/]+)\/([^/]+)\/(?:issues|pull)\/([1-9][0-9]*)\/?$/.exec(url.pathname);
    } catch {
      return undefined;
    }
  }
  if (!match) return undefined;
  const [, ownerRaw, repositoryRaw, numberRaw] = match;
  const repo = ownerRaw + "/" + repositoryRaw;
  const number = Number(numberRaw);
  if (!isValidRepo(repo) || !Number.isSafeInteger(number)) return undefined;
  const owner = ownerRaw.toLowerCase();
  const repository = repositoryRaw.toLowerCase();
  const coordinate = owner + "/" + repository + "#" + number;
  return {
    coordinate,
    canonicalUrl:
      "https://github.com/" +
      encodeURIComponent(owner) +
      "/" +
      encodeURIComponent(repository) +
      "/issues/" +
      number,
  };
}

/**
 * Inverse of `ghKeyPrefix`: parse the PR/issue coordinate back out of a
 * stable attachment key (`gh/<owner>/<name>/<kind>/<num>/<filename>`), or
 * undefined for any other key shape.
 *
 * A real GitHub owner CAN be named `private`, so the strict private-repo
 * shape (`gh/private/<32-hex-id>/...`, see `parseGhPrivateKey`) is checked
 * first and rejected here — otherwise a private-prefixed key would
 * misparse as an ordinary key with owner "private". The accepted ambiguity:
 * a key whose second segment is NOT 32-lowercase-hex (e.g.
 * `gh/private/realrepo/pull/5/x.png`) still parses here as owner "private",
 * repo "private/realrepo" — that's an ordinary public-repo key for a repo
 * actually named "private", not a private-prefix key.
 */
export function parseGhKey(key: string): GhTarget | undefined {
  if (parseGhPrivateKey(key)) return undefined;
  const match = /^gh\/([^/]+)\/([^/]+)\/(pull|issues)\/([1-9][0-9]*)\/./.exec(key);
  if (!match) return undefined;
  const [, owner, name, kind, num] = match;
  return { repo: `${owner}/${name}`, kind: kind as GhTargetKind, num: Number(num) };
}

/**
 * Stable attachment key: same filename → same key → same public URL, so
 * re-uploading updates every existing embed. Deliberately NO content hash
 * (unlike buildScreenshotKey).
 */
export function ghAttachmentKey(target: GhTarget, filename: string): string {
  const [owner, name] = target.repo.split("/");
  return `gh/${sanitizeKeySegment(owner)}/${sanitizeKeySegment(name)}/${target.kind}/${target.num}/${sanitizeKeySegment(filename)}`;
}

/**
 * Branch-staged attachment key prefix: `gh/<owner>/<repo>/branch/<branch>/`.
 * Pre-PR staging (Phase 1 of branch-staged attachments) — no PR/issue number
 * exists yet. `branch` goes through `sanitizeKeySegment` like every other key
 * segment, so e.g. `feature/x` becomes `feature-x`.
 */
export function ghBranchKeyPrefix(repo: string, branch: string): string {
  const [owner, name] = repo.split("/");
  return `gh/${sanitizeKeySegment(owner)}/${sanitizeKeySegment(name)}/branch/${sanitizeKeySegment(branch)}/`;
}

/** Branch-staged attachment key: `ghBranchKeyPrefix` + the sanitized filename. */
export function ghBranchAttachmentKey(repo: string, branch: string, filename: string): string {
  return `${ghBranchKeyPrefix(repo, branch)}${sanitizeKeySegment(filename)}`;
}

/**
 * Structural stand-in for `ResolveGhPrefixResult` (defined in client.ts) —
 * kept local so these key builders don't need to import client types just
 * to own the plain-vs-private branch.
 */
export type GhKeyMode = { mode: "plain" } | { mode: "private"; prefixId: string };

/**
 * Mode-owning attachment key builder: collapses the
 * `mode === "private" ? ghPrivateAttachmentKey(...) : ghAttachmentKey(...)`
 * ternary repeated across call sites into one place.
 */
export function ghAttachmentKeyForMode(
  mode: GhKeyMode,
  target: GhTarget,
  filename: string,
): string {
  return mode.mode === "private"
    ? ghPrivateAttachmentKey(mode.prefixId, target, filename)
    : ghAttachmentKey(target, filename);
}

/**
 * Mode-owning branch-staged attachment key builder. The private form
 * ignores `repo`/`branch` (a private-repo key has no branch-name segment,
 * see `ghPrivateBranchKeyPrefix`) and uses the prefix id instead.
 */
export function ghBranchAttachmentKeyForMode(
  mode: GhKeyMode,
  repo: string,
  branch: string,
  filename: string,
): string {
  return mode.mode === "private"
    ? ghPrivateBranchAttachmentKey(mode.prefixId, filename)
    : ghBranchAttachmentKey(repo, branch, filename);
}

/**
 * `gh.*` metadata for a branch-staged attach: `gh.repo`, `gh.kind=branch`,
 * `gh.branch` (lowercased), and `gh.staged-at` (ISO 8601 UTC, no fractional
 * seconds). No `gh.number`/`gh.ref`/`gh.title` — there is no PR/issue yet.
 * Throws `UsageError` when the lowercased branch name fails the metadata
 * value rule (printable ASCII, 1-512 chars) — unlike `gh.title`'s best-effort
 * degrade, a branch name the caller explicitly chose (via `--branch` or the
 * current git branch) is worth failing loudly on rather than silently
 * dropping from the metadata set.
 */
export function ghMetadataForBranch(
  repo: string,
  branch: string,
  now: Date = new Date(),
): Record<string, string> {
  const branchLower = branch.toLowerCase();
  if (!isMetaValueSafe(branchLower)) {
    throw new UsageError(
      `invalid --branch: "${branch}" must be printable ASCII to stage as gh.branch metadata`,
    );
  }
  return {
    "gh.repo": repo.toLowerCase(),
    "gh.kind": "branch",
    "gh.branch": branchLower,
    "gh.staged-at": now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    // Lifecycle tag (issue #339): flipped to "promoted" by server-side
    // promotion, so "in-flight staged media" is a plain equality query
    // (`meta.gh.status=staged`) — the metadata filter API can't express
    // "gh.promoted-at absent".
    "gh.status": "staged",
  };
}

/**
 * The four `gh.*` queryable-metadata pairs `uploads attach` writes
 * automatically (`.context/2026-07-13-file-metadata-design.md`). `gh.kind`
 * uses the API's singular vocabulary (`pull`/`issue`), distinct from
 * `GhTarget.kind`'s URL-segment spelling (`pull`/`issues`). `gh.repo` and
 * `gh.ref` are both lowercased so exact-match metadata search has one
 * canonical spelling regardless of source casing (`--repo`, git remote, and
 * `gh` output vary); `gh.ref` uses the same lowercased `owner/repo#number`
 * coordinate as gallery GitHub references, so both surfaces resolve the same
 * lookup key.
 */
export function ghMetadataFromTarget(target: GhTarget): Record<string, string> {
  const repo = target.repo.toLowerCase();
  return {
    "gh.repo": repo,
    "gh.kind": target.kind === "issues" ? "issue" : "pull",
    "gh.number": String(target.num),
    "gh.ref": `${repo}#${target.num}`,
  };
}

/**
 * Extra footer line appended only on the local-`gh` fallback path (never on
 * bot-authored comments). Short note that the App isn't on this repo yet.
 */
export const GH_FALLBACK_AUTHOR_NOTE =
  '<sub><a href="https://github.com/apps/uploads-sh">Install the uploads GitHub App</a> for bot-managed comments.</sub>';
