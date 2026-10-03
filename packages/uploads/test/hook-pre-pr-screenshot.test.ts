import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  anyVisual,
  cwdFromHookInput,
  leadingCdDir,
  formatAdvisory,
  isCursorHookInput,
  looksLikeGhPrCreate,
  runPrePrScreenshot,
  shellCommandFromHookInput,
} from "../src/commands/hook.js";

function repoOnBranch(branch: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "uploads-hook-")));
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["checkout", "-q", "-b", branch], { cwd: dir, stdio: "ignore" });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    ],
    { cwd: dir, stdio: "ignore" },
  );
  return dir;
}

describe("shellCommandFromHookInput", () => {
  it("reads Claude/Codex tool_input.command", () => {
    expect(
      shellCommandFromHookInput({
        tool_name: "Bash",
        tool_input: { command: "gh pr create --title x" },
      }),
    ).toBe("gh pr create --title x");
  });

  it("reads Grok toolInput.command", () => {
    expect(
      shellCommandFromHookInput({
        toolName: "run_terminal_command",
        toolInput: { command: "gh pr create" },
      }),
    ).toBe("gh pr create");
  });

  it("reads Cursor top-level command", () => {
    expect(
      shellCommandFromHookInput({
        conversation_id: "c1",
        command: "gh pr create --fill",
      }),
    ).toBe("gh pr create --fill");
  });

  it("returns empty on garbage", () => {
    expect(shellCommandFromHookInput(null)).toBe("");
    expect(shellCommandFromHookInput({})).toBe("");
  });
});

describe("formatAdvisory", () => {
  it("emits Claude/Codex/Grok shape by default", () => {
    const parsed = JSON.parse(formatAdvisory("hello", false));
    expect(parsed.systemMessage).toBe("hello");
    expect(parsed.hookSpecificOutput.additionalContext).toBe("hello");
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
  });

  it("emits Cursor flat shape", () => {
    const parsed = JSON.parse(formatAdvisory("hello", true));
    expect(parsed.additional_context).toBe("hello");
    expect(parsed.agentMessage).toBe("hello");
    expect(parsed.hookSpecificOutput).toBeUndefined();
  });
});

describe("helpers", () => {
  it("detects gh pr create loosely", () => {
    expect(looksLikeGhPrCreate("cd foo && gh pr create --fill")).toBe(true);
    expect(looksLikeGhPrCreate("gh pr list")).toBe(false);
  });

  it("matches real invocations", () => {
    for (const c of [
      "gh pr create --fill",
      "cd foo && gh pr create",
      "FOO=1 gh pr create",
      "FOO=1 BAR=x gh pr create --title 'a b'",
      "gh  pr   create",
      "git push; gh pr create",
      "a || gh pr create",
      "echo hi | gh pr create",
      "(gh pr create)",
      "git push\ngh pr create --fill",
      'gh pr create --title "x" --body "y"',
    ]) {
      expect(looksLikeGhPrCreate(c), c).toBe(true);
    }
  });

  it("ignores mentions inside quotes or as arguments", () => {
    for (const c of [
      'grep -n "gh pr create" file',
      "echo 'gh pr create'",
      "rg -n gh\\ pr\\ create",
      "rg gh pr create src",
      "git commit -m 'run gh pr create next'",
      "gh pr create-ish",
    ]) {
      expect(looksLikeGhPrCreate(c), c).toBe(false);
    }
  });

  it("reads cwd from hook payloads", () => {
    expect(cwdFromHookInput({ cwd: "/w/tree" })).toBe("/w/tree");
    expect(cwdFromHookInput({ workspace_roots: ["/cursor/root"] })).toBe("/cursor/root");
    expect(cwdFromHookInput({ tool_input: {} })).toBeNull();
    expect(cwdFromHookInput(null)).toBeNull();
  });

  it("honors a leading cd", () => {
    expect(leadingCdDir("cd /tmp && gh pr create", "/")).toBe("/tmp");
    expect(leadingCdDir("cd /definitely/missing && gh pr create", "/")).toBeNull();
    expect(leadingCdDir("gh pr create", "/")).toBeNull();
  });

  it("classifies visual paths", () => {
    expect(anyVisual(["src/app.tsx", "README.md"])).toBe(true);
    expect(anyVisual(["apps/web/src/email/welcome.tsx"])).toBe(true);
    expect(anyVisual(["packages/api/src/index.ts"])).toBe(false);
  });

  it("detects Cursor payloads", () => {
    expect(isCursorHookInput({ conversation_id: "x" })).toBe(true);
    expect(isCursorHookInput({ tool_input: { command: "x" } })).toBe(false);
  });
});

describe("runPrePrScreenshot", () => {
  const git = {
    isRepo: () => true,
    branch: () => "feat/ui",
    changedFiles: () => ["apps/web/src/Page.tsx"],
  };

  it("is silent for non-pr commands", async () => {
    const out = await runPrePrScreenshot({
      stdin: JSON.stringify({ tool_input: { command: "ls" } }),
      git,
      countStaged: async () => 0,
    });
    expect(out).toBeNull();
  });

  it("suggests promoting when screenshots are already staged (issue #700)", async () => {
    const out = await runPrePrScreenshot({
      stdin: JSON.stringify({ tool_input: { command: "gh pr create" } }),
      git,
      countStaged: async () => 2,
      binding: async () => null,
      isFork: () => false,
    });
    expect(out).toBeTruthy();
    const parsed = JSON.parse(out!);
    expect(parsed.hookSpecificOutput.additionalContext).toMatch(/2 files staged/);
    expect(parsed.hookSpecificOutput.additionalContext).toMatch(/feat\/ui/);
    expect(parsed.hookSpecificOutput.additionalContext).toMatch(
      /uploads attach --promote --pr <num>/,
    );
  });

  it("singularizes the promote suggestion for exactly one staged file", async () => {
    const out = await runPrePrScreenshot({
      stdin: JSON.stringify({ tool_input: { command: "gh pr create" } }),
      git,
      countStaged: async () => 1,
      binding: async () => null,
      isFork: () => false,
    });
    const parsed = JSON.parse(out!);
    expect(parsed.hookSpecificOutput.additionalContext).toMatch(/1 file staged/);
    expect(parsed.hookSpecificOutput.additionalContext).toMatch(/isn't attached/);
  });

  it("appends the fork note to the promote suggestion", async () => {
    const out = await runPrePrScreenshot({
      stdin: JSON.stringify({ tool_input: { command: "gh pr create" } }),
      git,
      countStaged: async () => 2,
      binding: async () => null,
      isFork: () => true,
    });
    expect(out).toMatch(/fork branch/);
    expect(out).toMatch(/#317/);
  });

  it("promote suggestion fires even when the diff has no UI files", async () => {
    const out = await runPrePrScreenshot({
      stdin: JSON.stringify({ tool_input: { command: "gh pr create" } }),
      git: { ...git, changedFiles: () => ["packages/api/src/index.ts"] },
      countStaged: async () => 1,
      binding: async () => null,
      isFork: () => false,
    });
    expect(out).toBeTruthy();
    expect(out).toMatch(/uploads attach --promote/);
  });

  it("says files attach automatically when the repo binding is self", async () => {
    const out = await runPrePrScreenshot({
      stdin: JSON.stringify({ tool_input: { command: "gh pr create" } }),
      git,
      countStaged: async () => 1,
      isFork: () => false,
      binding: async () => ({
        state: "self",
        autoAttach: true,
        message: "these auto-attach when this branch's PR opens",
      }),
    });
    const msg = JSON.parse(out!).hookSpecificOutput.additionalContext;
    expect(msg).toMatch(/1 file staged for branch 'feat\/ui'/);
    expect(msg).toMatch(/auto-attach when this branch's PR opens/);
    expect(msg).not.toMatch(/attach --promote/);
  });

  it("says files won't attach from here when the repo binding is other", async () => {
    const out = await runPrePrScreenshot({
      stdin: JSON.stringify({ tool_input: { command: "gh pr create" } }),
      git,
      countStaged: async () => 2,
      isFork: () => false,
      binding: async () => ({
        state: "other",
        autoAttach: false,
        message:
          "staged, but o/r is linked to a different workspace — these files won't auto-attach from here.",
      }),
    });
    const msg = JSON.parse(out!).hookSpecificOutput.additionalContext;
    expect(msg).toMatch(/won't auto-attach from here/);
    expect(msg).not.toMatch(/attach --promote/);
  });

  it("keeps the promote advice when the binding is none or unknown", async () => {
    for (const state of ["none", "unknown"] as const) {
      const out = await runPrePrScreenshot({
        stdin: JSON.stringify({ tool_input: { command: "gh pr create" } }),
        git,
        countStaged: async () => 1,
        isFork: () => false,
        binding: async () => ({ state, autoAttach: false, message: "x" }),
      });
      expect(out).toMatch(/uploads attach --promote --pr <num>/);
    }
  });

  it("is silent when find fails open", async () => {
    const out = await runPrePrScreenshot({
      stdin: JSON.stringify({ tool_input: { command: "gh pr create" } }),
      git,
      countStaged: async () => null,
    });
    expect(out).toBeNull();
  });

  it("advises when UI files changed and nothing staged", async () => {
    const out = await runPrePrScreenshot({
      stdin: JSON.stringify({ tool_input: { command: "gh pr create --fill" } }),
      git,
      countStaged: async () => 0,
      isFork: () => false,
    });
    expect(out).toBeTruthy();
    const parsed = JSON.parse(out!);
    expect(parsed.hookSpecificOutput.additionalContext).toMatch(/feat\/ui/);
    expect(parsed.hookSpecificOutput.additionalContext).toMatch(/uploads attach/);
  });

  it("uses Cursor output shape for Cursor stdin", async () => {
    const out = await runPrePrScreenshot({
      stdin: JSON.stringify({
        conversation_id: "c1",
        command: "gh pr create",
      }),
      git,
      countStaged: async () => 0,
      isFork: () => false,
    });
    const parsed = JSON.parse(out!);
    expect(parsed.additional_context).toMatch(/uploads attach/);
    expect(parsed.hookSpecificOutput).toBeUndefined();
  });

  it("appends fork note when isFork is true", async () => {
    const out = await runPrePrScreenshot({
      stdin: JSON.stringify({ tool_input: { command: "gh pr create" } }),
      git,
      countStaged: async () => 0,
      isFork: () => true,
    });
    expect(out).toMatch(/fork branch/);
    expect(out).toMatch(/#317/);
  });

  it("respects UPLOADS_HOOK_DISABLE", async () => {
    const prev = process.env.UPLOADS_HOOK_DISABLE;
    process.env.UPLOADS_HOOK_DISABLE = "1";
    try {
      const out = await runPrePrScreenshot({
        stdin: JSON.stringify({ tool_input: { command: "gh pr create" } }),
        git,
        countStaged: async () => 0,
      });
      expect(out).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.UPLOADS_HOOK_DISABLE;
      else process.env.UPLOADS_HOOK_DISABLE = prev;
    }
  });

  describe("working directory", () => {
    it("uses the payload cwd for the branch lookup", async () => {
      const dir = repoOnBranch("worktree-branch");
      let seen: string | null = null;
      const out = await runPrePrScreenshot({
        stdin: JSON.stringify({ cwd: dir, tool_input: { command: "gh pr create --fill" } }),
        testFiles: "a.tsx",
        countStaged: async (b) => {
          seen = b;
          return 0;
        },
        isFork: () => false,
      });
      expect(seen).toBe("worktree-branch");
      expect(out).toMatch(/worktree-branch/);
    });

    it("prefers payload cwd over deps.cwd, and a leading cd over both", async () => {
      const payloadDir = repoOnBranch("payload-branch");
      const depsDir = repoOnBranch("deps-branch");
      const cdDir = repoOnBranch("cd-branch");
      mkdirSync(join(cdDir, "sub"));
      const seen: string[] = [];
      const run = (stdin: object, cwd?: string) =>
        runPrePrScreenshot({
          stdin: JSON.stringify(stdin),
          cwd,
          testFiles: "a.tsx",
          countStaged: async (b) => {
            seen.push(b);
            return 0;
          },
          isFork: () => false,
        });
      await run({ cwd: payloadDir, tool_input: { command: "gh pr create" } }, depsDir);
      await run({ tool_input: { command: "gh pr create" } }, depsDir);
      await run({ cwd: payloadDir, tool_input: { command: `cd ${cdDir} && gh pr create` } });
      await run({ cwd: cdDir, tool_input: { command: "cd sub && gh pr create" } });
      expect(seen).toEqual(["payload-branch", "deps-branch", "cd-branch", "cd-branch"]);
    });
  });
});
