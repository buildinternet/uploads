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
  /** Overrides for the nth staged file's JSON (filename, state, path). */
  files?: { filename: string; state?: string; path?: string }[];
  /** How `attach --promote` ends: everything moved (default), one skipped, or a server error. */
  promote?: "ok" | "partial" | "error";
  /** The open PR for the session branch, as `gh pr view` reports it. */
  openPr?: number;
  /** Thumbnail fetches (`curl | base64`) fail when set. */
  thumbsFail?: boolean;
};

type World = {
  cli: Cli;
  argvs: string[][];
  toasts: string[];
  clock: MockClock;
  output: { text: string };
  opened: string[];
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
    opened: [],
  };
  on("ui.render", async ($, e) => {
    const { Box } = $.ui.resolve(e);
    return h(Box, {}) as never;
  });
  on(
    "tool.call",
    async () => ({ result: { stdout: world.output.text }, text: world.output.text }) as never,
  );
  on("ui.open", async (_$, e) => {
    world.opened.push(`${e.id}:${e.title}`);
    return { value: undefined } as never;
  });
  on("ui.toast", async (_$, e) => {
    world.toasts.push(e.text);
    return { value: undefined };
  });
  on("process.run", async (_$, e) => {
    const argv = [...e.argv];
    world.argvs.push(argv);
    if (argv[0] === "gh") {
      if (argv.includes("number,url,state")) {
        return cli.openPr
          ? ok(
              JSON.stringify({
                number: cli.openPr,
                url: `https://github.com/${REPO}/pull/${cli.openPr}`,
                state: "OPEN",
              }),
            )
          : { deny: "no pull request" };
      }
      return ok(`${cli.head}\n`);
    }
    if (argv[0] === "sh") {
      return cli.thumbsFail ? { deny: "curl failed" } : ok("AAAA\nBBBB\n");
    }
    if (argv[1] === "feed") {
      return ok(`https://uploads.sh/feed/abc\nmore\n`);
    }
    if (argv[1] === "delete") {
      const key = argv[2] ?? "";
      const branch = cli.sessionBranch;
      cli.counts[branch] = Math.max(0, (cli.counts[branch] ?? 0) - 1);
      cli.files = cli.files?.filter((f) => `gh/x/${f.filename}` !== key);
      return ok("");
    }
    if (argv[1] === "attach") {
      const from = argv[argv.indexOf("--from-branch") + 1] ?? cli.sessionBranch;
      const staged = cli.counts[from] ?? 0;
      const skipped = cli.promote === "partial" ? 1 : 0;
      cli.counts[from] = skipped;
      // The CLI exits 0 even when the server call failed; then `promotion` is null.
      const promotion =
        cli.promote === "error"
          ? null
          : {
              promoted: Array.from({ length: staged - skipped }, (_, n) => `gh/x/${n}`),
              skipped: Array.from({ length: skipped }, () => ({
                key: "gh/x/s",
                reason: "too big",
              })),
            };
      return ok(JSON.stringify({ target: {}, uploads: [], failures: [], promotion }));
    }
    const i = argv.indexOf("--branch");
    const branch = i === -1 ? cli.sessionBranch : (argv[i + 1] ?? "");
    const files = Array.from({ length: cli.counts[branch] ?? 0 }, (_, n) => {
      const name = cli.files?.[n]?.filename ?? `shot-${n}.png`;
      return {
        key: `gh/x/${name}`,
        filename: name,
        size: 94_000,
        stagedAt: new Date(1_000_000 - 5 * 60_000).toISOString(),
        url: `https://storage.uploads.sh/default/gh/x/${name}`,
        ...cli.files?.[n],
      };
    });
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
      "--json",
    ]);
    expect(world.toasts).toContainEqual("uploads: added 2 attachments to PR #1051");
    expect(ran.context?.join("\n")).toContain("PR #1051");
  });

  test("reports a failure when the promote exits 0 but promoted nothing", async ($, on) => {
    const world = setup(on, { counts: { "feat/x": 2 }, promote: "error" });

    const ran = await runBash($, world, "gh pr create --fill");

    expect(world.toasts).toContainEqual(
      "uploads: couldn't add 2 attachments to PR #1051; run uploads attach --promote",
    );
    expect(ran.context?.join("\n")).toContain("did not attach");
    // Nothing is recorded as attached, so the band keeps showing the files.
    expect(await (await mountBand($)).find({ text: /attached to PR/ })).toBeUndefined();
  });

  test("counts only what moved when the promote skips a file", async ($, on) => {
    const world = setup(on, { counts: { "feat/x": 3 }, promote: "partial" });

    const ran = await runBash($, world, "gh pr create --fill");

    expect(world.toasts).toContainEqual("uploads: added 2 attachments to PR #1051; 1 skipped");
    expect(ran.context?.join("\n")).toContain("1 was skipped");
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
      "uploads: 1 attachment will attach to PR #1051 via the uploads-sh bot",
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
      "uploads: 3 attachments added to PR #1051 by the uploads-sh bot",
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
      expect(await ui.find({ type: "Text", text: /3 attachments waiting for a PR$/ })).toBeTruthy();
      // The branch stays out of the band.
      expect(await ui.find({ text: /feat\/x/ })).toBeUndefined();
    });
  }

  test("follows the session to a new branch", async ($, on) => {
    const world = setup(on, { counts: { "feat/x": 1, "feat/y": 2 }, binding: ["self", true] }, "");
    await runBash($, world, STAGE);
    expect(await (await mountBand($)).find({ text: /1 attachment waiting for a PR/ })).toBeTruthy();

    world.cli.sessionBranch = "feat/y";
    await runBash($, world, "git switch feat/y");
    expect(
      await (await mountBand($)).find({ text: /2 attachments waiting for a PR/ }),
    ).toBeTruthy();
  });

  test("leads with the brand mark: pixels on the terminal, a glyph on desktop", async ($, on) => {
    const world = setup(on, { binding: ["self", true] }, "");
    await runBash($, world, STAGE);

    expect(await (await mountBand($, "terminal")).find({ type: "Image" })).toBeTruthy();
    const desktop = await mountBand($, "desktop");
    expect(await desktop.find({ type: "Image" })).toBeUndefined();
    expect(await desktop.find({ type: "Svg" })).toBeTruthy();
    expect(await desktop.find({ type: "Text", text: "uploads" })).toBeTruthy();
  });

  for (const surface of ["terminal"] as const) {
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

  test("shows each before/after pair as one row, with a dash for a missing half", async ($, on) => {
    const world = setup(
      on,
      {
        counts: { "feat/x": 5 },
        binding: ["self", true],
        files: [
          { filename: "home-before.png" },
          { filename: "home-after.png" },
          { filename: "uploads.sh-after.webp" },
          { filename: "a.png", state: "before", path: "/settings" },
          { filename: "notes.txt" },
        ],
      },
      "",
    );
    await runBash($, world, STAGE);
    const ui = await mountBand($);
    await ui.press({ key: "files" });

    // Rows in staged order: home (both halves), uploads.sh (no before),
    // /settings (no after, paired by path metadata), notes.txt (neither).
    const labels = (
      await ui.findAll({ type: "Text", text: /^(home|uploads\.sh|\/settings) $/ })
    ).map((t) => t.text.trim());
    expect(labels).toEqual(["home", "uploads.sh", "/settings"]);
    const links = (await ui.findAll({ type: "Link" })).map((link) => link.text);
    expect(links).toEqual(["before", "after", "after", "before", "notes.txt"]);
    expect(await ui.findAll({ type: "Text", text: "—" })).toHaveLength(2);
    expect(await ui.findAll({ text: /paired|no before|no after/ })).toEqual([]);
  });

  test("stays empty when the CLI is missing", async ($, on) => {
    mock.clock(on, { now: 1_000_000 });
    on("ui.render", async ($$, e) => h($$.ui.resolve(e).Box, {}) as never);
    on("process.run", async () => ({ deny: "ENOENT" }));
    on("tool.call", async () => ({ result: { stdout: "" }, text: "" }) as never);
    await $.tool.call({ tool: "Bash", command: STAGE, tool_use_id: "missing" } as never);

    const ui = await mountBand($);
    expect(await ui.findAll({ text: /uploads|staged/ })).toEqual([]);
  });
});

const mountPane = ($: Engine, surface: "terminal" | "desktop" = "desktop") =>
  $.ui.mount({
    plugin: PLUGIN,
    surface,
    component: "Pane",
    requestId: "uploads-staged",
    props: { bodyColumns: 120 } as never,
  });

const BINDING_LINES: [string, [string, boolean], RegExp, boolean][] = [
  ["self", ["self", true], /^\s*1 attachment waiting for a PR$/, false],
  ["unknown", ["unknown", false], /^\s*1 attachment waiting for a PR$/, false],
  [
    "none",
    ["none", false],
    /^\s*1 attachment waiting for a PR · link the repo to auto-attach$/,
    false,
  ],
  [
    "other",
    ["other", false],
    /^\s*1 attachment won't attach: repo linked to another workspace$/,
    true,
  ],
];

describe("band headline", () => {
  for (const surface of ["terminal", "desktop"] as const) {
    for (const [name, binding, text, warn] of BINDING_LINES) {
      test(`reads for a ${name} binding on ${surface}`, async ($, on) => {
        const world = setup(on, { binding }, "");
        await runBash($, world, STAGE);

        const found = await (await mountBand($, surface)).find({ type: "Text", text });
        expect(found).toBeTruthy();
        expect(found?.props.color !== undefined).toBe(warn);
      });
    }

    test(`says attachments were added to the PR on ${surface}`, async ($, on) => {
      const world = setup(on, { counts: { "feat/x": 3 }, promote: "ok" }, "");
      await runBash($, world, STAGE);
      world.output.text = PR_OUTPUT;
      await runBash($, world, "gh pr create --fill");

      expect(
        await (await mountBand($, surface)).find({ text: /^\s*3 attachments added to PR #1051$/ }),
      ).toBeTruthy();
    });
  }
});

describe("desktop band", () => {
  test("shows thumbnails, the overflow count, View and a dismiss button", async ($, on) => {
    const world = setup(on, {
      counts: { "feat/x": 6 },
      files: Array.from({ length: 6 }, (_, n) => ({ filename: `s${n}.png` })),
    });
    await runBash($, world, STAGE);

    const ui = await mountBand($, "desktop");
    // The mark and four thumbnails.
    expect(await ui.findAll({ type: "Svg" })).toHaveLength(5);
    expect(await ui.find({ type: "Text", text: "+2" })).toBeTruthy();
    expect(await ui.find({ type: "Button", text: "View" })).toBeTruthy();
    const hide = await ui.find({ type: "Button", text: "Hide" });
    expect(hide?.props.role).toBe("dismiss");
    // The terminal keeps its own band: no thumbnails, no View.
    const terminal = await mountBand($, "terminal");
    expect(await terminal.find({ type: "Button", text: "View" })).toBeUndefined();
  });

  test("hides until the staged set changes", async ($, on) => {
    const world = setup(on, { counts: { "feat/x": 1 } });
    await runBash($, world, STAGE);

    const ui = await mountBand($, "desktop");
    await ui.press({ key: "hide" });
    expect(
      await (await mountBand($, "desktop")).find({ text: /waiting for a PR/ }),
    ).toBeUndefined();

    // Same set, refreshed: still hidden.
    await runBash($, world, STAGE);
    expect(
      await (await mountBand($, "desktop")).find({ text: /waiting for a PR/ }),
    ).toBeUndefined();

    // A new file changes the set.
    world.cli.counts["feat/x"] = 2;
    await runBash($, world, STAGE);
    expect(
      await (await mountBand($, "desktop")).find({ text: /2 attachments waiting for a PR/ }),
    ).toBeTruthy();
  });

  test("View opens the pane", async ($, on) => {
    const world = setup(on);
    await runBash($, world, STAGE);

    await (await mountBand($, "desktop")).press({ key: "view" });

    expect(world.opened).toEqual(["uploads-staged:Staged attachments"]);
  });
});

describe("staged pane", () => {
  const pairFiles = [
    { filename: "home-before.png" },
    { filename: "home-after.png" },
    { filename: "solo.png" },
    { filename: "notes.txt" },
  ];

  test("draws a grid: pairs as one tile, singles, file cards, footnote", async ($, on) => {
    const world = setup(on, { counts: { "feat/x": 4 }, files: pairFiles });
    await runBash($, world, STAGE);

    const ui = await mountPane($);
    // Tiles for home (pair), solo and notes.txt.
    expect(await ui.findAll({ type: "Svg" })).toHaveLength(3);
    expect(
      await ui.find({ text: "4 attachments waiting for a PR · link the repo to auto-attach" }),
    ).toBeTruthy();
    expect(await ui.find({ text: /buildinternet\/uploads · feat\/x/ })).toBeTruthy();
    expect(await ui.find({ type: "Button", text: "Copy markdown" })).toBeTruthy();
    expect(await ui.find({ text: "5m ago" })).toBeTruthy();
    expect(
      await ui.find({ text: "Hosted on uploads.sh, not committed to the repo." }),
    ).toBeTruthy();
    // No open PR: no feed button.
    expect(await ui.find({ type: "Button", text: "Copy link" })).toBeUndefined();
    // The pair tile carries a chip for each half; the txt tile is a file card.
    const drawn = JSON.stringify(await ui.drawn());
    expect(drawn).toContain("Before");
    expect(drawn).toContain("After");
    expect(drawn).toContain("TXT");
  });

  test("falls back to a file card when a thumbnail fails", async ($, on) => {
    const world = setup(on, { thumbsFail: true, files: [{ filename: "a.png" }] });
    await runBash($, world, STAGE);

    const drawn = JSON.stringify(await (await mountPane($)).drawn());
    expect(drawn).toContain("PNG");
    expect(drawn).not.toContain("data:image/jpeg");
  });

  test("draws thumbnails as JPEG data URIs fetched through the image transform", async ($, on) => {
    const world = setup(on, { files: [{ filename: "a.png" }] });
    await runBash($, world, STAGE);

    expect(JSON.stringify(await (await mountPane($)).drawn())).toContain(
      "data:image/jpeg;base64,AAAABBBB",
    );
    const fetch = world.argvs.find((argv) => argv[0] === "sh");
    expect(fetch?.at(-1)).toContain(
      "/cdn-cgi/image/width=360,fit=scale-down,format=jpeg,quality=70/",
    );
  });

  test("on the terminal the grid has no images", async ($, on) => {
    const world = setup(on, { counts: { "feat/x": 2 }, files: pairFiles.slice(0, 2) });
    await runBash($, world, STAGE);

    const ui = await mountPane($, "terminal");
    expect(await ui.findAll({ type: "Svg" })).toEqual([]);
    expect(await ui.find({ type: "Button", text: "home" })).toBeTruthy();
  });

  test("copies the PR feed link when the branch has an open PR", async ($, on) => {
    const world = setup(on, { openPr: 12 });
    const copied: string[] = [];
    on("ui.copy", async (_$, e) => {
      copied.push(e.text);
      return { value: undefined } as never;
    });
    await runBash($, world, STAGE);

    const ui = await mountPane($);
    await ui.press({ key: "feed" });

    expect(world.argvs).toContainEqual(["uploads", "feed", "create", "--repo", REPO, "--pr", "12"]);
    expect(copied).toEqual(["https://uploads.sh/feed/abc"]);
    expect(world.toasts).toContainEqual("Copied the PR feed link");
    expect(await ui.find({ type: "Link" })).toBeTruthy();
  });

  test("opens a row in the same pane, then returns to the grid", async ($, on) => {
    const world = setup(on, { counts: { "feat/x": 2 }, files: pairFiles.slice(0, 2) });
    await runBash($, world, STAGE);

    const detail = await mountPane($);
    await detail.press({ key: "name-0" });

    expect(await detail.find({ type: "Button", text: "← All attachments" })).toBeTruthy();
    expect(await detail.find({ type: "Button", text: "Copy markdown" })).toBeTruthy();
    expect(await detail.find({ type: "Button", text: "Remove" })).toBeTruthy();
    expect(await detail.find({ text: "Before" })).toBeTruthy();
    expect(await detail.findAll({ type: "Link", text: "Open on uploads.sh" })).toHaveLength(2);

    await detail.press({ key: "back" });
    expect(await detail.find({ text: /Hosted on uploads.sh/ })).toBeTruthy();
  });

  test("explains a file that can't be previewed", async ($, on) => {
    const world = setup(on, { files: [{ filename: "notes.txt" }] });
    await runBash($, world, STAGE);
    const detail = await mountPane($);
    await detail.press({ key: "name-0" });

    expect(await detail.find({ text: "notes.txt can't be previewed here." })).toBeTruthy();
    expect(await detail.find({ type: "Link" })).toBeTruthy();
  });

  test("Remove deletes each file, then shows the grid", async ($, on) => {
    const world = setup(on, { counts: { "feat/x": 2 }, files: pairFiles.slice(0, 2) });
    await runBash($, world, STAGE);
    const ui = await mountPane($);
    await ui.press({ key: "name-0" });
    await ui.press({ key: "remove" });

    expect(world.argvs.filter((argv) => argv[1] === "delete").map((argv) => argv[2])).toEqual([
      "gh/x/home-before.png",
      "gh/x/home-after.png",
    ]);
    expect(await ui.find({ text: /Hosted on uploads.sh|Nothing staged/ })).toBeTruthy();
  });
});
