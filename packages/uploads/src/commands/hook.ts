/**
 * `uploads hook pre-pr-screenshot` — agent PreToolUse / beforeShellExecution
 * handler, triggered on `gh pr create`. Two advisories, mutually exclusive:
 *  - staged-but-unattached files exist for the branch (any reason they got
 *    there) → a promote suggestion (issue #700): `uploads attach --promote`
 *    once the PR this command is about to open exists.
 *  - nothing is staged, but the branch touches UI files → the original
 *    (issue #379) "consider staging screenshots" advisory.
 *
 * Always fail-open. Disable with UPLOADS_HOOK_DISABLE=1.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createUploadsClient } from "../client.js";
import { resolveConfig } from "../config.js";
import { writeCommandHelp } from "../cli-style.js";
import { resolveRepo } from "../github-gh.js";
import { resolveStagedBinding, type StagedBinding } from "../commands.js";

const HOOK_CMD = "pre-pr-screenshot";
const VISUAL_EXT = /\.(astro|tsx|jsx|vue|svelte|html|css|scss|less)$/i;
const EMAIL_PATH = /(?:^|\/)email\//i;
const FIND_TIMEOUT_MS = 5_000;

const HOOK_HELP = `uploads hook <name> — agent harness hook handlers (stdin JSON → stdout JSON)

Usage:
  uploads hook pre-pr-screenshot

Invoked by Claude Code / Codex / Grok / Cursor hooks. Never blocks.
Harness manifests no-op (exit 0, no output) when this binary is not on PATH.

  pre-pr-screenshot
    If the shell command is \`gh pr create\`:
      - staged-but-unattached files exist for the branch → suggest promoting
        them into the PR's managed comment once it exists (issue #700):
        \`uploads attach --promote --pr <num>\`.
      - otherwise, if the branch touches UI files → suggest staging with
        \`uploads attach … --branch\`.

Disable with UPLOADS_HOOK_DISABLE=1.
`;

export type HookDeps = {
  stdin: string;
  testFiles?: string;
  cwd?: string;
  countStaged?: (branch: string) => Promise<number | null>;
  isFork?: () => boolean | null;
  /** Repo binding for the cwd's repo; null/throw → unknown (keeps the promote advice). */
  binding?: () => Promise<StagedBinding | null>;
  git?: {
    isRepo: () => boolean;
    branch: () => string | null;
    changedFiles: () => string[];
  };
};

/** Claude/Codex: tool_input.command · Grok: toolInput.command · Cursor: command */
export function shellCommandFromHookInput(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "";
  const o = raw as Record<string, unknown>;
  const toolInput = (o.tool_input ?? o.toolInput) as Record<string, unknown> | undefined;
  if (toolInput && typeof toolInput.command === "string") return toolInput.command;
  if (typeof o.command === "string") return o.command;
  return "";
}

export function isCursorHookInput(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const o = raw as Record<string, unknown>;
  return "conversation_id" in o || "workspace_roots" in o || "cursor_version" in o;
}

/**
 * Working directory the harness says the command runs in. Claude/Codex/Grok
 * send a top-level `cwd`; Cursor sends `workspace_roots`. The hook process's
 * own cwd can be a different checkout (Claude desktop worktree sessions run
 * hooks from the main checkout), so this wins over `process.cwd()`.
 */
export function cwdFromHookInput(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.cwd === "string" && o.cwd) return o.cwd;
  const roots = o.workspace_roots;
  if (Array.isArray(roots) && typeof roots[0] === "string" && roots[0]) return roots[0];
  return null;
}

/** Directory of a leading `cd <dir> &&` (or `;`) in the command, resolved against `base`. */
export function leadingCdDir(command: string, base: string): string | null {
  const m = command.match(/^\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*(?:&&|;)/);
  if (!m) return null;
  const dir = resolve(base, m[1].replace(/^["']|["']$/g, ""));
  return existsSync(dir) ? dir : null;
}

/**
 * True when the command actually invokes `gh pr create`: at the start of the
 * command or after a shell separator (`;` `&&` `||` `|` `(` newline), allowing
 * leading `VAR=value` assignments and extra whitespace. Pragmatic, not a shell
 * parser: quoted substrings are blanked first, so `grep "gh pr create" f` and
 * `echo 'gh pr create'` don't match, and a program argument such as
 * `rg gh pr create` doesn't either because the match must sit in command position.
 */
export function looksLikeGhPrCreate(command: string): boolean {
  const unquoted = command.replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, '""');
  return /(?:^|[;&|(\n])\s*(?:\w+=\S*\s+)*gh\s+pr\s+create(?![\w-])/.test(unquoted);
}

export function isVisualPath(filePath: string): boolean {
  return VISUAL_EXT.test(filePath) || EMAIL_PATH.test(filePath);
}

export function anyVisual(files: string[]): boolean {
  return files.some(isVisualPath);
}

export function formatAdvisory(message: string, cursor: boolean): string {
  if (cursor) {
    return JSON.stringify({ additional_context: message, agentMessage: message });
  }
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: message,
    },
    systemMessage: message,
  });
}

function runGit(args: string[], cwd: string, timeoutMs = 5_000): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function defaultGit(cwd: string): NonNullable<HookDeps["git"]> {
  return {
    isRepo: () => runGit(["rev-parse", "--is-inside-work-tree"], cwd) === "true",
    branch: () => {
      const b = runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
      return !b || b === "HEAD" ? null : b;
    },
    changedFiles: () => {
      const defaultBranch =
        runGit(["remote", "show", "origin"], cwd, 8_000)
          .split("\n")
          .map((l) => l.match(/HEAD branch:\s*(.+)/)?.[1]?.trim())
          .find(Boolean) || "main";
      const mergeBase =
        runGit(["merge-base", `origin/${defaultBranch}`, "HEAD"], cwd) ||
        runGit(["merge-base", defaultBranch, "HEAD"], cwd);
      const diff = mergeBase
        ? runGit(["diff", "--name-only", mergeBase, "HEAD"], cwd)
        : runGit(["diff", "--name-only", "HEAD"], cwd);
      return diff ? diff.split("\n").filter(Boolean) : [];
    },
  };
}

async function defaultCountStaged(branch: string): Promise<number | null> {
  try {
    const config = resolveConfig({ requireToken: false });
    if (!config.token) return null;
    const client = createUploadsClient(config);
    const result = await Promise.race([
      // Only still-staged files: promoted ones keep gh.branch but flip status.
      client.findFiles({ "gh.branch": branch.toLowerCase(), "gh.status": "staged" }, { limit: 1 }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("find timeout")), FIND_TIMEOUT_MS);
      }),
    ]);
    return Array.isArray(result.items) ? result.items.length : 0;
  } catch {
    return null;
  }
}

async function defaultBinding(): Promise<StagedBinding | null> {
  try {
    const config = resolveConfig({ requireToken: false });
    if (!config.token) return null;
    const client = createUploadsClient(config);
    return await Promise.race([
      resolveStagedBinding(client, resolveRepo(undefined)),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("binding timeout")), FIND_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return null;
  }
}

function defaultIsFork(cwd: string): boolean | null {
  try {
    const out = execFileSync("gh", ["repo", "view", "--json", "isFork", "-q", ".isFork"], {
      cwd,
      encoding: "utf8",
      timeout: 3_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (out === "true") return true;
    if (out === "false") return false;
    return null;
  } catch {
    return null;
  }
}

/** Returns advisory JSON, or null when silent. Never throws for product paths. */
export async function runPrePrScreenshot(deps: HookDeps): Promise<string | null> {
  if (process.env.UPLOADS_HOOK_DISABLE === "1") return null;

  let raw: unknown;
  try {
    raw = deps.stdin.trim() ? JSON.parse(deps.stdin) : null;
  } catch {
    return null;
  }

  const command = shellCommandFromHookInput(raw);
  if (!command || !looksLikeGhPrCreate(command)) return null;

  const baseCwd = cwdFromHookInput(raw) ?? deps.cwd ?? process.cwd();
  const cwd = leadingCdDir(command, baseCwd) ?? baseCwd;
  const git = deps.git ?? defaultGit(cwd);
  if (!git.isRepo()) return null;

  const branch = git.branch();
  if (!branch) return null;

  const staged = await (deps.countStaged ?? defaultCountStaged)(branch);
  if (staged === null) return null; // error/unconfigured → fail open

  // Promote suggestion (issue #700): staged-but-unattached files already
  // exist for this branch right as its PR is about to open. The PR doesn't
  // exist yet at this PreToolUse point, so its number isn't knowable here —
  // the wording still gives the exact command shape, and a bare
  // `attach --promote` (which infers the PR from the branch) works too.
  if (staged > 0) {
    const fork = (deps.isFork ?? (() => defaultIsFork(cwd)))();
    const forkNote =
      fork === true
        ? " Note: this looks like a fork branch, so staged screenshots won't auto-promote into the PR comment yet (see issue #317) — attach them manually if you use uploads."
        : "";
    const noun = `${staged} file${staged === 1 ? "" : "s"} staged for branch '${branch}' on uploads.sh`;
    const binding = await (deps.binding ?? defaultBinding)().catch(() => null);
    // Reuse the `uploads staged` binding wording. With a self binding the
    // GitHub App promotes automatically, so the manual promote advice is wrong.
    const message =
      binding?.state === "self"
        ? `${noun}: ${binding.message}.`
        : binding?.state === "other"
          ? `Branch '${branch}': ${binding.message}`
          : `${noun} ${staged === 1 ? "isn't" : "aren't"} attached to a pull request yet. Once this PR opens, run ` +
            "`uploads attach --promote --pr <num>` (or a bare `uploads attach --promote`, which infers " +
            `the PR from the branch) to collect ${staged === 1 ? "it" : "them"} into the managed attachments comment.${forkNote}`;
    return formatAdvisory(message, isCursorHookInput(raw));
  }

  const testFiles = deps.testFiles ?? process.env.UPLOADS_HOOK_TEST_FILES;
  const changed = testFiles ? testFiles.split("\n").filter(Boolean) : git.changedFiles();
  if (!anyVisual(changed)) return null;

  const fork = (deps.isFork ?? (() => defaultIsFork(cwd)))();
  const forkNote =
    fork === true
      ? " Note: this looks like a fork branch, so staged screenshots won't auto-promote into the PR comment yet (see issue #317) — attach them manually if you use uploads."
      : "";
  const message =
    `This PR touches UI files (astro/tsx/jsx/vue/svelte/html/css/scss/less or an /email/ path) but no screenshots are staged for branch '${branch}' on uploads.sh. ` +
    `Consider running \`uploads attach <shot.png> --branch --state after\` (and a --state before if useful) before or after opening the PR — the managed attachments comment assembles from staged files automatically.${forkNote}`;

  return formatAdvisory(message, isCursorHookInput(raw));
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function runHook(args: string[], help = false): Promise<number> {
  const name = args[0];
  if (help || !name || name === "--help" || name === "-h") {
    writeCommandHelp(HOOK_HELP);
    return 0;
  }

  if (name !== HOOK_CMD) {
    process.stderr.write(`unknown hook: ${name} (expected ${HOOK_CMD})\n`);
    return 2;
  }

  try {
    const out = await runPrePrScreenshot({ stdin: await readStdin() });
    if (out) process.stdout.write(out);
  } catch {
    // fail-open
  }
  return 0;
}
