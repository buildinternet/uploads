import type { On } from "claude-code";
import { describe, expect, mock, test } from "claude-code/testing";

const PLUGIN = "uploads-pr-media";
const REPO = "buildinternet/uploads";
const PR_OUTPUT = `Creating pull request\nhttps://github.com/${REPO}/pull/1051\n`;

const stagedDoc = (branch: string, count: number, state: string, autoAttach: boolean) =>
  JSON.stringify({
    repo: REPO,
    branch,
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

type Cli = {
  /** The session directory's branch, what a bare `uploads staged` resolves. */
  sessionBranch: string;
  /** The PR's head branch, what `gh pr view` reports. */
  head: string;
  /** Staged files per branch; `attach --promote` empties the promoted one. */
  counts: Record<string, number>;
  binding: [state: string, autoAttach: boolean];
};

// A fake `uploads` and `gh` that record every argv and toast.
const fakeCli = (on: On, cli: Cli) => {
  const argvs: string[][] = [];
  const toasts: string[] = [];
  on("process.run", async (_$, e) => {
    const argv = [...e.argv];
    argvs.push(argv);
    if (argv[0] === "gh") {
      return ok(`${cli.head}\n`);
    }
    if (argv[1] === "attach") {
      const from = argv[argv.indexOf("--from-branch") + 1] ?? cli.sessionBranch;
      cli.counts[from] = 0;
      return ok("{}");
    }
    const i = argv.indexOf("--branch");
    const branch = i === -1 ? cli.sessionBranch : (argv[i + 1] ?? "");
    return ok(stagedDoc(branch, cli.counts[branch] ?? 0, ...cli.binding));
  });
  on("ui.toast", async (_$, e) => {
    toasts.push(e.text);
    return { value: undefined };
  });
  return { argvs, toasts };
};

const bash = (on: On, output: string) =>
  on("tool.call", async () => ({ result: { stdout: output }, text: output }) as never);

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { bodyRows: 9, offset: 0 },
} as never;

describe("gh pr create", () => {
  test("promotes the PR head's staged files through the CLI when the repo is not linked", async ($, on) => {
    world(on);
    const cli = fakeCli(on, {
      sessionBranch: "main",
      head: "feat/x",
      counts: { "feat/x": 2, main: 5 },
      binding: ["none", false],
    });
    bash(on, PR_OUTPUT);

    const ran = await $.tool.call({
      tool: "Bash",
      command: "cd ../wt && gh pr create --fill",
      tool_use_id: "t1",
    } as never);

    expect(cli.argvs).toContainEqual([
      "uploads",
      "attach",
      "--promote",
      "--pr",
      "1051",
      "--repo",
      REPO,
      "--from-branch",
      "feat/x",
    ]);
    expect(cli.toasts).toContainEqual("uploads: attached 2 staged files to PR #1051");
    expect((ran as { context?: string[] }).context?.join("\n")).toContain("PR #1051");
  });

  test("leaves promotion to the GitHub App when the repo is bound here", async ($, on) => {
    world(on);
    const cli = fakeCli(on, {
      sessionBranch: "feat/x",
      head: "feat/x",
      counts: { "feat/x": 1 },
      binding: ["self", true],
    });
    bash(on, PR_OUTPUT);

    await $.tool.call({ tool: "Bash", command: "gh pr create --fill", tool_use_id: "t2" } as never);

    expect(cli.argvs.some((argv) => argv[1] === "attach")).toBe(false);
    expect(cli.toasts).toContainEqual(
      "uploads: 1 staged file will attach to PR #1051 via the uploads-sh bot",
    );
  });

  test("reports the App's promotion when it beat the mod to it", async ($, on) => {
    world(on);
    const state: Cli = {
      sessionBranch: "feat/x",
      head: "feat/x",
      counts: { "feat/x": 3 },
      binding: ["self", true],
    };
    const cli = fakeCli(on, state);
    let output = "";
    on("tool.call", async () => ({ result: { stdout: output }, text: output }) as never);
    await $.tool.call({ tool: "Bash", command: "uploads staged", tool_use_id: "t3a" } as never);

    // The webhook promotes before the mod reads again.
    state.counts["feat/x"] = 0;
    output = PR_OUTPUT;
    await $.tool.call({
      tool: "Bash",
      command: "gh pr create --fill",
      tool_use_id: "t3b",
    } as never);

    expect(cli.argvs.some((argv) => argv[1] === "attach")).toBe(false);
    expect(cli.toasts).toContainEqual(
      "uploads: 3 staged files attached to PR #1051 by the uploads-sh bot",
    );
  });

  test("does not promote when nothing is staged for the PR head", async ($, on) => {
    world(on);
    const cli = fakeCli(on, {
      sessionBranch: "other",
      head: "feat/x",
      counts: { other: 4 },
      binding: ["unknown", false],
    });
    bash(on, PR_OUTPUT);

    await $.tool.call({ tool: "Bash", command: "gh pr create --fill", tool_use_id: "t4" } as never);

    expect(cli.argvs.some((argv) => argv[1] === "attach")).toBe(false);
    expect(cli.toasts).toEqual([]);
  });

  test("does nothing for other commands", async ($, on) => {
    world(on);
    const cli = fakeCli(on, {
      sessionBranch: "feat/x",
      head: "feat/x",
      counts: { "feat/x": 1 },
      binding: ["none", false],
    });
    bash(on, "");

    await $.tool.call({ tool: "Bash", command: "ls -la", tool_use_id: "t5" } as never);

    expect(cli.argvs).toEqual([]);
  });
});

describe("band", () => {
  for (const surface of ["terminal", "desktop"] as const) {
    test(`shows the staged count on ${surface}`, async ($, on) => {
      world(on);
      fakeCli(on, {
        sessionBranch: "feat/x",
        head: "feat/x",
        counts: { "feat/x": 3 },
        binding: ["self", true],
      });
      bash(on, "");
      await $.tool.call({ tool: "Bash", command: "uploads staged", tool_use_id: "b1" } as never);

      const ui = await $.ui.mount({
        plugin: PLUGIN,
        surface,
        component: "AbovePrompt",
        props: BAND_PROPS,
      });
      expect(await ui.find({ type: "Text", text: /3 staged files on feat\/x/ })).toBeTruthy();
    });
  }

  test("hides for the branch it was hidden on, and returns on a new branch", async ($, on) => {
    world(on);
    const state: Cli = {
      sessionBranch: "feat/x",
      head: "feat/x",
      counts: { "feat/x": 1, "feat/y": 2 },
      binding: ["self", true],
    };
    fakeCli(on, state);
    bash(on, "");
    await $.tool.call({ tool: "Bash", command: "uploads staged", tool_use_id: "b2" } as never);

    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface: "terminal",
      component: "AbovePrompt",
      props: BAND_PROPS,
    });
    await ui.press({ key: "hide" });
    expect(await ui.findAll({ text: /uploads ·/ })).toEqual([]);

    state.sessionBranch = "feat/y";
    await $.tool.call({ tool: "Bash", command: "git switch feat/y", tool_use_id: "b3" } as never);
    const again = await $.ui.mount({
      plugin: PLUGIN,
      surface: "terminal",
      component: "AbovePrompt",
      props: BAND_PROPS,
    });
    expect(await again.find({ text: /2 staged files on feat\/y/ })).toBeTruthy();
  });

  test("stays empty when the CLI is missing", async ($, on) => {
    world(on);
    on("process.run", async () => ({ deny: "ENOENT" }));
    bash(on, "");
    await $.tool.call({ tool: "Bash", command: "uploads staged", tool_use_id: "b4" } as never);

    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface: "terminal",
      component: "AbovePrompt",
      props: BAND_PROPS,
    });
    expect(await ui.findAll({ text: /uploads ·/ })).toEqual([]);
  });
});
