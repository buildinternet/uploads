import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgv } from "../src/cli-args.js";
import { formatRootHelp, wantsFullHelp } from "../src/cli-help.js";
import { colorEnabled, createStyle } from "../src/cli-style.js";
import { runCli } from "../src/cli.js";

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

describe("formatRootHelp", () => {
  it("shows essentials by default without the full catalog", () => {
    const text = formatRootHelp({ color: false });
    expect(text).toMatch(/Essentials:/);
    expect(text).toMatch(/put <file>/);
    expect(text).toMatch(/attach <file\.\.\.>/);
    expect(text).toMatch(/uploads help --all/);
    // install ships multiple agent skills — keep catalog/help plural (#189 drift).
    expect(text).toMatch(/agent skills/);
    expect(text).not.toMatch(/purge-expired/);
    expect(text).not.toMatch(/ADMIN_TOKEN/);
    expect(text).not.toMatch(/BUILDINTERNET_CONFIG/);
  });

  it("shows the full command list with full: true", () => {
    const text = formatRootHelp({ full: true, color: false });
    expect(text).toMatch(/Commands:/);
    expect(text).toMatch(/purge-expired/);
    expect(text).toMatch(/gallery/);
    expect(text).toMatch(/admin/);
    expect(text).toMatch(/BUILDINTERNET_CONFIG/);
    expect(text).toMatch(/help --all/);
    expect(text).toMatch(/agent skills/);
  });

  it("emits ANSI hierarchy when color is on", () => {
    const text = formatRootHelp({ color: true });
    expect(text).toContain("\u001b[");
    expect(text).toMatch(/Essentials:/);
    // Brand accent violet (#c27eff) on section headings
    expect(text).toContain("\u001b[38;2;194;126;255m");
  });
});

describe("wantsFullHelp", () => {
  it("accepts --all, -a, and all", () => {
    expect(wantsFullHelp(["--all"])).toBe(true);
    expect(wantsFullHelp(["-a"])).toBe(true);
    expect(wantsFullHelp(["all"])).toBe(true);
    expect(wantsFullHelp([])).toBe(false);
    expect(wantsFullHelp(["--json"])).toBe(false);
  });
});

describe("cli-style color detection", () => {
  it("disables color when NO_COLOR is set", () => {
    expect(colorEnabled({ isTTY: true }, { NO_COLOR: "1" })).toBe(false);
  });

  it("enables color with FORCE_COLOR even when not a TTY", () => {
    expect(colorEnabled({ isTTY: false }, { FORCE_COLOR: "1" })).toBe(true);
  });

  it("follows isTTY when env is neutral", () => {
    expect(colorEnabled({ isTTY: true }, {})).toBe(true);
    expect(colorEnabled({ isTTY: false }, {})).toBe(false);
  });

  it("createStyle is a no-op when disabled", () => {
    const s = createStyle(false);
    expect(s.heading("Commands:")).toBe("Commands:");
    expect(s.enabled).toBe(false);
  });
});

describe("parseArgv --all", () => {
  it("accepts --all as a global before the command", () => {
    expect(parseArgv(["node", "uploads", "--all", "--help"]).globals.all).toBe(true);
    expect(parseArgv(["node", "uploads", "--help", "--all"]).globals.all).toBe(true);
  });
});

describe("runCli help", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts the help command (alias for root help)", async () => {
    const io = captureStdio();
    const code = await runCli(["node", "uploads", "help"]);
    expect(code).toBe(0);
    expect(io.stderr()).toMatch(/Essentials:/);
    expect(io.stderr()).not.toMatch(/unknown command/);
    expect(io.stderr()).not.toMatch(/purge-expired/);
  });

  it("shows full help with help --all", async () => {
    const io = captureStdio();
    const code = await runCli(["node", "uploads", "help", "--all"]);
    expect(code).toBe(0);
    expect(io.stderr()).toMatch(/purge-expired/);
    expect(io.stderr()).toMatch(/Commands:/);
  });

  it("shows full help with --help --all", async () => {
    const io = captureStdio();
    const code = await runCli(["node", "uploads", "--help", "--all"]);
    expect(code).toBe(0);
    expect(io.stderr()).toMatch(/purge-expired/);
  });

  it("prints essentials and exits 2 on bare uploads", async () => {
    const io = captureStdio();
    const code = await runCli(["node", "uploads"]);
    expect(code).toBe(2);
    expect(io.stderr()).toMatch(/Essentials:/);
    expect(io.stderr()).not.toMatch(/ADMIN_TOKEN/);
  });

  it("exits 0 on --help with essentials only", async () => {
    const io = captureStdio();
    const code = await runCli(["node", "uploads", "--help"]);
    expect(code).toBe(0);
    expect(io.stderr()).toMatch(/Essentials:/);
    expect(io.stderr()).not.toMatch(/reconcile/);
  });

  it("unknown command shows essentials (not the full dump)", async () => {
    const io = captureStdio();
    const code = await runCli(["node", "uploads", "not-a-real-command"]);
    expect(code).toBe(2);
    expect(io.stderr()).toMatch(/unknown command: not-a-real-command/);
    expect(io.stderr()).toMatch(/Essentials:/);
    expect(io.stderr()).not.toMatch(/BUILDINTERNET_CONFIG/);
  });
});
