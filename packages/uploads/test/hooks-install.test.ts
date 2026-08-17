import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HOOK_COMMAND, HOOK_INVOCATION, installHookManifests } from "../src/hooks-install.js";

const temps: string[] = [];

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uploads-hooks-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("installHookManifests", () => {
  it("writes nothing when no harness dirs exist", () => {
    expect(installHookManifests({ home: tempHome() })).toEqual([]);
  });

  it("does not write Codex (plugin owns that path)", () => {
    const home = tempHome();
    fs.mkdirSync(path.join(home, ".codex"));
    expect(installHookManifests({ home })).toEqual([]);
  });

  it("writes a dedicated Grok hooks file", () => {
    const home = tempHome();
    fs.mkdirSync(path.join(home, ".grok"));
    const results = installHookManifests({ home });
    expect(results).toHaveLength(1);
    expect(results[0]!.action).toBe("wrote");
    const file = path.join(home, ".grok", "hooks", "uploads-pre-pr-screenshot.json");
    expect(fs.readFileSync(file, "utf8")).toContain(HOOK_COMMAND);
    expect(installHookManifests({ home })[0]!.action).toBe("skipped");
  });

  it("merges Cursor beforeShellExecution without clobbering", () => {
    const home = tempHome();
    fs.mkdirSync(path.join(home, ".cursor"));
    const file = path.join(home, ".cursor", "hooks.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        hooks: { afterFileEdit: [{ command: "echo other" }] },
      }),
    );
    const results = installHookManifests({ home, targets: ["cursor"] });
    expect(results[0]!.action).toBe("merged");
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      hooks: {
        afterFileEdit: unknown[];
        beforeShellExecution: Array<{ command: string }>;
      };
    };
    expect(parsed.hooks.afterFileEdit).toHaveLength(1);
    expect(parsed.hooks.beforeShellExecution[0]!.command).toBe(HOOK_COMMAND);
  });

  it("dry-run does not write", () => {
    const home = tempHome();
    fs.mkdirSync(path.join(home, ".grok"));
    expect(installHookManifests({ home, dryRun: true })[0]!.action).toBe("would-write");
    expect(fs.existsSync(path.join(home, ".grok", "hooks", "uploads-pre-pr-screenshot.json"))).toBe(
      false,
    );
  });

  it("upgrades a Grok file that still has the bare invocation", () => {
    const home = tempHome();
    const file = path.join(home, ".grok", "hooks", "uploads-pre-pr-screenshot.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ command: HOOK_INVOCATION }), "utf8");
    expect(installHookManifests({ home })[0]!.action).toBe("merged");
    expect(fs.readFileSync(file, "utf8")).toContain(HOOK_COMMAND);
    expect(installHookManifests({ home })[0]!.action).toBe("skipped");
  });

  it("replaces a Cursor bare invocation instead of adding a second hook", () => {
    const home = tempHome();
    const file = path.join(home, ".cursor", "hooks.json");
    fs.mkdirSync(path.join(home, ".cursor"));
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        hooks: { beforeShellExecution: [{ command: HOOK_INVOCATION, timeout: 15 }] },
      }),
    );
    expect(installHookManifests({ home, targets: ["cursor"] })[0]!.action).toBe("merged");
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      hooks: { beforeShellExecution: Array<{ command: string }> };
    };
    expect(parsed.hooks.beforeShellExecution).toHaveLength(1);
    expect(parsed.hooks.beforeShellExecution[0]!.command).toBe(HOOK_COMMAND);
  });

  it("shared hooks.json uses the fail-open command", () => {
    const file = path.join(import.meta.dirname, "../../../hooks/hooks.json");
    expect(fs.readFileSync(file, "utf8")).toContain(HOOK_COMMAND);
  });

  it("is a silent no-op when uploads is not on PATH", () => {
    const emptyPath = fs.mkdtempSync(path.join(os.tmpdir(), "uploads-empty-path-"));
    temps.push(emptyPath);
    const result = spawnSync("/bin/sh", ["-c", HOOK_COMMAND], {
      env: { ...process.env, PATH: emptyPath },
      encoding: "utf8",
      timeout: 5_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });
});
