import { describe, expect, it } from "vitest";
import {
  anyVisual,
  formatAdvisory,
  isCursorHookInput,
  looksLikeGhPrCreate,
  runPrePrScreenshot,
  shellCommandFromHookInput,
} from "../src/commands/hook.js";

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

  it("is silent when screenshots are already staged", async () => {
    const out = await runPrePrScreenshot({
      stdin: JSON.stringify({ tool_input: { command: "gh pr create" } }),
      git,
      countStaged: async () => 2,
    });
    expect(out).toBeNull();
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
});
