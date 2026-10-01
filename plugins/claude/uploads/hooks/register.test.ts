import type { On } from "claude-code";
import type { Engine, MockClock } from "claude-code/testing";
import { describe, expect, mock, test } from "claude-code/testing";

const PLUGIN = "uploads";
const REPO = "buildinternet/uploads";
const PR_OUTPUT = `Creating pull request\nhttps://github.com/${REPO}/pull/1051\n`;
const STAGE = "uploads attach shot.png --branch";

const ok = (stdout: string) => ({
  value: { exitCode: 0, stdout, stderr: "", isStdoutTruncated: false, isStderrTruncated: false },
});

type Cli = {
  /** The session directory's branch, what a bare `uploads staged` resolves. */
  sessionBranch: string;
  /** The PR's head branch, what `gh pr view` reports. */
  head: string;
  /** Staged files per branch; `attach --promote` empties the promoted one. */
  counts: Record<string, number>;
  binding: [state: string, autoAttach: boolean];
};

type World = {
  cli: Cli;
  argvs: string[][];
  toasts: string[];
  clock: MockClock;
  output: { text: string };
};

// The engine beneath the plugin: a still clock, nothing drawn when the plugin
// passes, Bash answering with `output.text`, and a fake `uploads` and `gh`
// that record every argv and toast.
const setup = (on: On, over: Partial<Cli> = {}, text = PR_OUTPUT): World => {
  const cli: Cli = {
    sessionBranch: "feat/x",
    head: "feat/x",
    counts: { "feat/x": 1 },
    binding: ["none", false],
    ...over,
  };
  const world: World = {
    cli,
    argvs: [],
    toasts: [],
    clock: mock.clock(on, { now: 1_000_000 }),
    output: { text },
  };
  on("ui.render", async ($, e) => {
    const { Box } = $.ui.resolve(e);
    return h(Box, {}) as never;
  });
  on(
    "tool.call",
    async () => ({ result: { stdout: world.output.text }, text: world.output.text }) as never,
  );
  on("ui.toast", async (_$, e) => {
    world.toasts.push(e.text);
    return { value: undefined };
  });
  on("process.run", async (_$, e) => {
    const argv = [...e.argv];
    world.argvs.push(argv);
    if (argv[0] === "gh") {
      return ok(`${cli.head}\n`);
    }
    if (argv[1] === "attach") {
      cli.counts[argv[argv.indexOf("--from-branch") + 1] ?? cli.sessionBranch] = 0;
      return ok("{}");
    }
    const i = argv.indexOf("--branch");
    const branch = i === -1 ? cli.sessionBranch : (argv[i + 1] ?? "");
    const files = Array.from({ length: cli.counts[branch] ?? 0 }, (_, n) => ({
      key: `gh/x/shot-${n}.png`,
      filename: `shot-${n}.png`,
      size: 94_000,
      url: `https://storage.uploads.sh/default/gh/x/shot-${n}.png`,
    }));
    const [state, autoAttach] = cli.binding;
    return ok(JSON.stringify({ repo: REPO, branch, files, binding: { state, autoAttach } }));
  });
  return world;
};

let calls = 0;
// Runs a Bash command through the plugin, then lets scheduled refreshes run.
const runBash = async ($: Engine, world: World, command: string) => {
  calls += 1;
  const ran = await $.tool.call({ tool: "Bash", command, tool_use_id: `t${calls}` } as never);
  await world.clock.settle();
  return ran as { context?: string[] };
};

const promoted = (world: World) => world.argvs.some((argv) => argv[1] === "attach");

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { bodyRows: 9, offset: 0 },
} as never;

const mountBand = ($: Engine, surface: "terminal" | "desktop" = "terminal") =>
  $.ui.mount({ plugin: PLUGIN, surface, component: "AbovePrompt", props: BAND_PROPS });

describe("gh pr create", () => {
  test("promotes the PR head's staged files through the CLI when the repo is not linked", async ($, on) => {
    const world = setup(on, { sessionBranch: "main", counts: { "feat/x": 2, main: 5 } });

    const ran = await runBash($, world, "cd ../wt && gh pr create --fill");

    expect(world.argvs).toContainEqual([
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
    expect(world.toasts).toContainEqual("uploads: attached 2 staged files to PR #1051");
    expect(ran.context?.join("\n")).toContain("PR #1051");
  });

  test(
    "only reports staged files when autoPromote is off",
    { options: { autoPromote: false } },
    async ($, on) => {
      const world = setup(on, { counts: { "feat/x": 2 } });

      const ran = await runBash($, world, "gh pr create --fill");

      expect(promoted(world)).toBe(false);
      expect(ran.context?.join("\n")).toContain("uploads attach --promote --pr 1051");
    },
  );

  test("leaves promotion to the GitHub App when the repo is bound here", async ($, on) => {
    const world = setup(on, { binding: ["self", true] });

    await runBash($, world, "gh pr create --fill");

    expect(promoted(world)).toBe(false);
    expect(world.toasts).toContainEqual(
      "uploads: 1 staged file will attach to PR #1051 via the uploads-sh bot",
    );
  });

  test("reports the App's promotion when it beat the mod to it", async ($, on) => {
    const world = setup(on, { counts: { "feat/x": 3 }, binding: ["self", true] }, "");
    await runBash($, world, STAGE);

    // The webhook promotes before the mod reads again.
    world.cli.counts["feat/x"] = 0;
    world.output.text = PR_OUTPUT;
    await runBash($, world, "gh pr create --fill");

    expect(promoted(world)).toBe(false);
    expect(world.toasts).toContainEqual(
      "uploads: 3 staged files attached to PR #1051 by the uploads-sh bot",
    );
  });

  test("does not promote when nothing is staged for the PR head", async ($, on) => {
    const world = setup(on, {
      sessionBranch: "other",
      counts: { other: 4 },
      binding: ["unknown", false],
    });

    await runBash($, world, "gh pr create --fill");

    expect(promoted(world)).toBe(false);
    expect(world.toasts).toEqual([]);
  });

  test("does nothing for other commands", async ($, on) => {
    const world = setup(on, {}, "");

    await runBash($, world, "ls -la");

    expect(world.argvs).toEqual([]);
  });
});

describe("band", () => {
  for (const surface of ["terminal", "desktop"] as const) {
    test(`shows the staged count on ${surface}`, async ($, on) => {
      const world = setup(on, { counts: { "feat/x": 3 }, binding: ["self", true] }, "");
      await runBash($, world, STAGE);

      const ui = await mountBand($, surface);
      expect(await ui.find({ type: "Text", text: /3 staged files on feat\/x/ })).toBeTruthy();
    });
  }

  test("hides for the branch it was hidden on, and returns on a new branch", async ($, on) => {
    const world = setup(on, { counts: { "feat/x": 1, "feat/y": 2 }, binding: ["self", true] }, "");
    await runBash($, world, STAGE);

    const ui = await mountBand($);
    await ui.press({ key: "hide" });
    expect(await ui.findAll({ text: /uploads ·/ })).toEqual([]);

    world.cli.sessionBranch = "feat/y";
    await runBash($, world, "git switch feat/y");
    expect(await (await mountBand($)).find({ text: /2 staged files on feat\/y/ })).toBeTruthy();
  });

  for (const surface of ["terminal", "desktop"] as const) {
    test(`lists staged files with links to their pages on ${surface}`, async ($, on) => {
      const world = setup(on, { counts: { "feat/x": 2 }, binding: ["self", true] }, "");
      await runBash($, world, STAGE);

      const ui = await mountBand($, surface);
      expect(await ui.findAll({ type: "Link" })).toEqual([]);

      await ui.press({ key: "files" });
      const links = await ui.findAll({ type: "Link" });
      expect(links.map((link) => link.text)).toEqual(["shot-0.png", "shot-1.png"]);
      expect(JSON.stringify(await ui.drawn())).toContain(
        "https://uploads.sh/f/default/gh/x/shot-0.png",
      );
      expect(await ui.find({ text: /92 KB/ })).toBeTruthy();

      await ui.press({ key: "files" });
      expect(await ui.findAll({ type: "Link" })).toEqual([]);
    });
  }

  test("stays empty when the CLI is missing", async ($, on) => {
    mock.clock(on, { now: 1_000_000 });
    on("ui.render", async ($$, e) => h($$.ui.resolve(e).Box, {}) as never);
    on("process.run", async () => ({ deny: "ENOENT" }));
    on("tool.call", async () => ({ result: { stdout: "" }, text: "" }) as never);
    await $.tool.call({ tool: "Bash", command: STAGE, tool_use_id: "missing" } as never);

    const ui = await mountBand($);
    expect(await ui.findAll({ text: /uploads ·/ })).toEqual([]);
  });
});
