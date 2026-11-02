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

/** Stable name for the Markdown media artifact. No parentheses (GitHub rejects them). */
export const ISSUE_MEDIA_ARTIFACT_NAME = "uploads.sh media";
/** Stable name for the gallery link artifact. */
export const ISSUE_GALLERY_ARTIFACT_NAME = "uploads.sh gallery";

const ARTIFACT_PAGE_SIZE = 100;
const ARTIFACT_MAX_PAGES = 10;

export interface IssueArtifactSyncInput {
  /** Managed comment body. Empty or absent skips the media artifact. */
  commentBody?: string | null;
  /** Gallery URL. Absent skips the link artifact. */
  galleryUrl?: string | null;
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
  body: string;
}

/**
 * Drop parentheses. GitHub rejects artifact names that contain them
 * (`plan (1).md` is stored as `plan 1.md` by the CLI).
 */
export function issueArtifactName(name: string): string {
  // GitHub drops parentheses rather than rejecting the whole create:
  // `plan (1).md` is stored as `plan 1.md`.
  return name
    .replace(/[()]/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/**
 * The comment body, with any `<video>` tag rewritten to a link. Artifact
 * markdown drops `<video>`, so the uploads.sh URL has to be a link or the
 * clip disappears. `<img>` tags are left alone: camo fetches those URLs.
 */
export function issueArtifactMediaBody(commentBody: string): string {
  return commentBody.replace(/<video\b([^>]*)>[\s\S]*?<\/video>/gi, (full, attrs: string) => {
    const src = /src\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    if (!src) return full;
    return `[video](${src})`;
  });
}

function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const line = raw
    .split("\n")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .slice(0, 2)
    .join(" ");
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function parseArtifactPage(raw: string): ArtifactRow[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error("unexpected issue artifacts response");
  const rows: ArtifactRow[] = [];
  for (const row of parsed) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    if (typeof rec.number !== "number" || typeof rec.name !== "string") continue;
    rows.push({
      number: rec.number,
      name: rec.name,
      body: typeof rec.body === "string" ? rec.body : "",
    });
  }
  return rows;
}

/** Pages until a short page or both names are found. The list is oldest-first. */
function listArtifacts(target: GhTarget, run: CommandRunner, names: Set<string>): ArtifactRow[] {
  const out: ArtifactRow[] = [];
  const found = new Set<string>();
  for (let page = 1; page <= ARTIFACT_MAX_PAGES; page++) {
    const raw = run("gh", [
      "api",
      `repos/${target.repo}/issues/${target.num}/artifacts?per_page=${ARTIFACT_PAGE_SIZE}&page=${page}`,
    ]);
    const rows = parseArtifactPage(raw);
    out.push(...rows);
    for (const row of rows) if (names.has(row.name)) found.add(row.name);
    if (rows.length < ARTIFACT_PAGE_SIZE || found.size === names.size) break;
  }
  return out;
}

function findByName(rows: ArtifactRow[], name: string): ArtifactRow | undefined {
  return rows.find((row) => row.name === name);
}

/**
 * Create or PATCH one artifact. Same body skips the write so a rerun does
 * not spend a preview-API request on an unchanged document.
 */
function upsertArtifact(
  target: GhTarget,
  run: CommandRunner,
  existing: ArtifactRow | undefined,
  spec: { type: "generic" | "link"; name: string; body: string },
): "created" | "updated" | "unchanged" {
  const name = issueArtifactName(spec.name);
  if (name.length === 0 || /[()]/.test(name)) {
    throw new Error(`artifact name is not allowed: ${spec.name}`);
  }
  if (existing && existing.body === spec.body) return "unchanged";
  if (existing) {
    run(
      "gh",
      [
        "api",
        "-X",
        "PATCH",
        `repos/${target.repo}/issues/${target.num}/artifacts/${existing.number}`,
        "--input",
        "-",
      ],
      JSON.stringify({ body: spec.body }),
    );
    return "updated";
  }
  run(
    "gh",
    ["api", "-X", "POST", `repos/${target.repo}/issues/${target.num}/artifacts`, "--input", "-"],
    JSON.stringify({ type: spec.type, name, body: spec.body }),
  );
  return "created";
}

/**
 * Create or update the issue's uploads.sh artifacts. No-op for pull requests.
 * Never throws: GitHub errors come back on `warning`.
 */
export function syncIssueArtifacts(
  target: GhTarget,
  run: CommandRunner,
  input: IssueArtifactSyncInput,
): IssueArtifactSyncResult {
  if (target.kind !== "issues") return {};
  const commentBody = input.commentBody?.trim() ? issueArtifactMediaBody(input.commentBody) : "";
  const warnings: string[] = [];
  let galleryUrl = input.galleryUrl?.trim() ?? "";
  if (galleryUrl && !isHttpUrl(galleryUrl)) {
    warnings.push("issue gallery link was not updated: gallery URL is not http(s)");
    galleryUrl = "";
  }
  if (!commentBody && !galleryUrl) {
    return warnings.length > 0 ? { warning: warnings.join("; ") } : {};
  }

  const mediaName = issueArtifactName(ISSUE_MEDIA_ARTIFACT_NAME);
  const galleryName = issueArtifactName(ISSUE_GALLERY_ARTIFACT_NAME);
  let rows: ArtifactRow[];
  try {
    const wanted = new Set<string>();
    if (commentBody) wanted.add(mediaName);
    if (galleryUrl) wanted.add(galleryName);
    rows = listArtifacts(target, run, wanted);
  } catch (err) {
    return { warning: `issue artifact was not updated: ${errorMessage(err)}` };
  }

  const result: IssueArtifactSyncResult = {};
  if (commentBody) {
    try {
      const action = upsertArtifact(target, run, findByName(rows, mediaName), {
        type: "generic",
        name: mediaName,
        body: commentBody,
      });
      if (action !== "unchanged") result.media = action;
    } catch (err) {
      warnings.push(`issue artifact was not updated: ${errorMessage(err)}`);
    }
  }
  if (galleryUrl) {
    try {
      const action = upsertArtifact(target, run, findByName(rows, galleryName), {
        type: "link",
        name: galleryName,
        body: galleryUrl,
      });
      if (action !== "unchanged") result.gallery = action;
    } catch (err) {
      warnings.push(`issue gallery link was not updated: ${errorMessage(err)}`);
    }
  }
  if (warnings.length > 0) result.warning = warnings.join("; ");
  return result;
}
