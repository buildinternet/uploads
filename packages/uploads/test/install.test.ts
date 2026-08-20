import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandRunner } from "../src/github-gh.js";
import {
  runInstall,
  DEFAULT_MCP_URL,
  MCP_CLIENTS,
  missingBinaryHint,
  npmTooOldHint,
  probeSkillTooling,
} from "../src/commands/install.js";

/** Answer skill preflight version checks so custom runners reach `skills add`. */
function skillProbeOk(cmd: string, args: string[]): string | undefined {
  if (cmd === "npx" && args[0] === "--version") return "10.9.0\n";
  if (cmd === "npm" && args[0] === "--version") return "10.9.0\n";
  return undefined;
}

function makeEnoent(message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = "ENOENT";
  return err;
}

function fakeRunner() {
  const calls: string[][] = [];
  const run: CommandRunner = (cmd, args) => {
    calls.push([cmd, ...args]);
    return skillProbeOk(cmd, args) ?? "installed\nwith multi-line child output\n";
  };
  return { run, calls };
}

/** Drop skill preflight (`npx/npm --version`) from call logs. */
function withoutSkillProbe(calls: string[][]): string[][] {
  return calls.filter(
    (c) => !(c[0] === "npx" && c[1] === "--version") && !(c[0] === "npm" && c[1] === "--version"),
  );
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

/** Isolated home so hook install never touches the real ~/.grok etc. */
let emptyHome: string;

function install(
  args: string[],
  opts: Parameters<typeof runInstall>[1],
): ReturnType<typeof runInstall> {
  return runInstall(args, { home: emptyHome, ...opts });
}

beforeEach(() => {
  emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "uploads-install-home-"));
  vi.stubEnv("BUILDINTERNET_CONFIG", "/nonexistent/uploads-install-test-config");
  vi.stubEnv("UPLOADS_TOKEN", "");
  vi.stubEnv("UPLOADS_WORKSPACE", "");
  captureStreams();
});

afterEach(() => {
  fs.rmSync(emptyHome, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("uploads install", () => {
  it("runs skill + mcp by default (hooks is a no-op without harness dirs)", async () => {
    const { run, calls } = fakeRunner();
    const code = await install([], { globals: GLOBALS, runner: run });
    expect(code).toBe(0);
    expect(calls[0]).toEqual(["npx", "--version"]);
    expect(calls[1]).toEqual(["npm", "--version"]);
    expect(withoutSkillProbe(calls)).toEqual([
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
        "npx",
        "-y",
        "skills",
        "add",
        "buildinternet/uploads",
        "--skill",
        "annotate-screenshots",
        "-g",
        "-y",
        "-a",
        "*",
      ],
      ...MCP_CLIENTS.map((client) => client.command("uploads", DEFAULT_MCP_URL, "up_acme_secret")),
    ]);
  });

  it("prints step progress and suppresses child output on success", async () => {
    const { run } = fakeRunner();
    const { out, err } = captureStreams();
    const code = await install([], { globals: GLOBALS, runner: run });
    expect(code).toBe(0);
    const printed = out.join("");
    expect(printed).toContain("Installing skills…");
    expect(printed).toContain("Installing MCP server…");
    expect(printed).toMatch(/skill:uploads-cli: ok/);
    expect(printed).toMatch(/skill:github-screenshots: ok/);
    expect(printed).toMatch(/skill:annotate-screenshots: ok/);
    expect(printed).toMatch(/mcp:claude: ok/);
    expect(printed).toMatch(/mcp:codex: ok/);
    expect(printed).toMatch(/mcp:grok: ok/);
    expect(printed).toMatch(/hooks: ok/);
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
    expect(await install(["--verbose"], { globals: GLOBALS, runner: run })).toBe(0);
    expect(out.join("")).toContain("multi-line child output");
  });

  it("install skill runs only the skills step", async () => {
    const { run, calls } = fakeRunner();
    expect(await install(["skill"], { globals: GLOBALS, runner: run })).toBe(0);
    const skillAdds = withoutSkillProbe(calls);
    expect(skillAdds).toHaveLength(3);
    expect(skillAdds.every((c) => c[0] === "npx" && c.includes("skills"))).toBe(true);
  });

  it("skill-only success still nudges login when unsigned", async () => {
    const { run } = fakeRunner();
    const { out } = captureStreams();
    expect(await install(["skill"], { globals: { apiUrl: "https://x.test" }, runner: run })).toBe(
      0,
    );
    expect(out.join("")).toMatch(/uploads login/);
  });

  it("install mcp honors --url and --name", async () => {
    const { run, calls } = fakeRunner();
    const code = await install(["mcp", "--url", "https://mcp.uploads.sh/mcp", "--name", "up"], {
      globals: GLOBALS,
      runner: run,
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(MCP_CLIENTS.length);
    expect(calls[0]).toContain("https://mcp.uploads.sh/mcp");
    expect(calls[0]).toContain("up");
    expect(calls.every((c) => c.includes("https://mcp.uploads.sh/mcp") && c.includes("up"))).toBe(
      true,
    );
  });

  it("install hooks writes manifests when harness dirs exist", async () => {
    fs.mkdirSync(path.join(emptyHome, ".grok"));
    const { run, calls } = fakeRunner();
    const { out } = captureStreams();
    const code = await install(["hooks"], { globals: GLOBALS, runner: run });
    expect(code).toBe(0);
    expect(calls).toEqual([]);
    expect(
      fs.existsSync(path.join(emptyHome, ".grok", "hooks", "uploads-pre-pr-screenshot.json")),
    ).toBe(true);
    expect(out.join("")).toMatch(/hooks:/);
  });

  it("--dry-run runs nothing and never prints the token", async () => {
    const { run, calls } = fakeRunner();
    const { out } = captureStreams();
    const code = await install(["--dry-run"], { globals: GLOBALS, json: true, runner: run });
    expect(code).toBe(0);
    expect(calls).toEqual([]);
    const printed = out.join("");
    expect(printed).not.toContain("up_acme_secret");
    expect(printed).toContain("Bearer ***");
    const parsed = JSON.parse(printed);
    expect(parsed.steps.hooks).toBeDefined();
  });

  it("install mcp without a token skips with a login nudge (no crash, not 'failed')", async () => {
    const { run, calls } = fakeRunner();
    const { out, err } = captureStreams();
    const code = await install(["mcp"], {
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
    const code = await install(["all"], {
      globals: { apiUrl: "https://x.test" },
      runner: run,
    });
    expect(code).toBe(1);
    const skillAdds = withoutSkillProbe(calls);
    expect(skillAdds).toHaveLength(3);
    expect(skillAdds.every((c) => c[0] === "npx" && c.includes("skills"))).toBe(true);
    expect(out.join("")).toMatch(/skill:uploads-cli: ok/);
    expect(out.join("")).toMatch(/skill:github-screenshots: ok/);
    expect(out.join("")).toMatch(/skill:annotate-screenshots: ok/);
    expect(out.join("")).toMatch(/mcp: skipped/);
    expect(out.join("")).not.toMatch(/mcp: failed/);
    expect(out.join("")).toMatch(/uploads login/);
    expect(out.join("")).toMatch(/Skills are installed/);
    expect(err.join("")).not.toMatch(/error:/i);
  });

  it("skips MCP when no agent CLI is on PATH, redacts the token, and exits 0", async () => {
    const enoent: CommandRunner = () => {
      throw makeEnoent("spawn claude ENOENT");
    };
    const { out, err } = captureStreams();
    const code = await install(["mcp"], { globals: GLOBALS, runner: enoent });
    expect(code).toBe(0);
    const printed = out.join("");
    expect(printed).toMatch(/mcp: skipped/);
    expect(printed).toMatch(/no agent CLI on PATH \(claude, codex, grok\)/);
    expect(printed).not.toMatch(/mcp: failed/);
    expect(printed).not.toContain("up_acme_secret");
    expect(printed).not.toContain("Bearer up_acme");
    expect(printed).not.toMatch(/run manually:/i);
    expect(err.join("")).not.toMatch(/error:/i);
  });

  it("a real MCP add error fails that client but still registers the others", async () => {
    const run: CommandRunner = (cmd) => {
      if (cmd === "claude") throw new Error("network down");
      return "ok\n";
    };
    const { out, err } = captureStreams();
    const code = await install(["mcp"], { globals: GLOBALS, runner: run });
    expect(code).toBe(1);
    expect(err.join("")).toMatch(/mcp:claude: failed — network down/);
    expect(out.join("")).toMatch(/mcp:codex: ok/);
    expect(out.join("")).toMatch(/mcp:grok: ok/);
  });

  it("registers MCP with the CLIs that are present and skips missing ones", async () => {
    const calls: string[][] = [];
    const run: CommandRunner = (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === "claude") throw makeEnoent("spawn claude ENOENT");
      return "ok\n";
    };
    const { out, err } = captureStreams();
    const code = await install(["mcp"], { globals: GLOBALS, runner: run });
    expect(code).toBe(0);
    expect(calls.map((c) => c[0])).toEqual(MCP_CLIENTS.map((c) => c.id));
    const printed = out.join("");
    expect(printed).toMatch(/mcp:claude: skipped — claude not found on PATH/);
    expect(printed).toMatch(/mcp:codex: ok/);
    expect(printed).toMatch(/mcp:grok: ok/);
    expect(printed).not.toMatch(/mcp: failed/);
    expect(err.join("")).toBe("");
  });

  it("missing npx short-circuits all skills with one collapsed human error", async () => {
    const calls: string[][] = [];
    const run: CommandRunner = (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === "npx") throw makeEnoent("spawn npx ENOENT");
      return "ok\n";
    };
    const { out, err } = captureStreams();
    const code = await install(["skill"], { globals: GLOBALS, runner: run });
    expect(code).toBe(1);
    expect(calls).toEqual([["npx", "--version"]]);
    const stderr = err.join("");
    expect(stderr).toMatch(/skills: failed —/);
    expect(stderr).toContain("npx not found on PATH");
    expect(stderr).toMatch(/nodejs\.org/i);
    expect(stderr).not.toMatch(/skill:uploads-cli: failed/);
    expect(stderr).not.toMatch(/skill:github-screenshots: failed/);
    expect(stderr).not.toMatch(/run manually:/i);
    expect(out.join("")).toMatch(/working Node\.js toolchain/);
    expect(out.join("")).toMatch(/uploads install skill/);
  });

  it("old npm version blocks skill install before skills add", async () => {
    const calls: string[][] = [];
    const run: CommandRunner = (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === "npx" && args[0] === "--version") return "6.14.18\n";
      if (cmd === "npm" && args[0] === "--version") return "6.14.18\n";
      return "ok\n";
    };
    const { err, out } = captureStreams();
    const code = await install(["skill"], { globals: GLOBALS, runner: run });
    expect(code).toBe(1);
    expect(calls).toEqual([
      ["npx", "--version"],
      ["npm", "--version"],
    ]);
    expect(err.join("")).toMatch(/skills: failed —/);
    expect(err.join("")).toContain(npmTooOldHint("6.14.18"));
    expect(out.join("")).toMatch(/npm 7\+/);
  });

  it("probeSkillTooling and missingBinaryHint are stable for agents/tests", () => {
    expect(missingBinaryHint("npx")).toMatch(/npx not found/);
    expect(missingBinaryHint("claude")).toMatch(/Claude Code CLI/);
    expect(
      probeSkillTooling(() => {
        throw makeEnoent("ENOENT");
      }),
    ).toBe(missingBinaryHint("npx"));
    expect(
      probeSkillTooling((cmd) => {
        if (cmd === "npx") return "10.0.0";
        if (cmd === "npm") return "6.0.0";
        return "";
      }),
    ).toBe(npmTooOldHint("6.0.0"));
    expect(
      probeSkillTooling((cmd) => {
        if (cmd === "npx") return "10.0.0";
        if (cmd === "npm") return "10.0.0";
        return "";
      }),
    ).toBeUndefined();
  });

  it("treats an existing MCP entry as already configured, not a failure", async () => {
    const run: CommandRunner = (cmd) => {
      if (cmd === "claude") {
        throw new Error(
          "Command failed: claude mcp add --transport http uploads\nMCP server uploads already exists in local config\n",
        );
      }
      return "ok\n";
    };
    const { out, err } = captureStreams();
    const code = await install([], { globals: GLOBALS, runner: run });
    expect(code).toBe(0);
    const printed = out.join("");
    expect(printed).toMatch(/mcp:claude: already configured/);
    expect(printed).toMatch(/claude mcp remove uploads/);
    expect(printed).not.toMatch(/mcp: failed/);
    expect(printed).not.toMatch(/Fix the MCP step above/);
    expect(err.join("")).toBe("");
  });

  it("--name is reflected in the already-configured remove hint", async () => {
    const run: CommandRunner = (cmd) => {
      if (cmd === "claude") throw new Error("MCP server up already exists in local config");
      return "ok\n";
    };
    const { out } = captureStreams();
    expect(await install(["mcp", "--name", "up"], { globals: GLOBALS, runner: run })).toBe(0);
    expect(out.join("")).toMatch(/claude mcp remove up /);
  });

  it("--json marks an existing MCP entry ok with an already-configured skip", async () => {
    const run: CommandRunner = (cmd) => {
      if (cmd === "claude") throw new Error("MCP server uploads already exists in local config");
      return "ok\n";
    };
    const { out } = captureStreams();
    const code = await install(["mcp"], { globals: GLOBALS, json: true, runner: run });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join(""));
    expect(parsed.ok).toBe(true);
    expect(parsed.steps["mcp:claude"].ok).toBe(true);
    expect(parsed.steps["mcp:claude"].skipped).toBe("already-configured");
    expect(parsed.steps["mcp:codex"].ok).toBe(true);
    expect(parsed.steps["mcp:grok"].ok).toBe(true);
  });

  it("rejects unknown targets", async () => {
    const { run } = fakeRunner();
    await expect(install(["nope"], { globals: GLOBALS, runner: run })).rejects.toThrow(
      /unknown install target/,
    );
  });

  it("--json reports each skill step under its own key", async () => {
    const { run } = fakeRunner();
    const { out } = captureStreams();
    const code = await install(["skill"], { globals: GLOBALS, json: true, runner: run });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join(""));
    expect(parsed.ok).toBe(true);
    expect(Object.keys(parsed.steps)).toEqual([
      "skill:uploads-cli",
      "skill:github-screenshots",
      "skill:annotate-screenshots",
    ]);
  });

  it("mixed skill success/failure prints closing guidance (issue #191)", async () => {
    let skillAddCalls = 0;
    const run: CommandRunner = (cmd, args) => {
      const probe = skillProbeOk(cmd, args);
      if (probe !== undefined) return probe;
      if (cmd === "npx") {
        skillAddCalls += 1;
        if (skillAddCalls === 2) throw new Error("skills add failed for github-screenshots");
        return "ok\n";
      }
      return "mcp ok\n";
    };
    const { out, err } = captureStreams();
    const code = await install(["skill"], { globals: GLOBALS, runner: run });
    expect(code).toBe(1);
    expect(out.join("")).toMatch(/skill:uploads-cli: ok/);
    expect(err.join("")).toMatch(/skill:github-screenshots: failed/);
    expect(out.join("")).toMatch(/Skill install incomplete/);
    expect(out.join("")).toMatch(/uploads install skill/);
  });

  it("missing agent CLIs after successful skills skip MCP without failing the run", async () => {
    const run: CommandRunner = (cmd, args) => {
      const probe = skillProbeOk(cmd, args);
      if (probe !== undefined) return probe;
      if (MCP_CLIENTS.some((c) => c.id === cmd)) throw makeEnoent(`spawn ${cmd} ENOENT`);
      return "ok\n";
    };
    const { out, err } = captureStreams();
    const code = await install([], { globals: GLOBALS, runner: run });
    expect(code).toBe(0);
    expect(out.join("")).toMatch(/skill:uploads-cli: ok/);
    expect(out.join("")).toMatch(/mcp: skipped/);
    expect(out.join("")).toMatch(/no agent CLI on PATH/);
    expect(out.join("")).toMatch(/Done — skills and hooks ready/);
    expect(out.join("")).not.toMatch(/mcp: failed/);
    expect(err.join("")).not.toMatch(/claude not found on PATH/);
  });

  it("--json marks a missing agent CLI as skipped, not failed", async () => {
    const run: CommandRunner = (cmd, args) => {
      const probe = skillProbeOk(cmd, args);
      if (probe !== undefined) return probe;
      if (cmd === "claude") throw makeEnoent("spawn claude ENOENT");
      return "ok\n";
    };
    const { out } = captureStreams();
    const code = await install(["mcp"], { globals: GLOBALS, json: true, runner: run });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join(""));
    expect(parsed.ok).toBe(true);
    expect(parsed.steps["mcp:claude"].ok).toBe(true);
    expect(parsed.steps["mcp:claude"].skipped).toBe("missing-cli");
    expect(parsed.steps["mcp:codex"].ok).toBe(true);
    expect(parsed.steps["mcp:codex"].skipped).toBeUndefined();
  });
});
