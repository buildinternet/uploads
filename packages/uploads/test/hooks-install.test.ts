import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HOOK_COMMAND, installHookManifests } from "../src/hooks-install.js";

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
});
