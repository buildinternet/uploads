import { atom, read, update } from "claude-code";
import type { EngineInterface, Register } from "claude-code";

import type { Attached, Binding, Staged, StagedFile } from "../types";

const staged = atom({ plugin: "uploads", key: "staged" } as const, null);
const attached = atom({ plugin: "uploads", key: "attached" } as const, null);
const isExpanded = atom({ plugin: "uploads", key: "isExpanded" } as const, false);

// Bash commands that can change what is staged for the branch, or which branch it is.
const REFRESH_AFTER =
  /\buploads\s+(attach|put|screenshot|shot|delete)\b|\bgit\s+(checkout|switch|branch\s+-m)\b|\bgh\s+pr\s+create\b/;
const PR_CREATE = /\bgh\s+pr\s+create\b/;
const PR_URL = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g;
const IDLE_REFRESH_MS = 2 * 60 * 1000;
// Long enough for the GitHub App's webhook to promote the files after a PR opens.
const AFTER_PR_REFRESH_MS = 15_000;

const BAND_SUFFIX: Record<Binding, string> = {
  self: "attaches when the PR opens",
  none: "attaches when gh pr create runs here (or: uploads github link)",
  unknown: "link check failed; attaches when gh pr create runs here",
  other: "repo linked to another workspace, won't attach",
};

// The expanded band lists at most this many files.
const MAX_FILES = 8;

/** The uploads.sh file page (preview and details) for a storage URL; else the URL itself. */
const filePage = (url: string): string => {
  const match = /^https:\/\/storage\.uploads\.sh\/(.+)$/.exec(url);
  return match ? `https://uploads.sh/f/${match[1]}` : url;
};

const formatSize = (bytes: number | null): string =>
  bytes === null ? "" : bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;

const parseStaged = (stdout: string): Staged | null => {
  try {
    const doc = JSON.parse(stdout);
    if (
      typeof doc?.repo !== "string" ||
      typeof doc?.branch !== "string" ||
      !Array.isArray(doc?.files)
    ) {
      return null;
    }
    const state = doc.binding?.state;
    const files: StagedFile[] = doc.files
      .filter((f: { filename?: unknown; url?: unknown }) => typeof f?.filename === "string")
      .slice(0, MAX_FILES)
      .map((f: { filename: string; url?: unknown; size?: unknown }) => ({
        name: f.filename,
        url: typeof f.url === "string" ? filePage(f.url) : null,
        size: typeof f.size === "number" ? f.size : null,
      }));
    return {
      repo: doc.repo,
      branch: doc.branch,
      count: doc.files.length,
      files,
      binding: state in BAND_SUFFIX ? state : "unknown",
      autoAttach: doc.binding?.autoAttach === true,
    };
  } catch {
    return null;
  }
};

/** The last PR URL in `gh pr create` output, which prints it on success. */
const parsePrUrl = (text: string | undefined): { repo: string; pr: number } | null => {
  const matches = [...(text ?? "").matchAll(PR_URL)];
  const [, repo, pr] = matches.at(-1) ?? [];
  return repo && pr ? { repo, pr: Number(pr) } : null;
};

// The uploads.sh brand purple, from the favicon.
const BRAND = "#c27eff";

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const toBase64 = (bytes: Uint8Array): string => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += BASE64[(n >> 18) & 63]! + BASE64[(n >> 12) & 63]!;
    out += i + 1 < bytes.length ? BASE64[(n >> 6) & 63]! : "=";
    out += i + 2 < bytes.length ? BASE64[n & 63]! : "=";
  }
  return out;
};

// The favicon's mark: three stacked pixel chevrons fading downward, drawn as
// 16×16 RGBA from favicon.svg's 32-unit grid (one pixel per two units).
const MARK = (() => {
  const size = 16;
  const pixels = new Uint8Array(size * size * 4);
  const blocks = [
    [7, 2],
    [5, 3],
    [9, 3],
    [3, 4],
    [11, 4],
  ] as const;
  const rows = [
    [0, 255],
    [4, 140],
    [8, 71],
  ] as const;
  for (const [dy, alpha] of rows) {
    for (const [x, y] of blocks) {
      for (const [i, j] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ] as const) {
        pixels.set([0xc2, 0x7e, 0xff, alpha], ((y + dy + j) * size + x + i) * 4);
      }
    }
  }
  return { rgba: toBase64(pixels), width: size, height: size };
})();

const plural = (n: number) => (n === 1 ? "1 staged file" : `${n} staged files`);

/** The band's one line for the session branch, or null to show nothing. */
const bandLine = (view: Staged, done: Attached | null): string | null => {
  if (view.count > 0) {
    return `${plural(view.count)} on ${view.branch} · ${BAND_SUFFIX[view.binding]}`;
  }
  if (done?.branch !== view.branch || done.repo !== view.repo) {
    return null;
  }
  return done.via === "app"
    ? `${plural(done.count)} sent to PR #${done.pr} via the uploads-sh bot`
    : `${plural(done.count)} attached to PR #${done.pr}`;
};

let lastRefresh = 0;

// Runs a command; null when it can't start, times out, or exits non-zero.
async function run(
  $: EngineInterface,
  argv: readonly string[],
  timeoutMs: number,
): Promise<string | null> {
  try {
    const ran = await $.process.run(argv, { timeoutMs });
    return ran.exitCode === 0 ? ran.stdout : null;
  } catch {
    return null;
  }
}

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
  const stdout = await run($, argv, 15_000);
  return stdout === null ? null : parseStaged(stdout);
}

// Refreshes what the band shows: the session directory's branch.
async function refreshBand($: EngineInterface): Promise<void> {
  const view = await fetchStaged($, null);
  await update($, staged, () => view);
}

// Schedules a band refresh outside the current dispatch, so no tool result waits on it.
async function kick($: EngineInterface, ms = 0): Promise<void> {
  lastRefresh = await $.clock.now();
  $.clock.after(ms, () => void refreshBand($).catch(() => undefined));
}

// The PR's head branch. The Bash call may have run in another directory
// (a `cd`, or a subagent's worktree), so the session's branch can't stand in.
async function prHead($: EngineInterface, repo: string, pr: number): Promise<string | null> {
  const argv = [
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
  ];
  const head = (await run($, argv, 15_000))?.trim();
  return head ? head : null;
}

type Outcome = {
  toast: string;
  context?: string;
  record?: Omit<Attached, "pr" | "repo" | "branch">;
};

export const register: Register = (on, options) => {
  const autoPromote = options.autoPromote !== false;

  on("session.start", async ($, e, next) => {
    await kick($);
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    if ((await $.clock.now()) - lastRefresh > IDLE_REFRESH_MS) {
      await kick($);
    }
    return next(e);
  });

  on("tool.call", { tool: "Bash" }, async ($, e, next) => {
    const ran = await next(e);
    if (!REFRESH_AFTER.test(e.command)) {
      return ran;
    }
    if (!PR_CREATE.test(e.command) || ran.deny !== undefined || ran.isError === true) {
      await kick($);
      return ran;
    }

    const target = parsePrUrl(ran.text);
    await kick($, AFTER_PR_REFRESH_MS);
    if (!target) {
      return ran;
    }
    const head = await prHead($, target.repo, target.pr);
    if (!head) {
      return ran;
    }

    // What the band last saw for this branch, before the GitHub App could act.
    const before = await read($, staged);
    const prior = before?.repo === target.repo && before.branch === head ? before.count : 0;
    const view = await fetchStaged($, { branch: head, repo: target.repo });
    if (!view) {
      return ran;
    }

    const pr = `PR #${target.pr}`;
    const promoteArgv = [
      "uploads",
      "attach",
      "--promote",
      "--pr",
      String(target.pr),
      "--repo",
      target.repo,
      "--from-branch",
      head,
    ];
    const command = promoteArgv.join(" ");
    const files = plural(view.count);

    let outcome: Outcome | null = null;
    if (view.count === 0) {
      // The App's webhook already promoted them between the PR opening and this read.
      if (prior > 0 && view.autoAttach) {
        outcome = {
          toast: `uploads: ${plural(prior)} attached to ${pr} by the uploads-sh bot`,
          context: `uploads: the GitHub App attached the ${plural(prior)} for ${head} to ${pr}. Don't re-upload them.`,
          record: { count: prior, via: "app" },
        };
      }
    } else if (view.binding === "other") {
      outcome = {
        toast: `uploads: ${files} won't attach to ${pr}: this repo is linked to another workspace`,
      };
    } else if (view.autoAttach) {
      outcome = {
        toast: `uploads: ${files} will attach to ${pr} via the uploads-sh bot`,
        context: `uploads: the GitHub App attaches the ${files} for ${head} to ${pr}. Don't re-upload them.`,
        record: { count: view.count, via: "app" },
      };
    } else if (!autoPromote) {
      outcome = {
        toast: `uploads: ${files} waiting for ${pr}; run ${command}`,
        context: `uploads: ${files} for ${head} are staged but not attached to ${pr}. To attach them, run \`${command}\`.`,
      };
    } else if ((await run($, promoteArgv, 60_000)) === null) {
      outcome = {
        toast: `uploads: couldn't attach ${files} to ${pr}; run uploads attach --promote`,
        context: `uploads: ${files} for ${head} did not attach to ${pr}. Run \`${command}\`.`,
      };
    } else {
      outcome = {
        toast: `uploads: attached ${files} to ${pr}`,
        context: `uploads: attached ${files} for ${head} to ${pr}'s attachments comment. Don't re-upload them.`,
        record: { count: view.count, via: "cli" },
      };
      // Nothing is left staged for the head; the scheduled refresh confirms it.
      await update($, staged, (s) =>
        s?.repo === target.repo && s.branch === head ? { ...s, count: 0, files: [] } : s,
      );
    }
    if (outcome === null) {
      return ran;
    }

    $.ui.toast(outcome.toast);
    const { record } = outcome;
    if (record) {
      await update(
        $,
        attached,
        (): Attached => ({ ...record, repo: target.repo, branch: head, pr: target.pr }),
      );
    }
    return outcome.context ? { ...ran, context: [...(ran.context ?? []), outcome.context] } : ran;
  });

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const view = await read($, staged);
    if (e.props.hasSurvey || view === null) {
      return next(e);
    }
    const line = bandLine(view, await read($, attached));
    if (line === null) {
      return next(e);
    }

    const { Box, Button, Image, Link, Text } = $.ui.resolve(e);
    // State saved by an older version of this module has no `files`.
    const files = Array.isArray(view.files) ? view.files : [];
    const canExpand = files.length > 0;
    const expanded = canExpand && (await read($, isExpanded));
    // The header row takes one line, and a "+N more" row may take another.
    const shown = expanded ? files.slice(0, Math.max(1, e.props.maxRows - 2)) : [];
    const more = view.count - shown.length;

    // The engine's own `[-]` at the row's end collapses the band, so it needs no hide control.
    return (
      <Box flexDirection="column">
        <Box>
          {e.surface === "terminal" ? (
            <Image key="mark" source={MARK} columns={2} rows={1} alt="⇡" />
          ) : (
            <Text color={BRAND}>⇡</Text>
          )}
          <Text color={BRAND} bold>
            {" uploads "}
          </Text>
          {canExpand && (
            <Button
              key="files"
              plain
              label={expanded ? "▾" : "▸"}
              onPress={() => update($, isExpanded, (open) => !open)}
            />
          )}
          <Text dimColor> {line}</Text>
        </Box>
        {shown.map((file) => (
          <Box key={file.name}>
            <Text dimColor>{"  · "}</Text>
            {file.url ? <Link href={file.url} label={file.name} /> : <Text>{file.name}</Text>}
            <Text dimColor> {formatSize(file.size)}</Text>
          </Box>
        ))}
        {expanded && more > 0 && <Text dimColor>{`  + ${more} more (uploads staged)`}</Text>}
      </Box>
    );
  });
};
