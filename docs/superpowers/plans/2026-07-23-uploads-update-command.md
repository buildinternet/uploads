# `uploads update` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a single `uploads update` command that upgrades the globally installed npm package and then refreshes the agent skills and MCP registration, so users stop having to know those are two separate things.

**Architecture:** One pure function classifies where the running CLI was installed from. One command file orchestrates three steps — check the published version, upgrade the global package, re-run `install`. When an upgrade actually happened, the refresh runs the _new_ binary as a subprocess so the new version's skill list is the one that gets installed; otherwise it calls `runInstall` in process. Existing update notices are repointed at the new command.

**Tech Stack:** TypeScript (ESM, NodeNext), vitest, oxfmt (auto-applied by the pre-commit hook), changesets.

## Global Constraints

- Package name is exactly `@buildinternet/uploads`. It is already exported as `PACKAGE_NAME` from `src/update-check.ts` — import it, never re-type the literal.
- Every test runs from `packages/uploads`. Test command: `pnpm --filter @buildinternet/uploads test <file>`.
- A changeset is required. Its header must contain only `"@buildinternet/uploads": minor` — a changeset naming any other package silently blocks all publishing.
- No confirmation prompt, no `--yes` flag, and no `--format json` in this command. These were deliberately cut.
- Prose in `docs/` follows the house style in `AGENTS.md` — active voice, one idea per sentence, one term per concept.
- Do not modify anything under `plugins/` or `.claude-plugin/`. The plugin is out of scope (see issues #487 and #488).

---

### Task 1: Install source detection

A pure function that classifies the path the CLI is running from. This is the safety-critical piece: without it, `pnpm uploads update` inside the monorepo would overwrite the developer's build with the published version.

**Files:**

- Create: `packages/uploads/src/install-source.ts`
- Test: `packages/uploads/test/install-source.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `detectInstallSource(modulePath: string): InstallSource`, plus the exported types `InstallKind`, `PackageManager`, and `InstallSource`. Task 2 consumes all of these.

- [ ] **Step 1: Write the failing test**

Create `packages/uploads/test/install-source.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { detectInstallSource } from "../src/install-source.js";

describe("detectInstallSource", () => {
  it("classifies an npm global install", () => {
    const source = detectInstallSource(
      "/opt/homebrew/lib/node_modules/@buildinternet/uploads/dist/commands/update.js",
    );
    expect(source.kind).toBe("global");
    expect(source.manager).toBe("npm");
    expect(source.upgradeCommand).toEqual([
      "npm",
      "install",
      "-g",
      "@buildinternet/uploads@latest",
    ]);
  });

  it("classifies an nvm-managed npm global install", () => {
    const source = detectInstallSource(
      "/Users/dev/.nvm/versions/node/v24.3.0/lib/node_modules/@buildinternet/uploads/dist/cli.js",
    );
    expect(source.kind).toBe("global");
    expect(source.manager).toBe("npm");
  });

  it("classifies a pnpm global install", () => {
    const source = detectInstallSource(
      "/Users/dev/Library/pnpm/global/5/node_modules/@buildinternet/uploads/dist/cli.js",
    );
    expect(source.kind).toBe("global");
    expect(source.manager).toBe("pnpm");
    expect(source.upgradeCommand).toEqual(["pnpm", "add", "-g", "@buildinternet/uploads@latest"]);
  });

  it("classifies a bun global install", () => {
    const source = detectInstallSource(
      "/Users/dev/.bun/install/global/node_modules/@buildinternet/uploads/dist/cli.js",
    );
    expect(source.kind).toBe("global");
    expect(source.manager).toBe("bun");
    expect(source.upgradeCommand).toEqual(["bun", "add", "-g", "@buildinternet/uploads@latest"]);
  });

  it("classifies an npx cache entry", () => {
    const source = detectInstallSource(
      "/Users/dev/.npm/_npx/a1b2c3/node_modules/@buildinternet/uploads/dist/cli.js",
    );
    expect(source.kind).toBe("npx");
  });

  it("classifies a workspace checkout as workspace, not global", () => {
    const source = detectInstallSource("/Users/dev/Code/uploads/packages/uploads/dist/cli.js");
    expect(source.kind).toBe("workspace");
  });

  it("classifies a local project dependency as unknown", () => {
    const source = detectInstallSource(
      "/Users/dev/Code/app/node_modules/@buildinternet/uploads/dist/cli.js",
    );
    expect(source.kind).toBe("unknown");
  });

  it("prefers the npx marker over the global marker", () => {
    const source = detectInstallSource(
      "/Users/dev/.npm/_npx/a1b2c3/lib/node_modules/@buildinternet/uploads/dist/cli.js",
    );
    expect(source.kind).toBe("npx");
  });

  it("falls back to npm for a non-global kind", () => {
    const source = detectInstallSource("/Users/dev/Code/uploads/packages/uploads/dist/cli.js");
    expect(source.manager).toBe("npm");
  });

  it("normalizes Windows separators", () => {
    const source = detectInstallSource(
      "C:\\Users\\dev\\AppData\\Roaming\\npm\\lib\\node_modules\\@buildinternet\\uploads\\dist\\cli.js",
    );
    expect(source.kind).toBe("global");
    expect(source.manager).toBe("npm");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @buildinternet/uploads test test/install-source.test.ts`
Expected: FAIL — `Failed to resolve import "../src/install-source.js"`.

- [ ] **Step 3: Write the implementation**

Create `packages/uploads/src/install-source.ts`:

```typescript
/**
 * Classify where the running CLI was installed from.
 *
 * `uploads update` upgrades the global npm package. That is only safe when the
 * CLI actually came from a global install — upgrading a workspace checkout
 * would overwrite a developer's build with the published version.
 *
 * Pure and path-only: no filesystem or process access, so it is fully testable.
 */
import { PACKAGE_NAME } from "./update-check.js";

export type InstallKind = "global" | "workspace" | "npx" | "unknown";
export type PackageManager = "npm" | "pnpm" | "bun";

export interface InstallSource {
  kind: InstallKind;
  /** Falls back to npm for every non-global kind. */
  manager: PackageManager;
  /** Upgrades the global install. Only meaningful when kind is "global". */
  upgradeCommand: string[];
}

const UPGRADE_COMMANDS: Record<PackageManager, string[]> = {
  npm: ["npm", "install", "-g", `${PACKAGE_NAME}@latest`],
  pnpm: ["pnpm", "add", "-g", `${PACKAGE_NAME}@latest`],
  bun: ["bun", "add", "-g", `${PACKAGE_NAME}@latest`],
};

function classify(path: string): { kind: InstallKind; manager: PackageManager } {
  // npx is checked first: a cache entry can also contain a global-looking marker.
  if (path.includes("/_npx/")) return { kind: "npx", manager: "npm" };
  if (path.includes("/.bun/install/global/")) return { kind: "global", manager: "bun" };
  if (path.includes("/pnpm/global/")) return { kind: "global", manager: "pnpm" };
  if (path.includes("/lib/node_modules/")) return { kind: "global", manager: "npm" };
  // No node_modules segment at all means we are running out of a source checkout.
  if (!path.includes("/node_modules/")) return { kind: "workspace", manager: "npm" };
  return { kind: "unknown", manager: "npm" };
}

/**
 * @param modulePath Absolute path of a file inside the installed package,
 *   normally `realpathSync(fileURLToPath(import.meta.url))`.
 */
export function detectInstallSource(modulePath: string): InstallSource {
  const normalized = modulePath.split("\\").join("/");
  const { kind, manager } = classify(normalized);
  return { kind, manager, upgradeCommand: UPGRADE_COMMANDS[manager] };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @buildinternet/uploads test test/install-source.test.ts`
Expected: PASS — 10 tests.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @buildinternet/uploads typecheck`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/uploads/src/install-source.ts packages/uploads/test/install-source.test.ts
git commit -m "feat(cli): classify the CLI's install source"
```

---

### Task 2: The `update` command

Orchestrates the version check, the upgrade, and the refresh. `runStep` and `StepResult` become exported from `install.ts` so this command reuses them instead of duplicating the runner-and-error shape.

**Files:**

- Create: `packages/uploads/src/commands/update.ts`
- Modify: `packages/uploads/src/commands/install.ts` (export two existing symbols)
- Test: `packages/uploads/test/commands-update.test.ts`

**Interfaces:**

- Consumes: `detectInstallSource`, `InstallSource` from Task 1. `runInstall`, `runStep`, `StepResult` from `install.ts`. `checkForUpdate`, `PACKAGE_NAME`, `UpdateStatus` from `update-check.ts`. `CommandRunner`, `execRunner` from `github-gh.ts`.
- Produces: `runUpdate(args: string[], opts: RunUpdateOptions, help?: boolean): Promise<number>`. Task 3 calls this from `cli.ts`.

- [ ] **Step 1: Export the step helpers from `install.ts`**

In `packages/uploads/src/commands/install.ts`, add the `export` keyword to the existing `StepResult` interface and `runStep` function. Change these two lines only:

```typescript
export interface StepResult {
```

```typescript
export function runStep(run: CommandRunner, command: string[]): StepResult {
```

Everything else in the file stays as it is.

- [ ] **Step 2: Write the failing test**

Create `packages/uploads/test/commands-update.test.ts`:

```typescript
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @buildinternet/uploads test test/commands-update.test.ts`
Expected: FAIL — `Failed to resolve import "../src/commands/update.js"`.

- [ ] **Step 4: Write the implementation**

Create `packages/uploads/src/commands/update.ts`:

```typescript
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { flagBool, parseCommandArgs, UsageError, type GlobalFlags } from "../cli-args.js";
import { execRunner, type CommandRunner } from "../github-gh.js";
import { writeCommandHelp } from "../cli-style.js";
import { detectInstallSource, type InstallSource } from "../install-source.js";
import { checkForUpdate, PACKAGE_NAME, type UpdateStatus } from "../update-check.js";
import { runInstall, runStep } from "./install.js";

const UPDATE_HELP = `uploads update — update the CLI and refresh agent integrations

Upgrades the globally installed npm package, then re-runs \`uploads install\` so
the agent skills and the MCP registration match the new version. Skills and the
MCP registration drift on their own, so this refreshes them even when the CLI is
already current.

Usage:
  uploads update [options]

Options:
  --dry-run        Print the plan without running anything
  --skip-install   Upgrade the npm package only; leave skills and MCP alone
  --verbose        Show the output of the underlying commands

Examples:
  uploads update
  uploads update --dry-run
  uploads update --skip-install
`;

/** Why an upgrade was skipped, phrased for the user. */
const SKIP_REASON: Record<string, string> = {
  workspace: "this is a workspace checkout, not a global install",
  npx: "this ran from an npx cache, which is discarded after the run",
  unknown: "this is a local project dependency, not a global install",
};

export interface RunUpdateOptions {
  globals: GlobalFlags;
  /** Injected in tests. */
  runner?: CommandRunner;
  /** Injected in tests; defaults to detection from this module's path. */
  source?: InstallSource;
  /** Injected in tests; defaults to a cache-bypassing registry check. */
  check?: () => Promise<UpdateStatus>;
}

function thisModulePath(): string {
  const path = fileURLToPath(import.meta.url);
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function isPermissionError(message: string): boolean {
  return /EACCES|EPERM|permission denied/i.test(message);
}

export async function runUpdate(
  args: string[],
  opts: RunUpdateOptions,
  help = false,
): Promise<number> {
  const parsed = parseCommandArgs(args);
  if (help || parsed.help) {
    writeCommandHelp(UPDATE_HELP);
    return 0;
  }
  if (parsed.positionals.length > 0) {
    throw new UsageError(`update takes no arguments (got ${parsed.positionals[0]})`);
  }

  const dryRun = flagBool(parsed.flags, "--dry-run");
  const verbose = flagBool(parsed.flags, "--verbose");
  const skipInstall = flagBool(parsed.flags, "--skip-install");
  const run = opts.runner ?? execRunner;
  const source = opts.source ?? detectInstallSource(thisModulePath());
  // ttlMs 0 bypasses the once-a-day cache: `update` must not trust yesterday's read.
  const status = await (opts.check ?? (() => checkForUpdate({ ttlMs: 0 })))();

  const willUpgrade = status.updateAvailable && source.kind === "global";
  const refreshCommand = ["uploads", "install"];

  // --- plan ---
  if (willUpgrade) {
    process.stdout.write(`CLI ${status.current} → ${status.latest}\n`);
  } else if (status.updateAvailable) {
    process.stdout.write(
      `CLI ${status.current} is behind ${status.latest}, but the upgrade is skipped — ` +
        `${SKIP_REASON[source.kind] ?? "the install source is not a global install"}.\n` +
        `Upgrade by hand with: ${source.upgradeCommand.join(" ")}\n`,
    );
  } else {
    process.stdout.write(`CLI already at ${status.current}\n`);
  }

  if (dryRun) {
    if (willUpgrade) {
      process.stdout.write(`upgrade: would run — ${source.upgradeCommand.join(" ")}\n`);
    }
    if (!skipInstall) {
      process.stdout.write(`refresh: would run — ${refreshCommand.join(" ")}\n`);
    }
    return 0;
  }

  // --- upgrade ---
  if (willUpgrade) {
    process.stdout.write("Upgrading the CLI…\n");
    const result = runStep(run, source.upgradeCommand);
    if (!result.ok) {
      const message = result.error ?? "";
      process.stderr.write(`upgrade: failed — ${message}\n`);
      if (isPermissionError(message)) {
        process.stderr.write(
          "The global install directory is not writable by your user. Fix the ownership " +
            `of your npm prefix so global installs work without sudo, then re-run \`uploads update\`.\n`,
        );
      }
      process.stderr.write(`Run it by hand: ${source.upgradeCommand.join(" ")}\n`);
      return 1;
    }
    process.stdout.write("upgrade: ok\n");
    if (verbose && result.output) process.stdout.write(`  ${result.output}\n`);
  }

  if (skipInstall) return 0;

  // --- refresh ---
  // After an upgrade the in-process code is the OLD version, so spawn the newly
  // installed binary. Its skill list is the one that should be installed.
  if (willUpgrade) {
    process.stdout.write("Refreshing skills and MCP…\n");
    const result = runStep(run, refreshCommand);
    if (!result.ok) {
      process.stderr.write(`refresh: failed — ${result.error ?? ""}\n`);
      process.stderr.write("Run it by hand: uploads install\n");
      return 1;
    }
    process.stdout.write(result.output ? `${result.output}\n` : "refresh: ok\n");
    return 0;
  }

  // Nothing changed, so the in-process install code is already current.
  return runInstall([], { globals: opts.globals, runner: run });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @buildinternet/uploads test test/commands-update.test.ts`
Expected: PASS — 9 tests.

- [ ] **Step 6: Confirm the install tests still pass**

Run: `pnpm --filter @buildinternet/uploads test test/install.test.ts`
Expected: PASS. The only change to `install.ts` was adding `export` to two declarations.

- [ ] **Step 7: Commit**

```bash
git add packages/uploads/src/commands/update.ts packages/uploads/src/commands/install.ts packages/uploads/test/commands-update.test.ts
git commit -m "feat(cli): add the uploads update command"
```

---

### Task 3: Wire the command into the CLI

Registers `update` in the dispatch switch and the command catalog. Shell completion is generated from `ROOT_COMMANDS`, so the catalog entry covers it with no extra file.

**Files:**

- Modify: `packages/uploads/src/cli.ts:38` (import) and `packages/uploads/src/cli.ts:341` (dispatch)
- Modify: `packages/uploads/src/cli-catalog.ts:198`

**Interfaces:**

- Consumes: `runUpdate` from Task 2.
- Produces: a working `uploads update` binary path and a `update` entry in `ROOT_COMMANDS`.

- [ ] **Step 1: Add the import**

In `packages/uploads/src/cli.ts`, directly below the existing line 38 `import { runInstall } from "./commands/install.js";`, add:

```typescript
import { runUpdate } from "./commands/update.js";
```

- [ ] **Step 2: Add the dispatch case**

In `packages/uploads/src/cli.ts`, directly below the existing `case "install":` block (lines 341-342), add:

```typescript
      case "update":
        code = await runUpdate(cmdArgs, { globals: parsed.globals }, showHelp);
        break;
```

Note the `install` case above it ends with `break;` — do not remove it.

- [ ] **Step 3: Add the catalog entry**

In `packages/uploads/src/cli-catalog.ts`, insert between the `install` entry and the `login` entry that follows it. The insertion point is the line `  },` that closes the `install` object (line 206), immediately before `  {` opening the `login` object (line 207). Add:

```typescript
  {
    name: "update",
    summary: "Update the CLI, then refresh the agent skills + MCP registration",
    essential: true,
  },
```

- [ ] **Step 4: Write the failing test**

Append to `packages/uploads/test/cli-completion.test.ts`. That file already imports `ROOT_COMMANDS` from `../src/cli-catalog.js` on line 4, so no import change is needed. Add this test inside the outermost `describe` block:

```typescript
it("includes the update command", () => {
  expect(ROOT_COMMANDS.map((c) => c.name)).toContain("update");
});
```

- [ ] **Step 5: Run the test**

Run: `pnpm --filter @buildinternet/uploads test test/cli-completion.test.ts`
Expected: PASS. If any pre-existing assertion in this file counts commands or snapshots the command list, update that expected value to include `update` — the command list legitimately grew.

- [ ] **Step 6: Verify the command runs end to end**

Run: `pnpm --filter @buildinternet/uploads build && node packages/uploads/bin/uploads.js update --dry-run`
Expected: prints a version line, then `refresh: would run — uploads install`. It must not print a stack trace, and it must not run any command.

- [ ] **Step 7: Run the full package suite**

Run: `pnpm --filter @buildinternet/uploads test`
Expected: all tests pass. `cli-help` and `cli-style-help` tests may assert on the essential-command list; if one fails because `update` is now present, update that expectation.

- [ ] **Step 8: Commit**

```bash
git add packages/uploads/src/cli.ts packages/uploads/src/cli-catalog.ts packages/uploads/test/cli-completion.test.ts
git commit -m "feat(cli): register the update command in dispatch and the catalog"
```

---

### Task 4: Point the existing update notices at the new command

Three places currently tell users to run `npm i -g`. Two of them are shown to people who demonstrably already have the CLI, so they should name the new command instead.

**Files:**

- Modify: `packages/uploads/src/update-check.ts:153`
- Modify: `packages/uploads/src/cli-brand.ts:193`
- Modify: `apps/web/src/lib/cli-upgrade.ts:74`
- Test: `packages/uploads/test/update-check.test.ts`, `packages/uploads/test/cli-brand.test.ts`, `apps/web/src/lib/cli-upgrade.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks. The strings are independent.
- Produces: nothing consumed later.

- [ ] **Step 1: Update the stderr hint**

In `packages/uploads/src/update-check.ts`, replace the `write(...)` call inside `maybeHintUpdate`:

```typescript
write(
  `hint: ${PACKAGE_NAME}@${status.latest} is available (you have ${status.current}). Update: uploads update\n`,
);
```

- [ ] **Step 2: Update the help banner**

In `packages/uploads/src/cli-brand.ts`, replace the second line of the `formatUpdateBanner` box:

```typescript
return boxLines([`Update available  ${options.current} → ${options.latest}`, `uploads update`], {
  color: options.color,
  tone: BRAND.accent,
});
```

- [ ] **Step 3: Update the account-page callout**

In `apps/web/src/lib/cli-upgrade.ts`, add a command constant beside the existing `CLI_INSTALL_CMD` and use it in the message. `CLI_INSTALL_CMD` stays exported and unchanged, because fresh installs still need it.

```typescript
export const CLI_INSTALL_CMD = `npm i -g ${CLI_PACKAGE}`;
/** Shown to users who already have the CLI, so it can name the CLI's own verb. */
export const CLI_UPDATE_CMD = "uploads update";
```

Then in `resolveUpgradePrompt`, change the returned object:

```typescript
return {
  current: cur,
  latest: lat,
  installCmd: CLI_UPDATE_CMD,
  message: `You’re on CLI ${cur}; ${lat} is available. Update: ${CLI_UPDATE_CMD}`,
};
```

- [ ] **Step 4: Update the three assertions**

In `packages/uploads/test/cli-brand.test.ts`, replace the line asserting the npm command (around line 72):

```typescript
expect(text).toMatch(/uploads update/);
```

In `packages/uploads/test/update-check.test.ts`, replace line 65:

```typescript
expect(lines.join("")).toMatch(/Update: uploads update/);
```

In `apps/web/src/lib/cli-upgrade.test.ts`, change the expectation `installCmd: "npm i -g @buildinternet/uploads"` (around line 51) to:

```typescript
      installCmd: "uploads update",
```

- [ ] **Step 5: Run both suites**

Run: `pnpm --filter @buildinternet/uploads test && pnpm --filter @uploads/web test`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/uploads/src/update-check.ts packages/uploads/src/cli-brand.ts packages/uploads/test/update-check.test.ts packages/uploads/test/cli-brand.test.ts apps/web/src/lib/cli-upgrade.ts apps/web/src/lib/cli-upgrade.test.ts
git commit -m "feat(cli): point update notices at uploads update"
```

---

### Task 5: Documentation and changeset

**Files:**

- Modify: `docs/cli.md` (the "Getting started" block and the "Command overview" table)
- Create: `.changeset/uploads-update-command.md`

**Interfaces:**

- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Add the command to the getting-started block**

In `docs/cli.md`, inside the fenced `bash` block under `## Getting started`, add this line directly below the `uploads install` line:

```bash
uploads update         # update the CLI, then refresh the skills + MCP registration
```

- [ ] **Step 2: Add a paragraph explaining why the command exists**

In `docs/cli.md`, add this paragraph directly above the `## Command overview` heading:

```markdown
Two things go stale independently: the npm package that provides the `uploads`
binary, and the agent skills plus the MCP registration that `uploads install`
writes. `uploads update` covers both. It upgrades the global package, then
re-runs `install` against the new version. When the CLI is already current it
still refreshes the skills and the MCP registration, because those drift on
their own. Run `uploads update --dry-run` first to see the plan.

The upgrade step needs a global install. Inside a checkout of this repository,
or from an `npx` cache, `update` reports the newer version and prints the
command to run by hand, rather than overwriting your build.
```

- [ ] **Step 3: Add the table row**

In `docs/cli.md`, in the `## Command overview` table, add this row directly below the `install` row:

```markdown
| `update` | Update the CLI, then refresh the skills and MCP |
```

Column alignment does not need to be hand-perfected — the pre-commit hook runs oxfmt on markdown.

- [ ] **Step 4: Write the changeset**

Create `.changeset/uploads-update-command.md`:

```markdown
---
"@buildinternet/uploads": minor
---

Add `uploads update`. It upgrades the globally installed CLI, then re-runs
`uploads install` so the agent skills and the MCP registration match the new
version. When the CLI is already current it still refreshes them, because they
drift on their own. The upgrade step detects npm, pnpm, and bun global
installs, and refuses to overwrite a workspace checkout or an npx cache. The
existing update hint and help banner now name `uploads update`.
```

- [ ] **Step 5: Verify the changeset header**

Run: `head -4 .changeset/uploads-update-command.md`
Expected: the header names `"@buildinternet/uploads"` and nothing else. A changeset naming any other package blocks every npm publish.

- [ ] **Step 6: Run the full repository suite**

Run: `pnpm test`
Expected: all projects pass.

- [ ] **Step 7: Commit**

```bash
git add docs/cli.md .changeset/uploads-update-command.md
git commit -m "docs: document uploads update and add a changeset"
```

---

## Manual verification

After Task 5, confirm the real behavior outside the test fakes:

- [ ] `node packages/uploads/bin/uploads.js update --dry-run` from inside this repository reports that the upgrade is skipped for a workspace checkout, and prints the manual command.
- [ ] `node packages/uploads/bin/uploads.js update --help` renders the help text without a stack trace.
- [ ] `node packages/uploads/bin/uploads.js --help` shows `update` in the essential command list, with the update banner still rendering correctly when a newer version exists.
