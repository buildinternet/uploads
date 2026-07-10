import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandRunner } from "../src/github-gh.js";
import { runInstall, DEFAULT_MCP_URL } from "../src/commands/install.js";

function fakeRunner() {
  const calls: string[][] = [];
  const run: CommandRunner = (cmd, args) => {
    calls.push([cmd, ...args]);
    return "installed\n";
  };
  return { run, calls };
}

function captureStdout() {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  return chunks;
}

const GLOBALS = { apiUrl: "https://x.test", token: "up_acme_secret" };

beforeEach(() => {
  vi.stubEnv("BUILDINTERNET_CONFIG", "/nonexistent/uploads-install-test-config");
  vi.stubEnv("UPLOADS_TOKEN", "");
  vi.stubEnv("UPLOADS_WORKSPACE", "");
  captureStdout();
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
      ["npx", "-y", "skills", "add", "buildinternet/uploads", "--skill", "uploads-cli"],
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

  it("install skill runs only the skills step", async () => {
    const { run, calls } = fakeRunner();
    expect(await runInstall(["skill"], { globals: GLOBALS, runner: run })).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("npx");
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
    const chunks: string[] = [];
    vi.mocked(process.stdout.write).mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
    const code = await runInstall(["--dry-run"], { globals: GLOBALS, json: true, runner: run });
    expect(code).toBe(0);
    expect(calls).toEqual([]);
    const printed = chunks.join("");
    expect(printed).not.toContain("up_acme_secret");
    expect(printed).toContain("Bearer ***");
  });

  it("install mcp without a token is a tool error, not a crash", async () => {
    const { run } = fakeRunner();
    await expect(
      runInstall(["mcp"], { globals: { apiUrl: "https://x.test" }, runner: run }),
    ).rejects.toThrow(/UPLOADS_TOKEN|token/i);
  });

  it("reports a missing binary with a manual-command hint and exits 1", async () => {
    const enoent: CommandRunner = () => {
      const err = new Error("spawn claude ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    };
    const code = await runInstall(["mcp"], { globals: GLOBALS, runner: enoent });
    expect(code).toBe(1);
  });

  it("rejects unknown targets", async () => {
    const { run } = fakeRunner();
    await expect(runInstall(["nope"], { globals: GLOBALS, runner: run })).rejects.toThrow(
      /unknown install target/,
    );
  });
});
