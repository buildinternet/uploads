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
    expect(script).toMatch(/local -a root_cmds=\(attach put screenshot gallery/);
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
