/**
 * GitHub issue artifacts for an issue's managed media (public preview).
 *
 * One Markdown artifact holds the same block as the attachments comment.
 * Images stay on uploads.sh URLs (GitHub's camo proxy loads them). A
 * `<video>` tag does not render in an artifact, so one becomes a link.
 * Bytes are never copied to GitHub and `gh issue artifact --attach` is
 * never used. A second artifact, type `link`, points at the issue's gallery
 * when it has one. Pull requests are not touched: their artifact page is
 * incomplete (`html_url` is null).
 *
 * Reruns find the artifact by name and PATCH it, which keeps GitHub's
 * version history. A failure here is a warning. The preview API can 429,
 * and that must not fail the attach.
 */
import type { GhTarget } from "./github.js";
import type { CommandRunner } from "./github-gh.js";

/** Stable artifact names. GitHub rejects parentheses in them. */
export const ISSUE_MEDIA_ARTIFACT_NAME = "uploads.sh media";
export const ISSUE_GALLERY_ARTIFACT_NAME = "uploads.sh gallery";

/** Per-call flag, then the repo file, then the workspace setting, then on. */
export function resolveIssueArtifacts(layers: {
  call?: boolean;
  repo?: boolean;
  workspace?: boolean;
}): boolean {
  return layers.call ?? layers.repo ?? layers.workspace ?? true;
}

export interface IssueArtifactSyncResult {
  media?: "created" | "updated";
  gallery?: "created" | "updated";
  /** Set when a GitHub call failed. Never fatal for the caller. */
  warning?: string;
}

interface ArtifactRow {
  number: number;
  name: string;
  body?: string;
}

/**
 * The comment body, with any `<video>` tag rewritten to a link. Artifact
 * markdown drops `<video>`, so the uploads.sh URL has to be a link or the
 * clip disappears. `<img>` tags are left alone: camo fetches those URLs.
 */
export function issueArtifactMediaBody(commentBody: string): string {
  return commentBody.replace(/<video\b([^>]*)>[\s\S]*?<\/video>/gi, (full, attrs: string) => {
    const src = /src\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    return src ? `[video](${src})` : full;
  });
}

/** First line of an error, capped, for a one-line warning. */
export function issueArtifactErrorLine(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const line = raw.split("\n")[0]?.trim() || raw;
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}

/**
 * Create or PATCH one artifact. Same body skips the write so a rerun does
 * not spend a preview-API request on an unchanged document.
 */
function upsertArtifact(
  base: string,
  run: CommandRunner,
  existing: ArtifactRow | undefined,
  spec: { type: "generic" | "link"; name: string; body: string },
): "created" | "updated" | undefined {
  if (existing?.body === spec.body) return undefined;
  if (existing) {
    run(
      "gh",
      ["api", "-X", "PATCH", `${base}/${existing.number}`, "--input", "-"],
      JSON.stringify({ body: spec.body }),
    );
    return "updated";
  }
  run("gh", ["api", "-X", "POST", base, "--input", "-"], JSON.stringify(spec));
  return "created";
}

/**
 * Create or update the issue's uploads.sh artifacts. No-op for pull requests.
 * Never throws: GitHub errors come back on `warning`.
 */
export function syncIssueArtifacts(
  target: GhTarget,
  run: CommandRunner,
  input: { commentBody?: string | null; galleryUrl?: string | null },
): IssueArtifactSyncResult {
  if (target.kind !== "issues") return {};
  const specs = [
    {
      key: "media",
      label: "issue artifact",
      type: "generic",
      name: ISSUE_MEDIA_ARTIFACT_NAME,
      body: input.commentBody?.trim() ? issueArtifactMediaBody(input.commentBody) : "",
    },
    {
      key: "gallery",
      label: "issue gallery link",
      type: "link",
      name: ISSUE_GALLERY_ARTIFACT_NAME,
      body: input.galleryUrl?.trim() ?? "",
    },
  ] as const;
  const todo = specs.filter((spec) => spec.body);
  if (todo.length === 0) return {};

  const base = `repos/${target.repo}/issues/${target.num}/artifacts`;
  let rows: ArtifactRow[];
  try {
    // One page, oldest first: enough to find the artifacts this command created.
    rows = JSON.parse(run("gh", ["api", `${base}?per_page=100`])) as ArtifactRow[];
    if (!Array.isArray(rows)) throw new Error("unexpected issue artifacts response");
  } catch (err) {
    return { warning: `issue artifact was not updated: ${issueArtifactErrorLine(err)}` };
  }

  const result: IssueArtifactSyncResult = {};
  const warnings: string[] = [];
  for (const { key, label, type, name, body } of todo) {
    try {
      const existing = rows.find((row) => row.name === name);
      const action = upsertArtifact(base, run, existing, { type, name, body });
      if (action) result[key] = action;
    } catch (err) {
      warnings.push(`${label} was not updated: ${issueArtifactErrorLine(err)}`);
    }
  }
  if (warnings.length > 0) result.warning = warnings.join("; ");
  return result;
}
