/**
 * `uploads hook pre-pr-screenshot` — agent PreToolUse / beforeShellExecution
 * handler. When the shell command is `gh pr create`, the branch touches UI
 * files, and nothing is staged on uploads.sh, emit a non-blocking advisory.
 *
 * Always fail-open. Disable with UPLOADS_HOOK_DISABLE=1.
 */

import { execFileSync } from "node:child_process";
import { createUploadsClient } from "../client.js";
import { resolveConfig } from "../config.js";
import { writeCommandHelp } from "../cli-style.js";

const HOOK_CMD = "pre-pr-screenshot";
const VISUAL_EXT = /\.(astro|tsx|jsx|vue|svelte|html|css|scss|less)$/i;
const EMAIL_PATH = /(?:^|\/)email\//i;
const FIND_TIMEOUT_MS = 5_000;

const HOOK_HELP = `uploads hook <name> — agent harness hook handlers (stdin JSON → stdout JSON)

Usage:
  uploads hook pre-pr-screenshot

Invoked by Claude Code / Codex / Grok / Cursor hooks. Never blocks.

  pre-pr-screenshot
    If the shell command is \`gh pr create\`, the branch touches UI files, and
    no screenshots are staged for the branch, emit an advisory to stage with
    \`uploads attach … --branch\`.

Disable with UPLOADS_HOOK_DISABLE=1.
`;

export type HookDeps = {
  stdin: string;
  testFiles?: string;
  cwd?: string;
  countStaged?: (branch: string) => Promise<number | null>;
  isFork?: () => boolean | null;
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

export function looksLikeGhPrCreate(command: string): boolean {
  return command.includes("gh pr create");
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
      client.findFiles({ "gh.branch": branch.toLowerCase() }, { limit: 1 }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("find timeout")), FIND_TIMEOUT_MS);
      }),
    ]);
    return Array.isArray(result.items) ? result.items.length : 0;
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

  const cwd = deps.cwd ?? process.cwd();
  const git = deps.git ?? defaultGit(cwd);
  if (!git.isRepo()) return null;

  const branch = git.branch();
  if (!branch) return null;

  const testFiles = deps.testFiles ?? process.env.UPLOADS_HOOK_TEST_FILES;
  const changed = testFiles ? testFiles.split("\n").filter(Boolean) : git.changedFiles();
  if (!anyVisual(changed)) return null;

  const staged = await (deps.countStaged ?? defaultCountStaged)(branch);
  // null = error/unconfigured → fail open; >0 = already staged
  if (staged === null || staged > 0) return null;

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
