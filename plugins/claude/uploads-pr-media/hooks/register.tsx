import { atom, read, update } from "claude-code";
import type { EngineInterface, Register } from "claude-code";

import type { Attached, Binding, Staged } from "../types";

const staged = atom({ plugin: "uploads-pr-media", key: "staged" } as const, null);
const attached = atom({ plugin: "uploads-pr-media", key: "attached" } as const, null);
const isHidden = atom({ plugin: "uploads-pr-media", key: "isHidden" } as const, false);

// Bash commands that can change what is staged for the branch, or which branch it is.
const REFRESH_AFTER =
  /\buploads\s+(attach|put|screenshot|shot|delete|staged)\b|\bgit\s+(checkout|switch|branch\s+-m)\b|\bgh\s+pr\s+create\b/;
const PR_CREATE = /\bgh\s+pr\s+create\b/;
const PR_URL = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g;
const IDLE_REFRESH_MS = 2 * 60 * 1000;
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

// Reads the branch's staged files through the CLI; a missing CLI, a
// directory outside a git repo, or a signed-out CLI all read as "nothing".
async function refresh($: EngineInterface): Promise<Staged | null> {
  lastRefresh = await $.clock.now();
  let view: Staged | null = null;
  try {
    const ran = await $.process.run(["uploads", "staged", "--format", "json"], {
      timeoutMs: 20_000,
    });
    view = ran.exitCode === 0 ? parseStaged(ran.stdout) : null;
  } catch {
    view = null;
  }
  await update($, staged, () => view);
  return view;
}

export const register: Register = (on) => {
  on("session.start", ($, e, next) => {
    void refresh($).catch(() => undefined);
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    if ((await $.clock.now()) - lastRefresh > IDLE_REFRESH_MS) {
      void refresh($).catch(() => undefined);
    }
    return next(e);
  });

  on("tool.call", { tool: "Bash" }, async ($, e, next) => {
    const ran = await next(e);
    if (!REFRESH_AFTER.test(e.command)) {
      return ran;
    }

    // Read before the refresh: the GitHub App may promote the files as soon as the PR opens.
    const before = await read($, staged);
    const after = await refresh($);

    if (!PR_CREATE.test(e.command) || ran.deny !== undefined || ran.isError === true) {
      return ran;
    }
    const target = parsePrUrl(ran.text);
    // A stale read from another branch says nothing about this one.
    const prior = before && (!after || before.branch === after.branch) ? before : null;
    const view = after ?? prior;
    if (!target || !view) {
      return ran;
    }
    const count = Math.max(prior?.count ?? 0, after?.count ?? 0);
    if (count === 0) {
      return ran;
    }

    const record = { repo: target.repo, branch: view.branch, pr: target.pr, count };

    if (view.binding === "other") {
      $.ui.toast(
        `uploads: ${plural(count)} won't attach to PR #${target.pr}: this repo is linked to another workspace`,
      );
      return ran;
    }

    if (view.autoAttach) {
      await update($, attached, (): Attached => ({ ...record, via: "app" }));
      $.ui.toast(
        `uploads: ${plural(count)} will attach to PR #${target.pr} via the uploads-sh bot`,
      );
      return {
        ...ran,
        context: [
          ...(ran.context ?? []),
          `uploads: the GitHub App attaches the ${plural(count)} for ${view.branch} to PR #${target.pr}. Don't re-upload them.`,
        ],
      };
    }

    let promoted = false;
    try {
      const run = await $.process.run(
        ["uploads", "attach", "--promote", "--pr", String(target.pr), "--repo", target.repo],
        { timeoutMs: 60_000 },
      );
      promoted = run.exitCode === 0;
    } catch {
      promoted = false;
    }

    if (!promoted) {
      $.ui.toast(
        `uploads: couldn't attach ${plural(count)} to PR #${target.pr}; run uploads attach --promote`,
      );
      return {
        ...ran,
        context: [
          ...(ran.context ?? []),
          `uploads: ${plural(count)} for ${view.branch} did not attach to PR #${target.pr}. Run \`uploads attach --promote --pr ${target.pr}\`.`,
        ],
      };
    }

    await update($, attached, (): Attached => ({ ...record, via: "cli" }));
    await refresh($);
    $.ui.toast(`uploads: attached ${plural(count)} to PR #${target.pr}`);
    return {
      ...ran,
      context: [
        ...(ran.context ?? []),
        `uploads: attached ${plural(count)} for ${view.branch} to PR #${target.pr}'s attachments comment. Don't re-upload them.`,
      ],
    };
  });

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden))) {
      return next(e);
    }
    const view = await read($, staged);
    const done = await read($, attached);
    const justAttached =
      done !== null && view !== null && done.branch === view.branch && done.repo === view.repo;

    let line: string | null = null;
    if (view && view.count > 0) {
      const where = `${plural(view.count)} on ${view.branch}`;
      line =
        view.binding === "other"
          ? `${where} · repo linked to another workspace, won't attach`
          : view.binding === "none"
            ? `${where} · attaches when gh pr create runs here (or: uploads github link)`
            : `${where} · attaches when the PR opens`;
    } else if (justAttached) {
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
        <Button key="hide" label="Hide" onPress={() => update($, isHidden, () => true)} />
      </Box>
    );
  });
};
