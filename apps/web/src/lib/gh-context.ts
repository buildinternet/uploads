/**
 * Client-side derivations over files' `gh.*` metadata (see
 * `packages/uploads/src/github.ts`): a "connected work" list for the
 * right-rail summary and an exact-PR-match check for the files-tab banner.
 *
 * Files carry four required keys when tagged: `gh.repo` (lowercased
 * `owner/name`), `gh.kind` (`pull` | `issue`), `gh.number` (decimal string),
 * `gh.ref` (lowercased `owner/repo#number`). A fifth, optional `gh.title`
 * (issue #267) holds the real PR/issue title the CLI resolved at attach
 * time; older files never had it stamped, so the label falls back to `ref`
 * when it's absent. `githubUrl` mirrors `deriveGithubContext` in
 * `apps/api/src/routes/public-files.ts`.
 */

export type GhKind = "pull" | "issue";

export interface GhWorkItem {
  repo: string;
  kind: GhKind;
  number: string;
  ref: string;
  url: string;
  /** `gh.title` when the CLI resolved one at attach time, else `ref` (e.g. "o/uploads#1789"). */
  label: string;
  kindLabel: "pull request" | "issue";
}

/** `https://github.com/{repo}/{pull|issues}/{number}`. */
export function githubUrl(repo: string, kind: GhKind, number: string): string {
  const path = kind === "pull" ? "pull" : "issues";
  return `https://github.com/${repo}/${path}/${number}`;
}

/**
 * Build a work item from a file's metadata, requiring all four `gh.*` keys.
 * Any missing key (undefined metadata, or a partial tag) returns null.
 */
export function ghWorkItemFromMetadata(
  meta: Record<string, string> | undefined,
): GhWorkItem | null {
  if (!meta) return null;
  const repo = meta["gh.repo"];
  const kind = meta["gh.kind"];
  const number = meta["gh.number"];
  const ref = meta["gh.ref"];
  if (!repo || !kind || !number || !ref) return null;
  if (kind !== "pull" && kind !== "issue") return null;
  const title = meta["gh.title"];
  return {
    repo,
    kind,
    number,
    ref,
    url: githubUrl(repo, kind, number),
    label: title ? title : ref,
    kindLabel: kind === "pull" ? "pull request" : "issue",
  };
}

/** Distinct GitHub work items referenced by `files`, deduped by `ref`, first-seen order preserved. */
export function connectedWork(files: { metadata?: Record<string, string> }[]): GhWorkItem[] {
  const seen = new Set<string>();
  const items: GhWorkItem[] = [];
  for (const file of files) {
    const item = ghWorkItemFromMetadata(file.metadata);
    if (!item || seen.has(item.ref)) continue;
    seen.add(item.ref);
    items.push(item);
  }
  return items;
}

/**
 * The single pull request every GitHub-tagged file in `files` agrees on, or
 * null. Non-null only when the set of distinct refs among files carrying
 * `gh.*` metadata is exactly one, that ref resolves to a pull request, and
 * at least one file carried it (so an empty/untagged input is also null).
 */
export function exactPrMatch(files: { metadata?: Record<string, string> }[]): GhWorkItem | null {
  const items = connectedWork(files);
  if (items.length !== 1) return null;
  const [only] = items;
  return only.kind === "pull" ? only : null;
}
