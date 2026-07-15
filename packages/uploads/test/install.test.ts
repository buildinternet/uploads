import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandRunner } from "../src/github-gh.js";
import { runInstall, DEFAULT_MCP_URL } from "../src/commands/install.js";

function fakeRunner() {
  const calls: string[][] = [];
  const run: CommandRunner = (cmd, args) => {
    calls.push([cmd, ...args]);
    return "installed\nwith multi-line child output\n";
  };
  return { run, calls };
}

function captureStreams() {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  return { out, err };
}

const GLOBALS = { apiUrl: "https://x.test", token: "up_acme_secret" };

beforeEach(() => {
  vi.stubEnv("BUILDINTERNET_CONFIG", "/nonexistent/uploads-install-test-config");
  vi.stubEnv("UPLOADS_TOKEN", "");
  vi.stubEnv("UPLOADS_WORKSPACE", "");
  captureStreams();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("uploads install", () => {
  it("runs both steps by default: npx skills add and claude mcp add", async () => {
    const { run, calls } = fakeRunner();
    const code = await runInstall([], { globals: GLOBALS, runner: run });
    expect(code).toBe(0);
    expect(calls).toEqual([
      [
        "npx",
        "-y",
        "skills",
        "add",
        "buildinternet/uploads",
        "--skill",
        "uploads-cli",
        "-g",
        "-y",
        "-a",
        "*",
      ],
      [
        "npx",
        "-y",
        "skills",
        "add",
        "buildinternet/uploads",
        "--skill",
        "github-screenshots",
        "-g",
        "-y",
        "-a",
        "*",
      ],
      [
        "claude",
        "mcp",
        "add",
        "--transport",
        "http",
        "uploads",
        DEFAULT_MCP_URL,
        "--header",
        "Authorization: Bearer up_acme_secret",
      ],
    ]);
  });

  it("prints step progress and suppresses child output on success", async () => {
    const { run } = fakeRunner();
    const { out, err } = captureStreams();
    const code = await runInstall([], { globals: GLOBALS, runner: run });
    expect(code).toBe(0);
    const printed = out.join("");
    expect(printed).toContain("Installing skills…");
    expect(printed).toContain("Installing MCP server…");
    expect(printed).toMatch(/skill:uploads-cli: ok/);
    expect(printed).toMatch(/skill:github-screenshots: ok/);
    expect(printed).toMatch(/mcp: ok/);
    // Child process noise stays out of the happy path.
    expect(printed).not.toContain("multi-line child output");
    expect(printed).not.toContain("claude mcp add");
    expect(printed).toContain("Restart your agent session");
    expect(printed).toMatch(/upload this screenshot/i);
    expect(err.join("")).toBe("");
  });

  it("--verbose includes child output on success", async () => {
    const { run } = fakeRunner();
    const { out } = captureStreams();
    expect(await runInstall(["--verbose"], { globals: GLOBALS, runner: run })).toBe(0);
    expect(out.join("")).toContain("multi-line child output");
  });

  it("install skill runs only the skills step", async () => {
    const { run, calls } = fakeRunner();
    expect(await runInstall(["skill"], { globals: GLOBALS, runner: run })).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c[0] === "npx")).toBe(true);
  });

  it("skill-only success still nudges login when unsigned", async () => {
    const { run } = fakeRunner();
    const { out } = captureStreams();
    expect(
      await runInstall(["skill"], { globals: { apiUrl: "https://x.test" }, runner: run }),
    ).toBe(0);
    expect(out.join("")).toMatch(/uploads login/);
  });

  it("install mcp honors --url and --name", async () => {
    const { run, calls } = fakeRunner();
    const code = await runInstall(["mcp", "--url", "https://mcp.uploads.sh/mcp", "--name", "up"], {
      globals: GLOBALS,
      runner: run,
    });
    expect(code).toBe(0);
    expect(calls[0]).toContain("https://mcp.uploads.sh/mcp");
    expect(calls[0]).toContain("up");
  });

  it("--dry-run runs nothing and never prints the token", async () => {
    const { run, calls } = fakeRunner();
    const { out } = captureStreams();
    const code = await runInstall(["--dry-run"], { globals: GLOBALS, json: true, runner: run });
    expect(code).toBe(0);
    expect(calls).toEqual([]);
    const printed = out.join("");
    expect(printed).not.toContain("up_acme_secret");
    expect(printed).toContain("Bearer ***");
  });

  it("install mcp without a token skips with a login nudge (no crash, not 'failed')", async () => {
    const { run, calls } = fakeRunner();
    const { out, err } = captureStreams();
    const code = await runInstall(["mcp"], {
      globals: { apiUrl: "https://x.test" },
      runner: run,
    });
    expect(code).toBe(1);
    expect(calls).toEqual([]);
    const printed = out.join("");
    expect(printed).toMatch(/mcp: skipped/);
    expect(printed).toMatch(/uploads login/);
    expect(printed).not.toMatch(/mcp: failed/);
    expect(err.join("")).not.toMatch(/error:/i);
  });

  it("install all without a token still installs the skill, then nudges login for MCP", async () => {
    const { run, calls } = fakeRunner();
    const { out, err } = captureStreams();
    const code = await runInstall(["all"], {
      globals: { apiUrl: "https://x.test" },
      runner: run,
    });
    expect(code).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c[0] === "npx")).toBe(true);
    expect(out.join("")).toMatch(/skill:uploads-cli: ok/);
    expect(out.join("")).toMatch(/skill:github-screenshots: ok/);
    expect(out.join("")).toMatch(/mcp: skipped/);
    expect(out.join("")).not.toMatch(/mcp: failed/);
    expect(out.join("")).toMatch(/uploads login/);
    expect(out.join("")).toMatch(/Skills are installed/);
    expect(err.join("")).not.toMatch(/error:/i);
  });

  it("reports a missing binary with a manual-command hint, redacted, and exits 1", async () => {
    const enoent: CommandRunner = () => {
      const err = new Error("spawn claude ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    };
    const { err } = captureStreams();
    const code = await runInstall(["mcp"], { globals: GLOBALS, runner: enoent });
    expect(code).toBe(1);
    const printed = err.join("");
    expect(printed).toContain("claude not found on PATH");
    expect(printed).not.toContain("up_acme_secret");
    // Full command (with token) only with --verbose; still redacted if shown.
    expect(printed).not.toContain("Bearer up_acme");
  });

  it("rejects unknown targets", async () => {
    const { run } = fakeRunner();
    await expect(runInstall(["nope"], { globals: GLOBALS, runner: run })).rejects.toThrow(
      /unknown install target/,
    );
  });

  it("--json reports each skill step under its own key", async () => {
    const { run } = fakeRunner();
    const { out } = captureStreams();
    const code = await runInstall(["skill"], { globals: GLOBALS, json: true, runner: run });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join(""));
    expect(parsed.ok).toBe(true);
    expect(Object.keys(parsed.steps)).toEqual(["skill:uploads-cli", "skill:github-screenshots"]);
  });

  it("mixed skill success/failure prints closing guidance (issue #191)", async () => {
    let skillCalls = 0;
    const run: CommandRunner = (cmd) => {
      if (cmd === "npx") {
        skillCalls += 1;
        if (skillCalls === 2) throw new Error("skills add failed for github-screenshots");
        return "ok\n";
      }
      return "mcp ok\n";
    };
    const { out, err } = captureStreams();
    const code = await runInstall(["skill"], { globals: GLOBALS, runner: run });
    expect(code).toBe(1);
    expect(out.join("")).toMatch(/skill:uploads-cli: ok/);
    expect(err.join("")).toMatch(/skill:github-screenshots: failed/);
    expect(out.join("")).toMatch(/Skill install incomplete/);
    expect(out.join("")).toMatch(/uploads install skill/);
  });
});
