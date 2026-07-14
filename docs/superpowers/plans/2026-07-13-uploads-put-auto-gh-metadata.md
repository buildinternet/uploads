# `uploads put` auto `gh.*` metadata — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `uploads put` stamp the four `gh.*` metadata pairs whenever it has a GitHub target — explicit (`--pr`/`--issue`) or auto-resolved from git — so `/f/` file pages show "Attached to".

**Architecture:** All changes are in `packages/uploads`. Reuse the existing `resolveCurrentPullRequest` (branch→PR) and `ghMetadataFromTarget` (target→4 pairs) helpers; add one `classifyGhNumber` helper (numeric ref → pull/issue) and one `resolveAutoGhTarget` best-effort wrapper. `runPut` gains a single metadata-merge block. Auto resolution is on by default and disabled by `--no-auto`, `--no-git`, or `UPLOADS_NO_AUTO_META`.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest, `gh` CLI (invoked through the injectable `CommandRunner` seam).

## Global Constraints

- Package: `@buildinternet/uploads`. Run tests with `pnpm --filter @buildinternet/uploads test`; typecheck with `pnpm --filter @buildinternet/uploads typecheck`.
- Node `>=22`. ESM: every relative import ends in `.js`.
- `GhTarget.kind` is the URL-segment spelling `"pull" | "issues"`. `ghMetadataFromTarget` maps `"issues"` → `gh.kind: "issue"` and lowercases `gh.repo`/`gh.ref`. Do not re-derive these mappings — always go through `ghMetadataFromTarget`.
- Auto resolution is **best-effort and must never fail the upload**: any thrown error → treat as "no gh context" and upload without metadata.
- The default key layout (`screenshots/<repo>/<ref>/…`) is **unchanged**; auto only adds metadata. Only explicit `--pr`/`--issue` produces `gh/` keys (existing behavior).
- Precedence: on the **explicit** `--pr`/`--issue` path, target pairs win over a same-key `--meta` extra (matches `runAttach`). On the **auto** path, explicit `--meta` wins over auto-derived pairs.

---

### Task 1: `classifyGhNumber` helper

**Files:**

- Modify: `packages/uploads/src/github-gh.ts` (add function after `resolveCurrentPullRequest`, ends ~line 72)
- Test: `packages/uploads/test/github-gh.test.ts`

**Interfaces:**

- Consumes: existing `CommandRunner`, `execRunner`, and `type GhTarget` (already imported in `github-gh.ts`).
- Produces: `classifyGhNumber(repo: string, num: number, run?: CommandRunner): GhTarget | undefined` — returns a target with `kind: "pull" | "issues"`, or `undefined` on any failure.

- [ ] **Step 1: Write the failing test**

Append to `packages/uploads/test/github-gh.test.ts` (add `classifyGhNumber` to the existing `../src/github-gh.js` import):

```ts
describe("classifyGhNumber", () => {
  it("classifies a pull request", () => {
    const run: CommandRunner = (cmd, args) => {
      expect(cmd).toBe("gh");
      expect(args).toContain("repos/o/r/issues/280");
      return "pull\n";
    };
    expect(classifyGhNumber("o/r", 280, run)).toEqual({ repo: "o/r", kind: "pull", num: 280 });
  });

  it("classifies an issue (GhTarget.kind is 'issues')", () => {
    const run: CommandRunner = () => "issue\n";
    expect(classifyGhNumber("o/r", 700, run)).toEqual({ repo: "o/r", kind: "issues", num: 700 });
  });

  it("returns undefined when gh throws", () => {
    const run: CommandRunner = () => {
      throw new Error("gh: Not Found");
    };
    expect(classifyGhNumber("o/r", 999, run)).toBeUndefined();
  });

  it("returns undefined on unexpected output", () => {
    const run: CommandRunner = () => "weird\n";
    expect(classifyGhNumber("o/r", 1, run)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @buildinternet/uploads test github-gh`
Expected: FAIL — `classifyGhNumber is not exported` / not a function.

- [ ] **Step 3: Write minimal implementation**

Add to `packages/uploads/src/github-gh.ts` after `resolveCurrentPullRequest`:

```ts
/**
 * Classify a bare PR/issue number via the GitHub API so the default `put`
 * path can stamp the right `gh.kind`. Returns undefined on any failure (gh
 * missing, 404, network) — the caller treats that as "no gh context" and
 * uploads without metadata.
 */
export function classifyGhNumber(
  repo: string,
  num: number,
  run: CommandRunner = execRunner,
): GhTarget | undefined {
  try {
    const out = run("gh", [
      "api",
      `repos/${repo}/issues/${num}`,
      "--jq",
      'if .pull_request then "pull" else "issue" end',
    ]).trim();
    if (out === "pull") return { repo, kind: "pull", num };
    if (out === "issue") return { repo, kind: "issues", num };
  } catch {
    // gh missing / not found / network — caller skips
  }
  return undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @buildinternet/uploads test github-gh`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/uploads/src/github-gh.ts packages/uploads/test/github-gh.test.ts
git commit -m "feat(uploads): add classifyGhNumber helper for gh.* derivation"
```

---

### Task 2: `UPLOADS_NO_AUTO_META` config default

**Files:**

- Modify: `packages/uploads/src/config-file.ts` (6 small edits)
- Test: `packages/uploads/test/config-put-defaults.test.ts` (create)

**Interfaces:**

- Produces: `PutDefaults.noAutoMeta?: boolean`, populated from `UPLOADS_NO_AUTO_META` (env or config file) via the existing `resolvePutDefaults({ envFile? })`.

- [ ] **Step 1: Write the failing test**

Create `packages/uploads/test/config-put-defaults.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { resolvePutDefaults } from "../src/config-file.js";

describe("resolvePutDefaults noAutoMeta", () => {
  const prev = process.env.UPLOADS_NO_AUTO_META;
  afterEach(() => {
    if (prev === undefined) delete process.env.UPLOADS_NO_AUTO_META;
    else process.env.UPLOADS_NO_AUTO_META = prev;
  });

  it("is undefined by default (auto stays on)", () => {
    delete process.env.UPLOADS_NO_AUTO_META;
    expect(resolvePutDefaults({}).noAutoMeta).toBeUndefined();
  });

  it("reads UPLOADS_NO_AUTO_META=1 from env", () => {
    process.env.UPLOADS_NO_AUTO_META = "1";
    expect(resolvePutDefaults({}).noAutoMeta).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @buildinternet/uploads test config-put-defaults`
Expected: FAIL — second case yields `undefined` (env key not yet parsed).

- [ ] **Step 3: Write minimal implementation**

In `packages/uploads/src/config-file.ts` make these edits:

1. Add to the `UPLOADS_CONFIG_KEYS` array (after `"UPLOADS_KEEP_EXIF",`):

```ts
  "UPLOADS_NO_AUTO_META",
```

2. Add to the `PutDefaults` interface (after the `keepExif?: boolean;` field):

```ts
  /** When true, `put` does NOT auto-resolve/stamp gh.* on the default path. */
  noAutoMeta?: boolean;
```

3. Add to `PUT_DEFAULT_KEY_MAP` (after `keepExif: "UPLOADS_KEEP_EXIF",`):

```ts
  noAutoMeta: "UPLOADS_NO_AUTO_META",
```

4. Add to `putDefaultsToConfigValues` (after the `keepExif` line):

```ts
if (defaults.noAutoMeta) out.UPLOADS_NO_AUTO_META = "1";
```

5. In `parsePutDefaultsFromRaw` (after the `UPLOADS_KEEP_EXIF` line):

```ts
if (isTruthyConfigFlag(raw.UPLOADS_NO_AUTO_META)) out.noAutoMeta = true;
```

6. In `parsePutDefaultsFromEnv` (after the `UPLOADS_KEEP_EXIF` line):

```ts
if (process.env.UPLOADS_NO_AUTO_META) raw.UPLOADS_NO_AUTO_META = process.env.UPLOADS_NO_AUTO_META;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @buildinternet/uploads test config-put-defaults`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/uploads/src/config-file.ts packages/uploads/test/config-put-defaults.test.ts
git commit -m "feat(uploads): add UPLOADS_NO_AUTO_META put default"
```

---

### Task 3: Stamp `gh.*` on the explicit `--pr`/`--issue` put path

**Files:**

- Modify: `packages/uploads/src/commands.ts` — `runPut` (metadata construction, currently ~lines 505–509; new merge placed just before `ctx.client.put(...)` ~line 592)
- Test: `packages/uploads/test/commands-put.test.ts`

**Interfaces:**

- Consumes: existing `ghTarget` (from `ghTargetFromFlags`, `runPut` ~line 500) and `ghMetadataFromTarget` (already imported).
- Produces: `runPut` passes `metadata` that includes the 4 `gh.*` pairs when `--pr`/`--issue` is present.

- [ ] **Step 1: Write the failing test**

Append to `packages/uploads/test/commands-put.test.ts`:

```ts
describe("runPut gh.* metadata (explicit target)", () => {
  it("stamps gh.* on the --pr path", async () => {
    const { client, puts } = fakeClient();
    await runPut(ctxWith(client), [tmpFile(), "--pr", "128", "--repo", "o/r"], false, noRun);
    expect(puts[0].metadata).toMatchObject({
      "gh.repo": "o/r",
      "gh.kind": "pull",
      "gh.number": "128",
      "gh.ref": "o/r#128",
    });
  });

  it("stamps gh.kind=issue on the --issue path", async () => {
    const { client, puts } = fakeClient();
    await runPut(ctxWith(client), [tmpFile(), "--issue", "7", "--repo", "o/r"], false, noRun);
    expect(puts[0].metadata).toMatchObject({ "gh.kind": "issue", "gh.number": "7" });
  });

  it("explicit target wins over a same-key --meta", async () => {
    const { client, puts } = fakeClient();
    await runPut(
      ctxWith(client),
      [tmpFile(), "--pr", "9", "--repo", "o/r", "--meta", "gh.number=999"],
      false,
      noRun,
    );
    expect(puts[0].metadata!["gh.number"]).toBe("9");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @buildinternet/uploads test commands-put`
Expected: FAIL — `puts[0].metadata` is `undefined` (put doesn't stamp gh.\* yet).

- [ ] **Step 3: Write minimal implementation**

In `runPut`, rename the existing metadata block (currently `const metadata = ((): … )();` at ~line 506) to build **`userMeta`** instead:

```ts
// Validate --meta up front (fail fast, before reading/optimizing the file).
const userMeta = ((): Record<string, string> | undefined => {
  const pairs = flagValues(parsed.flags, "--meta");
  return pairs.length > 0 ? parseMetaFlags(pairs) : undefined;
})();
```

Then, immediately before the `const result = await ctx.client.put(` call (~line 592, after `const noGit = …`), add:

```ts
// gh.* metadata from an explicit --pr/--issue target (target wins over --meta).
let metadata = userMeta;
if (ghTarget) {
  metadata = { ...(userMeta ?? {}), ...ghMetadataFromTarget(ghTarget) };
}
```

(The `metadata` field passed into `ctx.client.put({ …, metadata })` now refers to this new binding.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @buildinternet/uploads test commands-put`
Expected: PASS (new cases plus all existing `runPut` cases).

- [ ] **Step 5: Commit**

```bash
git add packages/uploads/src/commands.ts packages/uploads/test/commands-put.test.ts
git commit -m "fix(uploads): stamp gh.* metadata on put --pr/--issue"
```

---

### Task 4: Auto-resolve `gh.*` on the default put path

**Files:**

- Modify: `packages/uploads/src/commands.ts` — add `classifyGhNumber` to the `../github-gh.js` import; add `resolveAutoGhTarget` helper (near `ghTargetFromFlags`, ~line 164); extend the metadata block from Task 3; update `PUT_HELP`
- Test: `packages/uploads/test/commands-put.test.ts`

**Interfaces:**

- Consumes: `resolveRepo`, `resolveCurrentPullRequest`, `classifyGhNumber` (imported from `github-gh.js`), `defaults.noAutoMeta` (Task 2), `noGit`.
- Produces: on the default path (no `--pr`/`--issue`), when auto is enabled and a target resolves, `metadata` includes the 4 `gh.*` pairs (explicit `--meta` wins). Key layout unchanged.

- [ ] **Step 1: Write the failing test**

Append to `packages/uploads/test/commands-put.test.ts`:

```ts
/** Fake gh: answers `gh pr view` (branch→PR) and `gh api` (classify). */
function ghRunner(opts: { pr?: number; classify?: "pull" | "issue" }): CommandRunner {
  return (cmd, args) => {
    if (cmd === "gh" && args[0] === "repo") return "o/r\n"; // resolveRepo fallback
    if (cmd === "gh" && args[0] === "pr" && args[1] === "view") {
      if (opts.pr) return `${opts.pr}\n`;
      throw new Error("no pull request found");
    }
    if (cmd === "gh" && args[0] === "api") return `${opts.classify ?? "pull"}\n`;
    throw new Error(`unexpected: ${cmd} ${args.join(" ")}`);
  };
}

describe("runPut auto gh.* metadata (default path)", () => {
  it("stamps the current branch PR on a plain put", async () => {
    const { client, puts } = fakeClient();
    await runPut(ctxWith(client), [tmpFile(), "--repo", "o/r"], false, ghRunner({ pr: 481 }));
    expect(puts[0].key).toBeUndefined(); // still the screenshots default key
    expect(puts[0].metadata).toMatchObject({
      "gh.repo": "o/r",
      "gh.kind": "pull",
      "gh.number": "481",
      "gh.ref": "o/r#481",
    });
  });

  it("classifies a numeric --ref as an issue", async () => {
    const { client, puts } = fakeClient();
    await runPut(
      ctxWith(client),
      [tmpFile(), "--repo", "o/r", "--ref", "700"],
      false,
      ghRunner({ classify: "issue" }),
    );
    expect(puts[0].metadata).toMatchObject({
      "gh.kind": "issue",
      "gh.number": "700",
      "gh.ref": "o/r#700",
    });
  });

  it("uploads without metadata when no PR resolves", async () => {
    const { client, puts } = fakeClient();
    const code = await runPut(ctxWith(client), [tmpFile(), "--repo", "o/r"], false, ghRunner({}));
    expect(code).toBe(0);
    expect(puts[0].metadata).toBeUndefined();
  });

  it("--no-auto suppresses auto resolution", async () => {
    const { client, puts } = fakeClient();
    await runPut(
      ctxWith(client),
      [tmpFile(), "--repo", "o/r", "--no-auto"],
      false,
      ghRunner({ pr: 481 }),
    );
    expect(puts[0].metadata).toBeUndefined();
  });

  it("explicit --meta wins over auto-derived gh.*", async () => {
    const { client, puts } = fakeClient();
    await runPut(
      ctxWith(client),
      [tmpFile(), "--repo", "o/r", "--meta", "gh.number=5"],
      false,
      ghRunner({ pr: 481 }),
    );
    expect(puts[0].metadata!["gh.number"]).toBe("5");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @buildinternet/uploads test commands-put`
Expected: FAIL — auto cases show `metadata` `undefined` (no auto path yet).

- [ ] **Step 3: Write minimal implementation**

3a. Add `classifyGhNumber` to the existing `github-gh.js` import block in `commands.ts` (the block that already imports `resolveRepo`, `resolveCurrentPullRequest`):

```ts
  classifyGhNumber,
```

3b. Add the helper after `ghTargetFromFlags` (~line 164):

```ts
/**
 * Best-effort GitHub target for the default put path (no --pr/--issue). A
 * numeric --ref is classified as pull vs issue; otherwise the current branch's
 * PR is resolved. Never throws — any failure yields undefined so the upload
 * proceeds without gh metadata.
 */
function resolveAutoGhTarget(
  repoArg: string | undefined,
  ref: string | undefined,
  run: CommandRunner,
): GhTarget | undefined {
  try {
    const repo = resolveRepo(repoArg, run);
    if (ref !== undefined && /^\d+$/.test(ref) && Number(ref) > 0) {
      return classifyGhNumber(repo, Number.parseInt(ref, 10), run);
    }
    return resolveCurrentPullRequest(repo, run);
  } catch {
    return undefined;
  }
}
```

3c. Replace the Task 3 metadata block (the `let metadata = userMeta; if (ghTarget) { … }`) with the full explicit-or-auto version:

```ts
// gh.* metadata: explicit --pr/--issue target wins over --meta; otherwise
// best-effort auto resolution (on by default) where --meta wins. Auto is off
// when --no-auto, --no-git, or UPLOADS_NO_AUTO_META is set (unless --auto forces it).
let metadata = userMeta;
if (ghTarget) {
  metadata = { ...(userMeta ?? {}), ...ghMetadataFromTarget(ghTarget) };
} else {
  const autoEnabled =
    flagBool(parsed.flags, "--auto") ||
    (!flagBool(parsed.flags, "--no-auto") && defaults.noAutoMeta !== true && !noGit);
  if (autoEnabled) {
    const autoTarget = resolveAutoGhTarget(
      flagString(parsed.flags, "--repo") ?? defaults.repo,
      flagString(parsed.flags, "--ref") ?? defaults.ref,
      run,
    );
    if (autoTarget) metadata = { ...ghMetadataFromTarget(autoTarget), ...(userMeta ?? {}) };
  }
}
```

3d. Update `PUT_HELP` — add these lines in the gh/metadata section (after the `--no-git` line):

```
  --auto                Resolve current PR/issue and stamp gh.* metadata (default on)
  --no-auto             Skip gh.* auto-resolution on the default path (or UPLOADS_NO_AUTO_META=1)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @buildinternet/uploads test commands-put`
Expected: PASS. Also run the full package suite and typecheck:
`pnpm --filter @buildinternet/uploads test && pnpm --filter @buildinternet/uploads typecheck`
Expected: all green (existing `--no-git` default-path tests still pass — auto is gated off by `noGit`).

- [ ] **Step 5: Commit**

```bash
git add packages/uploads/src/commands.ts packages/uploads/test/commands-put.test.ts
git commit -m "feat(uploads): auto-resolve gh.* metadata on the default put path"
```

---

### Task 5: Docs + changeset

**Files:**

- Modify: `skills/uploads-cli/SKILL.md` (the Re-PUT / metadata semantics note)
- Create: `.changeset/put-auto-gh-metadata.md`

**Interfaces:** none (docs only).

- [ ] **Step 1: Add the changeset**

Create `.changeset/put-auto-gh-metadata.md`:

```markdown
---
"@buildinternet/uploads": minor
---

`uploads put` now stamps the four `gh.*` metadata pairs whenever it has a
GitHub target, so screenshots hosted on the default `screenshots/…` path get an
"Attached to" link on their `/f/` page. On by default: with `--pr`/`--issue`
the explicit target is used (previously the stable key was written without
metadata); otherwise `put` resolves the current branch's PR (or classifies a
numeric `--ref` as pull vs issue) via `gh`. Disable with `--no-auto`,
`--no-git`, or `UPLOADS_NO_AUTO_META=1`. Resolution is best-effort — a missing
`gh`, no PR, or an API error uploads normally without metadata.
```

- [ ] **Step 2: Update the CLI skill doc**

In `skills/uploads-cli/SKILL.md`, find the section documenting `put` re-PUT / metadata semantics and add a sentence describing auto gh.\* metadata and the `--no-auto` / `UPLOADS_NO_AUTO_META` opt-out. Suggested text:

```markdown
On the default `screenshots/…` path, `put` also auto-derives GitHub context and
stamps `gh.repo`/`gh.kind`/`gh.number`/`gh.ref` from the current branch's PR (or
a numeric `--ref`), so the file's `/f/` page shows an "Attached to" link. This is
on by default and best-effort; disable it with `--no-auto` or `UPLOADS_NO_AUTO_META=1`.
```

- [ ] **Step 3: Verify docs build/format (no code)**

Run: `pnpm --filter @buildinternet/uploads test && pnpm --filter @buildinternet/uploads typecheck`
Expected: still green (sanity check; docs don't affect tests).

- [ ] **Step 4: Commit**

```bash
git add .changeset/put-auto-gh-metadata.md skills/uploads-cli/SKILL.md
git commit -m "docs(uploads): document auto gh.* metadata on put + changeset"
```

---

## Self-Review

**Spec coverage:**

- Gap #1 (default path captures nothing) → Task 4. ✅
- Gap #2 (`put --pr` writes gh/ key but no gh.\*) → Task 3. ✅
- Numeric `--ref` classification → Task 1 (`classifyGhNumber`) + Task 4 wiring. ✅
- Branch→PR resolution → reuse `resolveCurrentPullRequest` in Task 4. ✅
- Control surface (`--auto`/`--no-auto`, `UPLOADS_NO_AUTO_META`, `--no-git` gate) → Task 2 (config) + Task 4 (flags/gate). ✅
- Best-effort/never-fail → `resolveAutoGhTarget` try/catch + `classifyGhNumber` returning undefined; Task 4 "no PR → uploads without metadata" test. ✅
- Precedence (explicit target wins; auto yields to --meta) → Task 3 + Task 4 tests. ✅
- Key layout unchanged → Task 4 asserts `puts[0].key` undefined (default key). ✅
- Docs + changeset → Task 5. ✅
- Out of scope (no migration, MCP unchanged, skill untouched) → honored; no tasks touch those. ✅

**Placeholder scan:** none — every code/step is concrete.

**Type consistency:** `classifyGhNumber(repo, num, run?) → GhTarget | undefined` defined in Task 1, consumed in Task 4 with matching arity; `GhTarget.kind` uses `"pull"|"issues"` consistently; `resolveAutoGhTarget(repoArg, ref, run)` signature matches its Task 4 call site; `PutDefaults.noAutoMeta` defined in Task 2, read in Task 4 as `defaults.noAutoMeta`.
