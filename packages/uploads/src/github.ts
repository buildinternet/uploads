import { sanitizeKeySegment } from "./keys.js";

export type GhTargetKind = "pull" | "issues";

export interface GhTarget {
  /** "owner/name" */
  repo: string;
  kind: GhTargetKind;
  num: number;
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

export function ghKeyPrefix(target: GhTarget): string {
  const [owner, name] = target.repo.split("/");
  return `gh/${sanitizeKeySegment(owner)}/${sanitizeKeySegment(name)}/${target.kind}/${target.num}/`;
}

/**
 * Stable attachment key: same filename → same key → same public URL, so
 * re-uploading updates every existing embed. Deliberately NO content hash
 * (unlike buildScreenshotKey).
 */
export function ghAttachmentKey(target: GhTarget, filename: string): string {
  return `${ghKeyPrefix(target)}${sanitizeKeySegment(filename)}`;
}
