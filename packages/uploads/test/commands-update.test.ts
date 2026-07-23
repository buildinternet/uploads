import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandRunner } from "../src/github-gh.js";
import type { InstallSource } from "../src/install-source.js";
import { runUpdate } from "../src/commands/update.js";

const GLOBAL_SOURCE: InstallSource = {
  kind: "global",
  manager: "npm",
  upgradeCommand: ["npm", "install", "-g", "@buildinternet/uploads@latest"],
};

const WORKSPACE_SOURCE: InstallSource = {
  kind: "workspace",
  manager: "npm",
  upgradeCommand: ["npm", "install", "-g", "@buildinternet/uploads@latest"],
};

const GLOBALS = { apiUrl: "https://x.test", token: "up_acme_secret" };

function fakeRunner(fail?: { onCommand: string; message: string }) {
  const calls: string[][] = [];
  const run: CommandRunner = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (fail && cmd === fail.onCommand) throw new Error(fail.message);
    return "ok\n";
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

const outdated = async () => ({ current: "0.9.0", latest: "0.10.0", updateAvailable: true });
const current = async () => ({ current: "0.10.0", latest: "0.10.0", updateAvailable: false });

beforeEach(() => {
  vi.stubEnv("BUILDINTERNET_CONFIG", "/nonexistent/uploads-update-test-config");
  vi.stubEnv("UPLOADS_TOKEN", "");
  vi.stubEnv("UPLOADS_WORKSPACE", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("uploads update", () => {
  it("upgrades, then refreshes by spawning the new binary", async () => {
    captureStreams();
    const { run, calls } = fakeRunner();
    const code = await runUpdate([], {
      globals: GLOBALS,
      runner: run,
      source: GLOBAL_SOURCE,
      check: outdated,
    });
    expect(code).toBe(0);
    expect(calls[0]).toEqual(["npm", "install", "-g", "@buildinternet/uploads@latest"]);
    expect(calls[1]).toEqual(["uploads", "install"]);
  });

  it("skips the upgrade when already current but still refreshes in process", async () => {
    captureStreams();
    const { run, calls } = fakeRunner();
    const code = await runUpdate([], {
      globals: GLOBALS,
      runner: run,
      source: GLOBAL_SOURCE,
      check: current,
    });
    expect(code).toBe(0);
    expect(calls.some((c) => c[0] === "npm")).toBe(false);
    // In-process runInstall reaches the same runner with the install steps.
    expect(calls.some((c) => c[0] === "npx" && c.includes("skills"))).toBe(true);
    expect(calls).not.toContainEqual(["uploads", "install"]);
  });

  it("reports the current version when nothing to upgrade", async () => {
    const { out } = captureStreams();
    const { run } = fakeRunner();
    await runUpdate([], {
      globals: GLOBALS,
      runner: run,
      source: GLOBAL_SOURCE,
      check: current,
    });
    expect(out.join("")).toMatch(/CLI already at 0\.10\.0/);
  });

  it("refuses the upgrade outside a global install but still refreshes", async () => {
    const { out } = captureStreams();
    const { run, calls } = fakeRunner();
    const code = await runUpdate([], {
      globals: GLOBALS,
      runner: run,
      source: WORKSPACE_SOURCE,
      check: outdated,
    });
    expect(code).toBe(0);
    expect(calls.some((c) => c[0] === "npm")).toBe(false);
    expect(out.join("")).toMatch(/workspace checkout/);
  });

  it("aborts before the refresh when the upgrade fails", async () => {
    const { err } = captureStreams();
    const { run, calls } = fakeRunner({ onCommand: "npm", message: "boom" });
    const code = await runUpdate([], {
      globals: GLOBALS,
      runner: run,
      source: GLOBAL_SOURCE,
      check: outdated,
    });
    expect(code).toBe(1);
    expect(calls).toEqual([["npm", "install", "-g", "@buildinternet/uploads@latest"]]);
    expect(err.join("")).toMatch(/npm install -g @buildinternet\/uploads@latest/);
  });

  it("explains a permissions failure", async () => {
    const { err } = captureStreams();
    const { run } = fakeRunner({ onCommand: "npm", message: "EACCES: permission denied" });
    const code = await runUpdate([], {
      globals: GLOBALS,
      runner: run,
      source: GLOBAL_SOURCE,
      check: outdated,
    });
    expect(code).toBe(1);
    expect(err.join("")).toMatch(/without sudo/);
  });

  it("--dry-run prints the plan and runs nothing", async () => {
    const { out } = captureStreams();
    const { run, calls } = fakeRunner();
    const code = await runUpdate(["--dry-run"], {
      globals: GLOBALS,
      runner: run,
      source: GLOBAL_SOURCE,
      check: outdated,
    });
    expect(code).toBe(0);
    expect(calls).toEqual([]);
    expect(out.join("")).toMatch(/would run — npm install -g/);
    expect(out.join("")).toMatch(/would run — uploads install/);
  });

  it("--skip-install upgrades only", async () => {
    captureStreams();
    const { run, calls } = fakeRunner();
    const code = await runUpdate(["--skip-install"], {
      globals: GLOBALS,
      runner: run,
      source: GLOBAL_SOURCE,
      check: outdated,
    });
    expect(code).toBe(0);
    expect(calls).toEqual([["npm", "install", "-g", "@buildinternet/uploads@latest"]]);
  });

  it("rejects an unknown positional", async () => {
    captureStreams();
    const { run } = fakeRunner();
    await expect(
      runUpdate(["bogus"], {
        globals: GLOBALS,
        runner: run,
        source: GLOBAL_SOURCE,
        check: current,
      }),
    ).rejects.toThrow(/takes no arguments/);
  });
});
