import { atom, read, update } from "claude-code";
import type { EngineInterface, Register } from "claude-code";

import type { Attached, BandRow, Binding, FileRef, Staged } from "../types";

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

// What happens to the uploads once the branch's PR exists, by repo link.
const BAND_SUFFIX: Record<Binding, string> = {
  self: "attaches when it opens",
  none: "attaches when gh pr create runs here (or: uploads github link)",
  unknown: "couldn't check the repo link; attaches when gh pr create runs here",
  other: "won't attach: this repo is linked to another workspace",
};

// Before/after pairing, mirroring the attachments comment (comment-render's
// pairAttachments): images only; same `path` metadata with one `state=before`
// and one `state=after`, else filename stems that differ only by the token.
// The band shows each pair as one row, so a missing half shows as a gap.
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif)$/i;
const STEM_TOKEN = /(^|[-_.])(before|after)($|[-_.])/i;

type RawFile = { filename: string; state?: unknown; path?: unknown; url?: unknown; size?: unknown };
type Role = "before" | "after";

/** The uploads.sh file page (preview and details) for a storage URL; else the URL itself. */
const filePage = (url: string): string => {
  const match = /^https:\/\/storage\.uploads\.sh\/(.+)$/.exec(url);
  return match ? `https://uploads.sh/f/${match[1]}` : url;
};

const fileRef = (file: RawFile): FileRef => ({
  name: file.filename,
  url: typeof file.url === "string" ? filePage(file.url) : null,
  size: typeof file.size === "number" ? file.size : null,
});

/** A file's before/after role and the key its other half shares, or null for neither. */
const roleOf = (file: RawFile): { role: Role; key: string; label: string } | null => {
  if (!IMAGE_EXT.test(file.filename)) {
    return null;
  }
  const dot = file.filename.lastIndexOf(".");
  const stem = file.filename.slice(0, dot);
  const meta = typeof file.state === "string" ? file.state.trim().toLowerCase() : "";
  const path = typeof file.path === "string" ? file.path.trim() : "";
  const token = STEM_TOKEN.exec(stem);
  const role: Role | null =
    meta === "before" || meta === "after" ? meta : token ? (token[2]!.toLowerCase() as Role) : null;
  if (role === null) {
    return null;
  }
  // Only a file with nothing to pair on stands alone under its own name.
  const solo = { role, key: `solo:${file.filename}`, label: stem };
  if (path && path !== "/") {
    return meta === role ? { role, key: `path:${path}`, label: path } : solo;
  }
  if (!token) {
    return solo;
  }
  const end = token.index + token[1]!.length + token[2]!.length;
  const base =
    token[1]!.length > 0
      ? stem.slice(0, token.index) + stem.slice(end)
      : stem.slice(end + token[3]!.length);
  return {
    role,
    key: `stem:${base.toLowerCase()}${file.filename.slice(dot).toLowerCase()}`,
    label: base,
  };
};

/** The band's rows in staged order: a pair (either half may be missing), or a plain file. */
const toRows = (files: readonly RawFile[]): BandRow[] => {
  const order: (string | RawFile)[] = [];
  const groups = new Map<string, { label: string; before: RawFile[]; after: RawFile[] }>();
  for (const file of files) {
    const found = roleOf(file);
    if (found === null) {
      order.push(file);
      continue;
    }
    let group = groups.get(found.key);
    if (!group) {
      group = { label: found.label, before: [], after: [] };
      groups.set(found.key, group);
      order.push(found.key);
    }
    group[found.role].push(file);
  }
  return order.flatMap((entry): BandRow[] => {
    if (typeof entry !== "string") {
      return [{ kind: "file", file: fileRef(entry) }];
    }
    const { label, before, after } = groups.get(entry)!;
    // More than one of a side is ambiguous, as in the comment: no pairing, one row each.
    if (before.length > 1 || after.length > 1) {
      return [
        ...before.map((f): BandRow => ({ kind: "pair", label, before: fileRef(f), after: null })),
        ...after.map((f): BandRow => ({ kind: "pair", label, before: null, after: fileRef(f) })),
      ];
    }
    return [
      {
        kind: "pair",
        label,
        before: before[0] ? fileRef(before[0]) : null,
        after: after[0] ? fileRef(after[0]) : null,
      },
    ];
  });
};

/** How many staged files a row stands for. */
const filesIn = (row: BandRow): number =>
  row.kind === "file" ? 1 : (row.before ? 1 : 0) + (row.after ? 1 : 0);

// The expanded band lists at most this many rows.
const MAX_ROWS = 8;

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
    const files: RawFile[] = doc.files.filter(
      (f: { filename?: unknown }) => typeof f?.filename === "string",
    );
    return {
      repo: doc.repo,
      branch: doc.branch,
      count: doc.files.length,
      rows: toRows(files).slice(0, MAX_ROWS),
      binding: state in BAND_SUFFIX ? state : "unknown",
      autoAttach: doc.binding?.autoAttach === true,
    };
  } catch {
    return null;
  }
};

/**
 * What `uploads attach --promote --json` promoted and skipped, or null when it
 * printed nothing usable (the server call failed, or the output isn't JSON).
 */
const parsePromotion = (stdout: string | null): { promoted: number; skipped: number } | null => {
  try {
    const promotion = JSON.parse(stdout ?? "")?.promotion;
    if (!Array.isArray(promotion?.promoted) || !Array.isArray(promotion?.skipped)) {
      return null;
    }
    return { promoted: promotion.promoted.length, skipped: promotion.skipped.length };
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

// The uploads.sh accent (#c27eff) mixed half and half with the site's muted
// text (#b3b3ad): a faded purple that marks the row without shouting.
const BRAND = "#bb98d6";
// An unpaired before or after: a missing half the reader should notice.
const WARN = "#e5b567";

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
        pixels.set([0xbb, 0x98, 0xd6, alpha], ((y + dy + j) * size + x + i) * 4);
      }
    }
  }
  return { rgba: toBase64(pixels), width: size, height: size };
})();

const plural = (n: number) => (n === 1 ? "1 staged file" : `${n} staged files`);

/** The band's one line for the session branch, or null to show nothing. */
const bandLine = (view: Staged, done: Attached | null): string | null => {
  if (view.count > 0) {
    const uploads = view.count === 1 ? "1 upload" : `${view.count} uploads`;
    return `${uploads} waiting for a PR on ${view.branch} · ${BAND_SUFFIX[view.binding]}`;
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
    } else {
      // The command exits 0 even when the server call failed, so trust only
      // the `promotion` it reports: what moved, and what it skipped.
      const result = parsePromotion(await run($, [...promoteArgv, "--json"], 60_000));
      if (result === null || result.promoted === 0) {
        outcome = {
          toast: `uploads: couldn't attach ${files} to ${pr}; run uploads attach --promote`,
          context: `uploads: ${files} for ${head} did not attach to ${pr}. Run \`${command}\`.`,
        };
      } else if (result.skipped > 0) {
        const moved = plural(result.promoted);
        outcome = {
          toast: `uploads: attached ${moved} to ${pr}; ${result.skipped} skipped`,
          context: `uploads: attached ${moved} for ${head} to ${pr}; ${result.skipped} ${result.skipped === 1 ? "was" : "were"} skipped. Run \`${command}\` to retry them.`,
          record: { count: result.promoted, via: "cli" },
        };
      } else {
        outcome = {
          toast: `uploads: attached ${plural(result.promoted)} to ${pr}`,
          context: `uploads: attached ${plural(result.promoted)} for ${head} to ${pr}'s attachments comment. Don't re-upload them.`,
          record: { count: result.promoted, via: "cli" },
        };
        // Nothing is left staged for the head; the scheduled refresh confirms it.
        await update($, staged, (s) =>
          s?.repo === target.repo && s.branch === head ? { ...s, count: 0, rows: [] } : s,
        );
      }
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
    // State saved by an older version of this module has no `rows`.
    const rows = Array.isArray(view.rows) ? view.rows : [];
    const canExpand = rows.length > 0;
    const expanded = canExpand && (await read($, isExpanded));
    // The header row takes one line, and a "+N more" row may take another.
    const shown = expanded ? rows.slice(0, Math.max(1, e.props.maxRows - 2)) : [];
    const more = view.count - shown.reduce((sum, row) => sum + filesIn(row), 0);

    // A file as a link named by `label`, or plain text when the CLI gave no URL.
    const fileLink = (file: FileRef, label: string) =>
      file.url ? <Link href={file.url} label={label} /> : <Text>{label}</Text>;
    // One side of a pair: a link to that file, or an amber dash where it's missing.
    const half = (file: FileRef | null, role: "before" | "after") =>
      file ? fileLink(file, role) : <Text color={WARN}>—</Text>;

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
        {shown.map((row, i) =>
          row.kind === "file" ? (
            <Box key={`file-${i}`}>
              <Text dimColor>{"  · "}</Text>
              {fileLink(row.file, row.file.name)}
              <Text dimColor> {formatSize(row.file.size)}</Text>
            </Box>
          ) : (
            <Box key={`pair-${i}`}>
              <Text dimColor>{"  · "}</Text>
              <Text>{row.label} </Text>
              {half(row.before, "before")}
              <Text dimColor>{" → "}</Text>
              {half(row.after, "after")}
              {/* A lone half's size; a full pair needs none. */}
              {(row.before === null) !== (row.after === null) && (
                <Text dimColor> {formatSize((row.before ?? row.after)!.size)}</Text>
              )}
            </Box>
          ),
        )}
        {expanded && more > 0 && <Text dimColor>{`  + ${more} more (uploads staged)`}</Text>}
      </Box>
    );
  });
};
