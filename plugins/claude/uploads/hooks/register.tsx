import { atom, read, update } from "claude-code";
import type { EngineInterface, Register } from "claude-code";

import type { Attached, Binding, Staged } from "../types";

const staged = atom({ plugin: "uploads", key: "staged" } as const, null);
const attached = atom({ plugin: "uploads", key: "attached" } as const, null);
const hiddenBranch = atom({ plugin: "uploads", key: "hiddenBranch" } as const, null);

// Bash commands that can change what is staged for the branch, or which branch it is.
const REFRESH_AFTER =
  /\buploads\s+(attach|put|screenshot|shot|delete|staged)\b|\bgit\s+(checkout|switch|branch\s+-m)\b|\bgh\s+pr\s+create\b/;
const PR_CREATE = /\bgh\s+pr\s+create\b/;
const PR_URL = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g;
const IDLE_REFRESH_MS = 2 * 60 * 1000;
// Long enough for the GitHub App's webhook to promote the files after a PR opens.
const AFTER_PR_REFRESH_MS = 15_000;
const BINDINGS: readonly Binding[] = ["self", "none", "other", "unknown"];

export const parseStaged = (stdout: string): Staged | null => {
  try {
    const doc = JSON.parse(stdout);
    if (
      typeof doc?.repo !== "string" ||
      typeof doc?.branch !== "string" ||
      !Array.isArray(doc?.files)
    ) {
      return null;
    }
    const binding: Binding = BINDINGS.includes(doc.binding?.state) ? doc.binding.state : "unknown";
    return {
      repo: doc.repo,
      branch: doc.branch,
      count: doc.files.length,
      binding,
      autoAttach: doc.binding?.autoAttach === true,
    };
  } catch {
    return null;
  }
};

/** The last PR URL in `gh pr create` output, which prints it on success. */
export const parsePrUrl = (text: string | undefined): { repo: string; pr: number } | null => {
  const matches = [...(text ?? "").matchAll(PR_URL)];
  const [, repo, pr] = matches.at(-1) ?? [];
  return repo && pr ? { repo, pr: Number(pr) } : null;
};

const plural = (n: number) => (n === 1 ? "1 staged file" : `${n} staged files`);

let lastRefresh = 0;

// Reads staged files through the CLI; a missing CLI, a directory outside a
// git repo, or a signed-out CLI all read as null. With no `scope` the CLI
// resolves the session directory's branch and repo.
async function fetchStaged(
  $: EngineInterface,
  scope: { branch: string; repo: string } | null,
): Promise<Staged | null> {
  const argv = ["uploads", "staged", "--format", "json"];
  if (scope) {
    argv.push("--branch", scope.branch, "--repo", scope.repo);
  }
  try {
    const ran = await $.process.run(argv, { timeoutMs: 15_000 });
    return ran.exitCode === 0 ? parseStaged(ran.stdout) : null;
  } catch {
    return null;
  }
}

// Refreshes what the band shows: the session directory's branch.
async function refreshBand($: EngineInterface): Promise<void> {
  lastRefresh = await $.clock.now();
  const view = await fetchStaged($, null);
  await update($, staged, () => view);
}

// The PR's head branch. The Bash call may have run in another directory
// (a `cd`, or a subagent's worktree), so the session's branch can't stand in.
async function prHead($: EngineInterface, repo: string, pr: number): Promise<string | null> {
  try {
    const ran = await $.process.run(
      [
        "gh",
        "pr",
        "view",
        String(pr),
        "--repo",
        repo,
        "--json",
        "headRefName",
        "-q",
        ".headRefName",
      ],
      { timeoutMs: 15_000 },
    );
    const head = ran.stdout.trim();
    return ran.exitCode === 0 && head !== "" ? head : null;
  } catch {
    return null;
  }
}

async function promote(
  $: EngineInterface,
  repo: string,
  pr: number,
  head: string,
): Promise<boolean> {
  try {
    const ran = await $.process.run(
      ["uploads", "attach", "--promote", "--pr", String(pr), "--repo", repo, "--from-branch", head],
      { timeoutMs: 60_000 },
    );
    return ran.exitCode === 0;
  } catch {
    return false;
  }
}

export const register: Register = (on, options) => {
  const autoPromote = options.autoPromote !== false;

  on("session.start", ($, e, next) => {
    $.clock.after(0, () => void refreshBand($).catch(() => undefined));
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    if ((await $.clock.now()) - lastRefresh > IDLE_REFRESH_MS) {
      $.clock.after(0, () => void refreshBand($).catch(() => undefined));
    }
    return next(e);
  });

  on("tool.call", { tool: "Bash" }, async ($, e, next) => {
    const ran = await next(e);
    if (!REFRESH_AFTER.test(e.command)) {
      return ran;
    }
    if (!PR_CREATE.test(e.command) || ran.deny !== undefined || ran.isError === true) {
      await refreshBand($);
      return ran;
    }

    const target = parsePrUrl(ran.text);
    $.clock.after(AFTER_PR_REFRESH_MS, () => void refreshBand($).catch(() => undefined));
    if (!target) {
      return ran;
    }
    const head = await prHead($, target.repo, target.pr);
    if (!head) {
      return ran;
    }

    // What the band last saw for this branch, before the GitHub App could act.
    const before = await read($, staged);
    const prior =
      before && before.repo === target.repo && before.branch === head ? before.count : 0;
    const view = await fetchStaged($, { branch: head, repo: target.repo });
    if (!view) {
      return ran;
    }

    const record = { repo: target.repo, branch: head, pr: target.pr };
    const withContext = (line: string) => ({ ...ran, context: [...(ran.context ?? []), line] });

    if (view.count === 0) {
      // The App's webhook already promoted them between the PR opening and this read.
      if (prior > 0 && view.autoAttach) {
        await update($, attached, (): Attached => ({ ...record, count: prior, via: "app" }));
        $.ui.toast(`uploads: ${plural(prior)} attached to PR #${target.pr} by the uploads-sh bot`);
        return withContext(
          `uploads: the GitHub App attached the ${plural(prior)} for ${head} to PR #${target.pr}. Don't re-upload them.`,
        );
      }
      return ran;
    }

    if (view.binding === "other") {
      $.ui.toast(
        `uploads: ${plural(view.count)} won't attach to PR #${target.pr}: this repo is linked to another workspace`,
      );
      return ran;
    }

    if (view.autoAttach) {
      await update($, attached, (): Attached => ({ ...record, count: view.count, via: "app" }));
      $.ui.toast(
        `uploads: ${plural(view.count)} will attach to PR #${target.pr} via the uploads-sh bot`,
      );
      return withContext(
        `uploads: the GitHub App attaches the ${plural(view.count)} for ${head} to PR #${target.pr}. Don't re-upload them.`,
      );
    }

    const command = `uploads attach --promote --pr ${target.pr} --repo ${target.repo} --from-branch ${head}`;
    if (!autoPromote) {
      $.ui.toast(`uploads: ${plural(view.count)} waiting for PR #${target.pr}; run ${command}`);
      return withContext(
        `uploads: ${plural(view.count)} for ${head} are staged but not attached to PR #${target.pr}. To attach them, run \`${command}\`.`,
      );
    }

    if (!(await promote($, target.repo, target.pr, head))) {
      $.ui.toast(
        `uploads: couldn't attach ${plural(view.count)} to PR #${target.pr}; run uploads attach --promote`,
      );
      return withContext(
        `uploads: ${plural(view.count)} for ${head} did not attach to PR #${target.pr}. Run \`${command}\`.`,
      );
    }

    await update($, attached, (): Attached => ({ ...record, count: view.count, via: "cli" }));
    await refreshBand($);
    $.ui.toast(`uploads: attached ${plural(view.count)} to PR #${target.pr}`);
    return withContext(
      `uploads: attached ${plural(view.count)} for ${head} to PR #${target.pr}'s attachments comment. Don't re-upload them.`,
    );
  });

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const view = await read($, staged);
    if (e.props.hasSurvey || view === null || (await read($, hiddenBranch)) === view.branch) {
      return next(e);
    }
    const done = await read($, attached);
    const isAttachedHere = done !== null && done.branch === view.branch && done.repo === view.repo;

    let line: string | null = null;
    if (view.count > 0) {
      const where = `${plural(view.count)} on ${view.branch}`;
      line =
        view.binding === "other"
          ? `${where} · repo linked to another workspace, won't attach`
          : view.binding === "none"
            ? `${where} · attaches when gh pr create runs here (or: uploads github link)`
            : view.binding === "unknown"
              ? `${where} · link check failed; attaches when gh pr create runs here`
              : `${where} · attaches when the PR opens`;
    } else if (isAttachedHere) {
      line =
        done.via === "app"
          ? `${plural(done.count)} sent to PR #${done.pr} via the uploads-sh bot`
          : `${plural(done.count)} attached to PR #${done.pr}`;
    }
    if (line === null) {
      return next(e);
    }

    const { Box, Button, Text } = $.ui.resolve(e);
    return (
      <Box>
        <Text dimColor>uploads · {line} </Text>
        <Button
          key="hide"
          label="Hide"
          onPress={() => update($, hiddenBranch, () => view.branch)}
        />
      </Box>
    );
  });
};
