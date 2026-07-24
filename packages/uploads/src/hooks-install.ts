/**
 * Install thin user-global hook manifests for Grok and Cursor.
 *
 * Claude and Codex ship the same PreToolUse hook via their plugins
 * (`hooks/hooks.json` → `uploads hook pre-pr-screenshot`). Do not also write
 * ~/.codex/hooks.json here, or the reminder would fire twice.
 *
 * Idempotent: skip when our command string is already present.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const HOOK_COMMAND = "uploads hook pre-pr-screenshot";
const TIMEOUT_SEC = 15;

const GROK_PAYLOAD = {
  description:
    "Advisory reminder to stage screenshots on uploads.sh before opening a PR that touches UI files.",
  hooks: {
    PreToolUse: [
      {
        matcher: "Bash",
        hooks: [
          {
            type: "command",
            command: HOOK_COMMAND,
            timeout: TIMEOUT_SEC,
            statusMessage: "Checking staged screenshots",
          },
        ],
      },
    ],
  },
} as const;

export type HookWriteResult = {
  path: string;
  action: "wrote" | "merged" | "skipped" | "would-write" | "would-merge";
  error?: string;
};

function containsCommand(filePath: string): boolean {
  try {
    return fs.readFileSync(filePath, "utf8").includes(HOOK_COMMAND);
  } catch {
    return false;
  }
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function commit(
  filePath: string,
  next: unknown,
  dryRun: boolean,
  existed: boolean,
): HookWriteResult {
  if (containsCommand(filePath)) return { path: filePath, action: "skipped" };
  if (dryRun) {
    return { path: filePath, action: existed ? "would-merge" : "would-write" };
  }
  writeJson(filePath, next);
  return { path: filePath, action: existed ? "merged" : "wrote" };
}

function writeGrok(home: string, dryRun: boolean): HookWriteResult {
  const filePath = path.join(home, ".grok", "hooks", "uploads-pre-pr-screenshot.json");
  return commit(filePath, GROK_PAYLOAD, dryRun, fs.existsSync(filePath));
}

function mergeCursor(home: string, dryRun: boolean): HookWriteResult {
  const filePath = path.join(home, ".cursor", "hooks.json");
  const existed = fs.existsSync(filePath);
  let existing: Record<string, unknown> = { version: 1, hooks: {} };
  if (existed) {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return { path: filePath, action: "skipped", error: "hooks.json is not an object" };
      }
      existing = raw as Record<string, unknown>;
    } catch (err) {
      return {
        path: filePath,
        action: "skipped",
        error: `could not parse existing hooks.json: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  const hooks =
    existing.hooks && typeof existing.hooks === "object"
      ? ({ ...(existing.hooks as object) } as Record<string, unknown>)
      : {};
  const list = Array.isArray(hooks.beforeShellExecution) ? [...hooks.beforeShellExecution] : [];
  list.push({ command: HOOK_COMMAND, timeout: TIMEOUT_SEC });
  hooks.beforeShellExecution = list;
  existing.hooks = hooks;
  if (existing.version === undefined) existing.version = 1;

  return commit(filePath, existing, dryRun, existed);
}

export type InstallHooksOptions = {
  home?: string;
  dryRun?: boolean;
  targets?: Array<"grok" | "cursor">;
};

/** User-global manifests for Grok + Cursor only. */
export function installHookManifests(opts: InstallHooksOptions = {}): HookWriteResult[] {
  const home = opts.home ?? os.homedir();
  const dryRun = Boolean(opts.dryRun);
  const targets =
    opts.targets ??
    ([
      fs.existsSync(path.join(home, ".grok")) && "grok",
      fs.existsSync(path.join(home, ".cursor")) && "cursor",
    ].filter(Boolean) as Array<"grok" | "cursor">);

  const results: HookWriteResult[] = [];
  for (const t of targets) {
    try {
      results.push(t === "grok" ? writeGrok(home, dryRun) : mergeCursor(home, dryRun));
    } catch (err) {
      results.push({
        path: t,
        action: "skipped",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}
