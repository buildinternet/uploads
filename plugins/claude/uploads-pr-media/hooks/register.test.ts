import type { On } from "claude-code";
import { describe, expect, mock, test } from "claude-code/testing";

const PLUGIN = "uploads-pr-media";
const PR_OUTPUT = "Creating pull request\nhttps://github.com/buildinternet/uploads/pull/1051\n";

const stagedDoc = (count: number, state: string, autoAttach: boolean) =>
  JSON.stringify({
    repo: "buildinternet/uploads",
    branch: "feat/x",
    files: Array.from({ length: count }, (_, i) => ({ key: `gh/x/${i}.png` })),
    binding: { state, autoAttach, message: "" },
  });

const ok = (stdout: string) => ({
  value: { exitCode: 0, stdout, stderr: "", isStdoutTruncated: false, isStderrTruncated: false },
});

// The engine beneath the plugin: a still clock, and nothing drawn when the plugin passes.
const world = (on: On) => {
  mock.clock(on, { now: 1_000_000 });
  on("ui.render", async ($, e) => {
    const { Box } = $.ui.resolve(e);
    return h(Box, {}) as never;
  });
};

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { bodyRows: 9, offset: 0 },
} as never;

describe("gh pr create", () => {
  test("promotes staged files through the CLI when the repo is not linked", async ($, on) => {
    world(on);
    const argvs: string[][] = [];
    const toasts: string[] = [];
    let promoted = false;
    on("process.run", async (_$, e) => {
      argvs.push([...e.argv]);
      if (e.argv[1] === "attach") {
        promoted = true;
        return ok("{}");
      }
      return ok(stagedDoc(promoted ? 0 : 2, "none", false));
    });
    on("ui.toast", async (_$, e) => {
      toasts.push(e.text);
      return { value: undefined };
    });
    on("tool.call", async () => ({ result: { stdout: PR_OUTPUT }, text: PR_OUTPUT }) as never);

    const ran = await $.tool.call({
      tool: "Bash",
      command: "gh pr create --fill",
      tool_use_id: "t1",
    } as never);

    expect(argvs).toContainEqual([
      "uploads",
      "attach",
      "--promote",
      "--pr",
      "1051",
      "--repo",
      "buildinternet/uploads",
    ]);
    expect(toasts).toContainEqual("uploads: attached 2 staged files to PR #1051");
    expect((ran as { context?: string[] }).context?.join("\n")).toContain("PR #1051");
  });

  test("leaves promotion to the GitHub App when the repo is bound here", async ($, on) => {
    world(on);
    const argvs: string[][] = [];
    const toasts: string[] = [];
    on("process.run", async (_$, e) => {
      argvs.push([...e.argv]);
      return ok(stagedDoc(1, "self", true));
    });
    on("ui.toast", async (_$, e) => {
      toasts.push(e.text);
      return { value: undefined };
    });
    on("tool.call", async () => ({ result: { stdout: PR_OUTPUT }, text: PR_OUTPUT }) as never);

    await $.tool.call({ tool: "Bash", command: "gh pr create --fill", tool_use_id: "t2" } as never);

    expect(argvs.some((argv) => argv[1] === "attach")).toBe(false);
    expect(toasts).toContainEqual(
      "uploads: 1 staged file will attach to PR #1051 via the uploads-sh bot",
    );
  });

  test("does nothing for other commands", async ($, on) => {
    world(on);
    const argvs: string[][] = [];
    on("process.run", async (_$, e) => {
      argvs.push([...e.argv]);
      return ok(stagedDoc(1, "none", false));
    });
    on("tool.call", async () => ({ result: { stdout: "" }, text: "" }) as never);

    await $.tool.call({ tool: "Bash", command: "ls -la", tool_use_id: "t3" } as never);

    expect(argvs).toEqual([]);
  });
});

describe("band", () => {
  for (const surface of ["terminal", "desktop"] as const) {
    test(`shows the staged count on ${surface}`, async ($, on) => {
      world(on);
      on("process.run", async () => ok(stagedDoc(3, "self", true)));
      on("tool.call", async () => ({ result: { stdout: "" }, text: "" }) as never);
      await $.tool.call({ tool: "Bash", command: "uploads staged", tool_use_id: "t4" } as never);

      const ui = await $.ui.mount({
        plugin: PLUGIN,
        surface,
        component: "AbovePrompt",
        props: BAND_PROPS,
      });
      const text = await ui.find({ type: "Text", text: /3 staged files on feat\/x/ });
      expect(text).toBeTruthy();
    });
  }

  test("stays empty when the CLI is missing", async ($, on) => {
    world(on);
    on("process.run", async () => ({ deny: "ENOENT" }));
    on("tool.call", async () => ({ result: { stdout: "" }, text: "" }) as never);
    await $.tool.call({ tool: "Bash", command: "uploads staged", tool_use_id: "t5" } as never);

    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface: "terminal",
      component: "AbovePrompt",
      props: BAND_PROPS,
    });
    expect(await ui.findAll({ text: /uploads ·/ })).toEqual([]);
  });
});
