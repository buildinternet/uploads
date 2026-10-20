/**
 * The `uploads.sh` check run on a pull request's head commit: one row in the
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
import type { GhTarget } from "./github-comment-render";

export const CHECK_NAME = "uploads.sh";

const DENIED_TTL = 3600;
/** Changed UI files the check's summary lists by name. */
const UI_FILES_LISTED = 10;

/** KV key remembering that `installationId` lacks `Checks: write`. */
export function checksDeniedKey(installationId: number | string): string {
  return `ghchecks:denied:${installationId}`;
}

export interface CheckRunContent {
  conclusion: "success" | "neutral";
  title: string;
  summary: string;
}

function files(n: number): string {
  return n === 1 ? "1 file" : `${n} files`;
}

/**
 * What the check says for a comment that carries `count` items (attachments,
 * galleries and held files), `heldCount` of them held, for a PR that changed
 * `uiFiles` (files counting as UI changes; only looked up when empty). Pure.
 */
export function checkRunContent(
  gathered: { count: number; heldCount: number; uiFiles?: readonly string[] },
  commentUrl: string | null,
): CheckRunContent {
  const { count, heldCount } = gathered;
  const uiFiles = gathered.uiFiles ?? [];
  const commentLink = commentUrl ? ` See the [uploads.sh comment](${commentUrl}).` : "";
  if (count === 0 && uiFiles.length > 0) {
    // Without a comment (built-in UI paths post none), link the how-to docs.
    const howTo =
      commentLink ||
      " See [how to attach screenshots](https://uploads.sh/docs/github-app#no-uploads).";
    const shown = uiFiles.slice(0, UI_FILES_LISTED).map((f) => `- \`${f}\``);
    if (uiFiles.length > UI_FILES_LISTED)
      shown.push(`- and ${uiFiles.length - UI_FILES_LISTED} more`);
    return {
      conclusion: "neutral",
      title: "UI files changed, no uploads attached",
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
      conclusion: "neutral",
      title: "No uploads on this PR",
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
 * Create or update the `uploads.sh` check run for `target` (pull requests
 * only) to match the comment just synced. `headSha` skips a PR lookup when
 * the caller already has it (the webhook payload carries it).
 */
export async function syncUploadsCheck(
  env: Env,
  cfg: GithubAppConfig,
  installationId: number,
  target: GhTarget,
  gathered: { count: number; heldCount: number; uiFiles?: readonly string[] },
  opts: { headSha?: string; commentUrl?: string | null; fetchImpl?: typeof fetch } = {},
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
      `${base}/commits/${sha}/check-runs?check_name=${encodeURIComponent(CHECK_NAME)}&app_id=${cfg.appId}&filter=latest`,
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
      check_runs?: { id?: unknown }[];
    } | null;
    const existingId = listed?.check_runs?.find((r) => typeof r.id === "number")?.id as
      | number
      | undefined;

    if (existingId === undefined && gathered.count === 0 && !gathered.uiFiles?.length) return;

    const content = checkRunContent(gathered, opts.commentUrl ?? null);
    const payload = {
      name: CHECK_NAME,
      head_sha: sha,
      status: "completed",
      conclusion: content.conclusion,
      completed_at: new Date().toISOString(),
      details_url: opts.commentUrl || `https://github.com/${target.repo}/pull/${target.num}`,
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
