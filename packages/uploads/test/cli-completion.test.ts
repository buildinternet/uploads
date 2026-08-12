import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";
import { generateCompletionScript, runCompletion } from "../src/commands/completion.js";
import { ROOT_COMMANDS } from "../src/cli-catalog.js";

function captureStdio() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  return {
    stdout: () => stdout.join(""),
    stderr: () => stderr.join(""),
  };
}

describe("generateCompletionScript", () => {
  it("bash script registers complete -F and lists root commands", () => {
    const script = generateCompletionScript("bash");
    expect(script).toMatch(/complete -o default -F _uploads uploads/);
    expect(script).toMatch(/local -a root_cmds=\(attach put staged screenshot annotate gallery/);
    for (const cmd of ROOT_COMMANDS) {
      expect(script).toContain(cmd.name);
    }
    expect(script).toMatch(/gallery\) subs="create show list delete add link unlink"/);
  });

  it("zsh script is #compdef and describes commands", () => {
    const script = generateCompletionScript("zsh");
    expect(script.startsWith("#compdef uploads")).toBe(true);
    expect(script).toMatch(/_describe -t commands 'uploads command'/);
    expect(script).toMatch(/'put:Upload/);
    expect(script).toMatch(/gallery\)/);
    expect(script).toMatch(/'create:Create a gallery'/);
  });

  it("fish script uses complete -c uploads", () => {
    const script = generateCompletionScript("fish");
    expect(script).toMatch(/complete -c uploads -n '__fish_use_subcommand' -a 'put'/);
    expect(script).toMatch(
      /complete -c uploads -n '__fish_seen_subcommand_from gallery' -a 'create'/,
    );
    expect(script).toMatch(/__fish_seen_subcommand_from put attach/);
  });

  it("screenshot completions use their own explicit flag list, not put's --name/--no-comment", () => {
    const bash = generateCompletionScript("bash");
    const screenshotVarMatch = /local -a screenshot_flags=\(([^)]*)\)/.exec(bash);
    expect(screenshotVarMatch).not.toBeNull();
    const screenshotFlags = screenshotVarMatch![1]!.split(" ");
    expect(screenshotFlags).toContain("--key");
    expect(screenshotFlags).toContain("--via");
    expect(screenshotFlags).not.toContain("--name");
    expect(screenshotFlags).not.toContain("--no-comment");

    const fish = generateCompletionScript("fish");
    expect(fish).toMatch(/complete -c uploads -n '__fish_seen_subcommand_from screenshot' -l key/);
    expect(fish).not.toMatch(
      /complete -c uploads -n '__fish_seen_subcommand_from screenshot' -l name/,
    );
    // put/attach still get their own flags, without screenshot in that group.
    expect(fish).toMatch(/__fish_seen_subcommand_from put attach' -l name/);
  });

  it("includes the update command", () => {
    expect(ROOT_COMMANDS.map((c) => c.name)).toContain("update");
  });

  it("continues every _arguments spec line so zsh keeps one command", () => {
    const script = generateCompletionScript("zsh");
    const block = /^ {2}_arguments -C -s -S \\\n((?: {4}.*\n)+)/m.exec(script);
    expect(block).not.toBeNull();
    const lines = block![1]!.trimEnd().split("\n");
    // Every line but the last must end in a continuation; otherwise zsh ends the
    // _arguments call early and tries to execute the remaining specs as commands.
    for (const line of lines.slice(0, -1)) {
      expect(line.endsWith(" \\")).toBe(true);
    }
    expect(lines.at(-1)).toMatch(/'\*::arg:->args'$/);
    expect(lines.length).toBeGreaterThan(3);
  });

  it("pairs short flags with their long form, using the long summary", () => {
    const script = generateCompletionScript("zsh");
    expect(script).toContain("'(-w --workspace)'{-w,--workspace}'[Workspace name]:workspace:'");
    expect(script).toContain("'(-h --help)'{-h,--help}'[Show help]'");
    // The "(short)" catalog summaries are an artifact of the flag list, not copy
    // a user should ever see in a completion menu.
    expect(script).not.toMatch(/\(short\)/);
  });

  for (const [shell, bin, args] of [
    ["zsh", "zsh", ["-n"]],
    ["bash", "bash", ["-n"]],
  ] as const) {
    it(`${shell} script parses under ${bin} ${args.join(" ")}`, () => {
      const which = spawnSync("command", ["-v", bin], { shell: true });
      if (which.status !== 0) return; // shell not installed on this machine
      const script = generateCompletionScript(shell);
      const file = join(mkdtempSync(join(tmpdir(), "uploads-completion-")), `script.${shell}`);
      writeFileSync(file, script);
      const run = spawnSync(bin, [...args, file], { encoding: "utf8" });
      expect(run.stderr.trim()).toBe("");
      expect(run.status).toBe(0);
    });
  }
});

describe("runCompletion", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes the script to stdout", async () => {
    const io = captureStdio();
    const code = await runCompletion(["bash"]);
    expect(code).toBe(0);
    expect(io.stdout()).toMatch(/complete -o default -F _uploads uploads/);
    expect(io.stderr()).toBe("");
  });

  it("prints help and exits 0 with --help", async () => {
    const io = captureStdio();
    const code = await runCompletion([], true);
    expect(code).toBe(0);
    expect(io.stderr()).toMatch(/uploads completion <shell>/);
  });

  it("exits 2 when shell is missing", async () => {
    const io = captureStdio();
    const code = await runCompletion([]);
    expect(code).toBe(2);
    expect(io.stderr()).toMatch(/bash/);
  });

  it("rejects unknown shells", async () => {
    await expect(runCompletion(["powershell"])).rejects.toThrow(/unknown shell/);
  });
});

describe("runCli completion", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts completion and completions aliases", async () => {
    const io = captureStdio();
    expect(await runCli(["node", "uploads", "completion", "zsh"])).toBe(0);
    expect(io.stdout()).toMatch(/#compdef uploads/);

    vi.restoreAllMocks();
    const io2 = captureStdio();
    expect(await runCli(["node", "uploads", "completions", "fish"])).toBe(0);
    expect(io2.stdout()).toMatch(/complete -c uploads/);
  });

  it("lists completion in full help", async () => {
    const io = captureStdio();
    await runCli(["node", "uploads", "help", "--all"]);
    expect(io.stderr()).toMatch(/completion/);
  });
});
