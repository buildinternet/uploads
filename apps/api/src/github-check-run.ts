/**
 * The "Check for visuals" check run on a pull request's head commit: one row in the
 * PR's checks list saying what the managed comment holds — files attached,
 * files held for review, or nothing any more. It mirrors the comment and is
 * synced right after every comment upsert (webhook promote/reconcile and
 * `postManagedComment`, which hold approvals also go through), so the two
 * never disagree.
 *
 * Same create posture as the comment: a run is only created when the PR has
 * something to report (uploads, or UI files changed with none); an existing
 * run is patched to neutral when the PR empties, never created just to say
 * "empty".
 *
 * Needs the App's `Checks: write` permission. Installations that haven't
 * accepted it yet answer 403; that is remembered per installation for an
 * hour (cleared by the `installation` webhook, which fires when the new
 * permission is accepted) so a pending approval costs one call, not one per
 * sync. Never throws: a failed check must never fail the comment sync.
 */
import { githubFetch, githubHeaders, installationToken } from "./github-app";
import type { GithubAppConfig } from "./github-app";
import {
  aiNotesHeadline,
  aiNotesList,
  checklistLine,
  type AiNote,
  type GhTarget,
} from "./github-comment-render";
import type { Requirement } from "./github-check-requirements";
import { webOrigin } from "./web-url";

export const CHECK_NAME = "Check for visuals";
/** Names the check had before; a run still carrying one is renamed in place. */
const LEGACY_CHECK_NAMES: readonly string[] = ["uploads.sh"];

const DENIED_TTL = 3600;
/** Changed UI files the check's summary lists by name. */
const UI_FILES_LISTED = 10;

/** KV key remembering that `installationId` lacks `Checks: write`. */
export function checksDeniedKey(installationId: number | string): string {
  return `ghchecks:denied:${installationId}`;
}

export interface CheckRunContent {
  conclusion: "success" | "neutral" | "skipped" | "failure";
  title: string;
  summary: string;
}

function files(n: number): string {
  return n === 1 ? "1 file" : `${n} files`;
}

/** What `checkRunContent` reads off a comment sync. */
export interface CheckFacts {
  /** Items the comment carries (attachments, galleries and held files). */
  count: number;
  heldCount: number;
  /** The repo's `uiPaths` matches; only looked up when empty or required. */
  uiFiles?: readonly string[];
  /** The repo requires uploads (`check.require`): the check can fail. */
  required?: boolean;
  /** Where the PR stands on the requirements; absent unless required and UI files changed. */
  requirement?: Requirement | null;
  /** Images and videos attached on GitHub itself; counted only when `count` is 0. */
  githubAttachments?: number;
  /** The repo imports GitHub attachments, so the check needn't suggest it. */
  importsAttachments?: boolean;
  /** The repo's AI notes (`check.ai`). Advisory: they never change the conclusion. */
  aiNotes?: readonly AiNote[];
}

/** " · before and after, mobile": the met requirements beyond plain uploads, for a passing title. */
function metSuffix(checklist: readonly { label: string; met: boolean }[]): string {
  const met = checklist
    .filter((c) => c.met && c.label !== "Uploads")
    .map((c) => c.label.toLowerCase());
  return met.length ? ` · ${met.join(", ")}` : "";
}

/** The summary line for screenshots attached on GitHub, nudging toward import when it's off. */
function githubAttachmentsLine(n: number, imports: boolean): string {
  const line = `${files(n)} attached on GitHub.`;
  return imports
    ? line
    : `${line} Workspace admins can turn on importing GitHub attachments in Settings → GitHub ` +
        "to keep a copy on uploads.sh.";
}

/**
 * What the check says for a comment that carries `count` items (attachments,
 * galleries and held files), `heldCount` of them held, for a PR that changed
 * `uiFiles`. Fails only when the repo requires uploads, UI files changed,
 * nothing excuses the PR, and a requirement is unmet. AI notes go under the
 * summary, and a warning is named in the title, but never change the
 * conclusion. Pure.
 */
export function checkRunContent(gathered: CheckFacts, commentUrl: string | null): CheckRunContent {
  const content = factsContent(gathered, commentUrl);
  const notes = gathered.aiNotes ?? [];
  if (notes.length === 0) return content;
  const headline = aiNotesHeadline(notes);
  const warns = notes.some((note) => note.outcome === "warning");
  return {
    conclusion: content.conclusion,
    title: warns ? `${content.title} · AI notes: ${headline}` : content.title,
    summary:
      `${content.summary}\n\n### AI notes · ${headline}\n\n${aiNotesList(notes)}\n\n` +
      "_AI notes are a second look from image labels. They never fail this check._",
  };
}

function factsContent(gathered: CheckFacts, commentUrl: string | null): CheckRunContent {
  const { count, heldCount } = gathered;
  const uiFiles = gathered.uiFiles ?? [];
  const onGithub = count === 0 ? (gathered.githubAttachments ?? 0) : 0;
  const onGithubLine = onGithub
    ? githubAttachmentsLine(onGithub, gathered.importsAttachments ?? false)
    : "";
  const commentLink = commentUrl ? ` See the [uploads.sh comment](${commentUrl}).` : "";
  const requirement = gathered.requirement;
  // Skipped, not neutral: GitHub folds these into "skipped checks", and a
  // required check still passes.
  if (requirement?.skipLabel) {
    return {
      conclusion: "skipped",
      title: `Skipped by the ${requirement.skipLabel} label`,
      summary: `The \`${requirement.skipLabel}\` label excuses this pull request.`,
    };
  }
  // A held file counts as attached, and a hold never blocks a merge.
  if (requirement && heldCount === 0) {
    const line = checklistLine(requirement.checklist);
    const missing = requirement.checklist.filter((c) => !c.met);
    if (missing.length > 0) {
      const skip = requirement.skipHint
        ? ` If this pull request needs none, add the \`${requirement.skipHint}\` label.`
        : "";
      return {
        conclusion: "failure",
        title:
          count === 0 && onGithub === 0
            ? "UI changed, no visuals attached"
            : `Missing: ${missing.map((c) => c.label.toLowerCase()).join(", ")}`,
        summary:
          (onGithubLine ? `${onGithubLine}\n\n` : "") +
          "This repo requires uploads on pull requests that change UI files. Add them with " +
          "`uploads put`." +
          skip +
          commentLink +
          "\n\n" +
          line,
      };
    }
    if (onGithub > 0) {
      return {
        conclusion: "success",
        title: `${files(onGithub)} attached on GitHub`,
        summary: `${onGithubLine}\n\n${line}`,
      };
    }
    return {
      conclusion: "success",
      title: `${files(count)} attached${metSuffix(requirement.checklist)}`,
      summary: `Screenshots and recordings for this pull request are published.${commentLink}\n\n${line}`,
    };
  }
  if (gathered.required && count === 0 && uiFiles.length === 0) {
    return {
      conclusion: "skipped",
      title: "No UI changes",
      summary:
        "This pull request changes no files that count as UI changes, so no uploads are required.",
    };
  }
  if (onGithub > 0 && uiFiles.length > 0) {
    return {
      conclusion: "success",
      title: `${files(onGithub)} attached on GitHub`,
      summary: onGithubLine,
    };
  }
  if (count === 0 && uiFiles.length > 0) {
    // Without a comment (the how-to is turned off), link the how-to docs.
    const howTo =
      commentLink ||
      " See [how to attach screenshots](https://uploads.sh/docs/require-screenshots).";
    const shown = uiFiles.slice(0, UI_FILES_LISTED).map((f) => `- \`${f}\``);
    if (uiFiles.length > UI_FILES_LISTED)
      shown.push(`- and ${uiFiles.length - UI_FILES_LISTED} more`);
    return {
      conclusion: "neutral",
      title: "UI changed, no visuals attached",
      summary:
        "This pull request changes files that count as UI changes, and nothing is " +
        "attached yet. Add screenshots with `uploads put`." +
        howTo +
        "\n\n" +
        shown.join("\n"),
    };
  }
  if (count === 0) {
    return {
      conclusion: "skipped",
      title: "Nothing attached",
      summary: "Nothing is attached to this pull request any more.",
    };
  }
  // Neutral, not action_required: a hold is about the uploaded file, not the
  // PR's code, so it should never be able to block a merge.
  if (heldCount > 0) {
    return {
      conclusion: "neutral",
      title: `${heldCount} of ${files(count)} held for review`,
      summary:
        "Held files stay private until someone in the workspace approves them on the " +
        "file page or with `uploads approve`." +
        commentLink,
    };
  }
  return {
    conclusion: "success",
    title: `${files(count)} attached`,
    summary: `Screenshots and recordings for this pull request are published.${commentLink}`,
  };
}

/**
 * Where "View more details on Uploads.sh" goes: the workspace's files page
 * for the PR, else the comment, else the PR itself.
 */
function detailsUrl(
  env: Env,
  target: GhTarget,
  opts: { commentUrl?: string | null; workspaceName?: string },
): string {
  if (opts.workspaceName) {
    const [owner, repo] = target.repo.split("/").map(encodeURIComponent);
    return `${webOrigin(env)}/account/workspaces/${encodeURIComponent(opts.workspaceName)}/files/${owner}/${repo}/pull/${target.num}`;
  }
  return opts.commentUrl || `https://github.com/${target.repo}/pull/${target.num}`;
}

/** The PR's current head commit, uncached (it moves on every push). */
async function prHeadSha(
  fetchImpl: typeof fetch,
  token: string,
  repo: string,
  num: number,
): Promise<string | null> {
  const res = await githubFetch(fetchImpl, `https://api.github.com/repos/${repo}/pulls/${num}`, {
    headers: githubHeaders(token),
  });
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { head?: { sha?: unknown } } | null;
  return typeof body?.head?.sha === "string" ? body.head.sha : null;
}

/**
 * Create or update the "Check for visuals" check run for `target` (pull requests
 * only) to match the comment just synced. `headSha` skips a PR lookup when
 * the caller already has it (the webhook payload carries it).
 */
export async function syncUploadsCheck(
  env: Env,
  cfg: GithubAppConfig,
  installationId: number,
  target: GhTarget,
  gathered: CheckFacts,
  opts: {
    headSha?: string;
    commentUrl?: string | null;
    /** The bound workspace, whose files page for the PR is the run's details link. */
    workspaceName?: string;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<void> {
  if (target.kind !== "pull") return;
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    if ((await env.GITHUB_CACHE.get(checksDeniedKey(installationId))) !== null) return;

    const token = await installationToken(env, cfg, installationId, fetchImpl);
    if (!token) return;
    const sha = opts.headSha ?? (await prHeadSha(fetchImpl, token, target.repo, target.num));
    if (!sha) return;
    const base = `https://api.github.com/repos/${target.repo}`;
    const list = await githubFetch(
      fetchImpl,
      `${base}/commits/${sha}/check-runs?app_id=${cfg.appId}&filter=latest&per_page=100`,
      { headers: githubHeaders(token) },
    );
    if (list.status === 403) {
      await env.GITHUB_CACHE.put(checksDeniedKey(installationId), "1", {
        expirationTtl: DENIED_TTL,
      });
      return;
    }
    if (!list.ok) throw new Error(`check run lookup failed: ${list.status}`);
    const listed = (await list.json().catch(() => null)) as {
      check_runs?: { id?: unknown; name?: unknown }[];
    } | null;
    const ours = (r: { name?: unknown }) =>
      r.name === CHECK_NAME || LEGACY_CHECK_NAMES.includes(r.name as string);
    const existingId = listed?.check_runs?.find((r) => typeof r.id === "number" && ours(r))?.id as
      | number
      | undefined;

    // A repo that requires uploads gets a run on every PR: a required check
    // that never reports blocks the merge.
    if (
      existingId === undefined &&
      gathered.count === 0 &&
      !gathered.uiFiles?.length &&
      !gathered.required
    )
      return;

    const content = checkRunContent(gathered, opts.commentUrl ?? null);
    const payload = {
      name: CHECK_NAME,
      head_sha: sha,
      status: "completed",
      conclusion: content.conclusion,
      completed_at: new Date().toISOString(),
      details_url: detailsUrl(env, target, opts),
      output: { title: content.title, summary: content.summary },
    };
    const res = await githubFetch(
      fetchImpl,
      existingId === undefined ? `${base}/check-runs` : `${base}/check-runs/${existingId}`,
      {
        method: existingId === undefined ? "POST" : "PATCH",
        headers: { ...githubHeaders(token), "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    if (res.status === 403) {
      await env.GITHUB_CACHE.put(checksDeniedKey(installationId), "1", {
        expirationTtl: DENIED_TTL,
      });
      return;
    }
    if (!res.ok) throw new Error(`check run write failed: ${res.status}`);
  } catch (err) {
    console.error(
      JSON.stringify({
        message: "uploads check run sync failed",
        repo: target.repo,
        num: target.num,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}
