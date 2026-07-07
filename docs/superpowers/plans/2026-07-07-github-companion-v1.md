# GitHub Companion v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `--pr`/`--issue` PR/issue attachments with stable URLs, plus a managed GitHub attachments comment, to the `@buildinternet/uploads` CLI, and point the `github-screenshots` skill at it.

**Architecture:** All work lives in `packages/uploads` (the API is untouched — prefix listing already exists). Pure logic (key building, repo-URL parsing, comment-body generation) goes in a new `src/github.ts`; side-effectful `gh`/`git` calls go in `src/github-gh.ts` behind an injectable `CommandRunner` so everything is unit-testable without network. Commands get thin wiring. Keys are deterministic (`gh/<owner>/<repo>/pull/<num>/<filename>`, **no content hash**) so re-uploading a file updates every existing embed. The comment is posted through the user's local `gh` auth — no server-side GitHub integration.

**Tech Stack:** TypeScript (strict, ESM), Node >= 22, vitest (new dev dependency), `gh` CLI at runtime (optional — degrades gracefully).

**Spec:** `docs/superpowers/specs/2026-07-07-github-companion-design.md` — read it first.

## Global Constraints

- All commands below run from the repo root: `/Users/zachdunn/Code/uploads/.claude/worktrees/youthful-knuth-d843b9` unless a task says otherwise. Task 10 runs in a different repo: `/Users/zachdunn/Code/buildinternet-skills`.
- TypeScript strict, ESM only. Relative imports use the `.js` suffix even though sources are `.ts` (existing convention — copy it).
- Never build shell command strings. All subprocess calls use `execFileSync(cmd, argsArray)` via the `CommandRunner` type.
- PR/issue attachment keys must contain **no content hash** — same filename → same key → same URL. This is the auto-update mechanism; do not "improve" it with cache-busting.
- The CLI must always use the API-returned `url` field. Never compose public URLs client-side.
- The comment feature never blocks or fails an upload: in `put --comment`, `gh` failures print a warning to stderr and the command still exits 0.
- `--pr` and `--issue` are mutually exclusive everywhere they appear.
- The managed comment is found by the exact marker string `<!-- uploads.sh:attachments -->`; the CLI never touches any other comment or the PR description.
- Run `pnpm --filter @buildinternet/uploads test` and `pnpm --filter @buildinternet/uploads typecheck` before every commit that touches `packages/uploads`.

---

### Task 1: Test harness (vitest)

The repo currently has **no tests anywhere**. Set up vitest for `packages/uploads` and prove the harness with one test of an existing function.

**Files:**

- Modify: `packages/uploads/package.json` (add devDependency + script)
- Create: `packages/uploads/test/embed.test.ts`

**Interfaces:**

- Consumes: `buildMarkdown(url, {alt, width?})` from `packages/uploads/src/embed.ts` (exists).
- Produces: the `test` script (`pnpm --filter @buildinternet/uploads test`) that every later task uses. Tests live in `packages/uploads/test/`, import sources as `../src/<module>.js`, and are excluded from the build (tsconfig `include` is `["src"]` — leave it alone).

- [ ] **Step 1: Install vitest**

```bash
pnpm --filter @buildinternet/uploads add -D vitest
```

- [ ] **Step 2: Add the test script**

In `packages/uploads/package.json`, add to `"scripts"` (keep existing entries):

```json
"test": "vitest run"
```

- [ ] **Step 3: Write a first test against existing code**

Create `packages/uploads/test/embed.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildMarkdown } from "../src/embed.js";

describe("buildMarkdown", () => {
  it("emits image markdown without width", () => {
    expect(buildMarkdown("https://x.test/a.png", { alt: "shot" })).toBe(
      "![shot](https://x.test/a.png)",
    );
  });

  it("emits an img tag with width", () => {
    expect(buildMarkdown("https://x.test/a.png", { alt: "shot", width: 700 })).toBe(
      '<img width="700" alt="shot" src="https://x.test/a.png">',
    );
  });
});
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
pnpm --filter @buildinternet/uploads test
```

Expected: 2 tests pass. If vitest cannot resolve `../src/embed.js`, that is a real failure — stop and report; do not rename imports to `.ts`.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm --filter @buildinternet/uploads typecheck
git add packages/uploads/package.json packages/uploads/test/embed.test.ts pnpm-lock.yaml
git commit -m "test: add vitest harness to @buildinternet/uploads"
```

---

### Task 2: Pure GitHub key helpers (`src/github.ts`, part 1)

**Files:**

- Create: `packages/uploads/src/github.ts`
- Test: `packages/uploads/test/github.test.ts`

**Interfaces:**

- Consumes: `sanitizeKeySegment(s: string): string` from `src/keys.ts` (exists; strips everything but `A-Za-z0-9._-`).
- Produces (later tasks depend on these exact names):
  - `type GhTargetKind = "pull" | "issues"`
  - `interface GhTarget { repo: string; kind: GhTargetKind; num: number }` (`repo` is `"owner/name"`)
  - `isValidRepo(repo: string): boolean`
  - `parseRepoFromRemoteUrl(url: string): string | undefined`
  - `ghKeyPrefix(target: GhTarget): string` → e.g. `"gh/buildinternet/uploads/pull/123/"`
  - `ghAttachmentKey(target: GhTarget, filename: string): string`

- [ ] **Step 1: Write the failing tests**

Create `packages/uploads/test/github.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  ghAttachmentKey,
  ghKeyPrefix,
  isValidRepo,
  parseRepoFromRemoteUrl,
  type GhTarget,
} from "../src/github.js";

describe("isValidRepo", () => {
  it("accepts owner/name", () => {
    expect(isValidRepo("buildinternet/uploads")).toBe(true);
    expect(isValidRepo("a-b.c/d_e")).toBe(true);
  });
  it("rejects bare names and junk", () => {
    expect(isValidRepo("uploads")).toBe(false);
    expect(isValidRepo("a/b/c")).toBe(false);
    expect(isValidRepo("")).toBe(false);
    expect(isValidRepo("owner/")).toBe(false);
  });
});

describe("parseRepoFromRemoteUrl", () => {
  it("parses SSH remotes", () => {
    expect(parseRepoFromRemoteUrl("git@github.com:buildinternet/uploads.git")).toBe(
      "buildinternet/uploads",
    );
  });
  it("parses HTTPS remotes with and without .git", () => {
    expect(parseRepoFromRemoteUrl("https://github.com/buildinternet/uploads.git")).toBe(
      "buildinternet/uploads",
    );
    expect(parseRepoFromRemoteUrl("https://github.com/buildinternet/uploads")).toBe(
      "buildinternet/uploads",
    );
  });
  it("returns undefined for junk", () => {
    expect(parseRepoFromRemoteUrl("not a url")).toBeUndefined();
    expect(parseRepoFromRemoteUrl("")).toBeUndefined();
  });
});

describe("ghKeyPrefix / ghAttachmentKey", () => {
  const pr: GhTarget = { repo: "buildinternet/uploads", kind: "pull", num: 123 };

  it("builds the PR prefix", () => {
    expect(ghKeyPrefix(pr)).toBe("gh/buildinternet/uploads/pull/123/");
  });
  it("builds the issue prefix", () => {
    expect(ghKeyPrefix({ repo: "o/r", kind: "issues", num: 7 })).toBe("gh/o/r/issues/7/");
  });
  it("builds a stable key with no content hash", () => {
    expect(ghAttachmentKey(pr, "after.png")).toBe("gh/buildinternet/uploads/pull/123/after.png");
  });
  it("sanitizes filename characters", () => {
    expect(ghAttachmentKey(pr, "my shot (1).png")).toBe(
      "gh/buildinternet/uploads/pull/123/my-shot--1-.png",
    );
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
pnpm --filter @buildinternet/uploads test
```

Expected: FAIL — cannot resolve `../src/github.js`.

- [ ] **Step 3: Implement**

Create `packages/uploads/src/github.ts`:

```ts
import { sanitizeKeySegment } from "./keys.js";

export type GhTargetKind = "pull" | "issues";

export interface GhTarget {
  /** "owner/name" */
  repo: string;
  kind: GhTargetKind;
  num: number;
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function isValidRepo(repo: string): boolean {
  return REPO_RE.test(repo);
}

/** Parse "owner/name" from a git remote URL (SSH or HTTPS), else undefined. */
export function parseRepoFromRemoteUrl(url: string): string | undefined {
  const match = url.trim().match(/[/:]([^/:\s]+\/[^/:\s]+?)(?:\.git)?\/?$/);
  const repo = match?.[1];
  return repo && isValidRepo(repo) ? repo : undefined;
}

export function ghKeyPrefix(target: GhTarget): string {
  const [owner, name] = target.repo.split("/");
  return `gh/${sanitizeKeySegment(owner)}/${sanitizeKeySegment(name)}/${target.kind}/${target.num}/`;
}

/**
 * Stable attachment key: same filename → same key → same public URL, so
 * re-uploading updates every existing embed. Deliberately NO content hash
 * (unlike buildScreenshotKey).
 */
export function ghAttachmentKey(target: GhTarget, filename: string): string {
  return `${ghKeyPrefix(target)}${sanitizeKeySegment(filename)}`;
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
pnpm --filter @buildinternet/uploads test
```

Expected: all tests pass (Task 1's included).

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm --filter @buildinternet/uploads typecheck
git add packages/uploads/src/github.ts packages/uploads/test/github.test.ts
git commit -m "feat(uploads): stable PR/issue attachment keys"
```

---

### Task 3: Managed-comment marker and body (`src/github.ts`, part 2)

**Files:**

- Modify: `packages/uploads/src/github.ts` (append)
- Test: `packages/uploads/test/github.test.ts` (append)

**Interfaces:**

- Consumes: `inferContentType(filename: string): string` from `src/embed.ts` (exists).
- Produces:
  - `ATTACHMENTS_MARKER` — the exact string `<!-- uploads.sh:attachments -->`
  - `interface AttachmentItem { key: string; url: string | null }`
  - `attachmentsCommentBody(items: AttachmentItem[]): string`

- [ ] **Step 1: Write the failing tests** (append to `packages/uploads/test/github.test.ts`; add `ATTACHMENTS_MARKER` and `attachmentsCommentBody` to the existing import from `../src/github.js`)

```ts
describe("attachmentsCommentBody", () => {
  it("starts with the marker and renders images inline, other files as links", () => {
    const body = attachmentsCommentBody([
      { key: "gh/o/r/pull/1/notes.txt", url: "https://x.test/gh/o/r/pull/1/notes.txt" },
      { key: "gh/o/r/pull/1/after.png", url: "https://x.test/gh/o/r/pull/1/after.png" },
    ]);
    expect(body.startsWith(ATTACHMENTS_MARKER)).toBe(true);
    expect(body).toContain("![after.png](https://x.test/gh/o/r/pull/1/after.png)");
    expect(body).toContain("- [notes.txt](https://x.test/gh/o/r/pull/1/notes.txt)");
  });

  it("sorts deterministically by key so repeated runs produce identical bodies", () => {
    const a = attachmentsCommentBody([
      { key: "gh/o/r/pull/1/b.png", url: "https://x/b.png" },
      { key: "gh/o/r/pull/1/a.png", url: "https://x/a.png" },
    ]);
    const b = attachmentsCommentBody([
      { key: "gh/o/r/pull/1/a.png", url: "https://x/a.png" },
      { key: "gh/o/r/pull/1/b.png", url: "https://x/b.png" },
    ]);
    expect(a).toBe(b);
    expect(a.indexOf("a.png")).toBeLessThan(a.indexOf("b.png"));
  });

  it("lists items without a url as plain names", () => {
    const body = attachmentsCommentBody([{ key: "gh/o/r/pull/1/x.bin", url: null }]);
    expect(body).toContain("- x.bin");
  });
});
```

- [ ] **Step 2: Run tests, verify the new ones fail**

```bash
pnpm --filter @buildinternet/uploads test
```

Expected: FAIL — `attachmentsCommentBody` is not exported.

- [ ] **Step 3: Implement** (append to `packages/uploads/src/github.ts`; add `inferContentType` import at the top: `import { inferContentType } from "./embed.js";`)

```ts
/** Hidden marker identifying the one comment this CLI manages. Never change it — existing comments are found by exact match. */
export const ATTACHMENTS_MARKER = "<!-- uploads.sh:attachments -->";

export interface AttachmentItem {
  key: string;
  url: string | null;
}

export function attachmentsCommentBody(items: AttachmentItem[]): string {
  const sorted = [...items].sort((a, b) => a.key.localeCompare(b.key));
  const lines: string[] = [ATTACHMENTS_MARKER, "### 📎 Attachments", ""];
  for (const item of sorted) {
    const name = item.key.slice(item.key.lastIndexOf("/") + 1);
    if (item.url && inferContentType(name).startsWith("image/")) {
      lines.push(`![${name}](${item.url})`);
    } else if (item.url) {
      lines.push(`- [${name}](${item.url})`);
    } else {
      lines.push(`- ${name}`);
    }
  }
  lines.push(
    "",
    "<sub>Maintained by uploads.sh — re-uploading a file with the same name updates it everywhere it is embedded.</sub>",
  );
  return lines.join("\n");
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
pnpm --filter @buildinternet/uploads test
```

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm --filter @buildinternet/uploads typecheck
git add packages/uploads/src/github.ts packages/uploads/test/github.test.ts
git commit -m "feat(uploads): managed attachments-comment body generation"
```

---

### Task 4: `gh`/`git` wrapper with injectable runner (`src/github-gh.ts`)

**Files:**

- Create: `packages/uploads/src/github-gh.ts`
- Test: `packages/uploads/test/github-gh.test.ts`

**Interfaces:**

- Consumes: `UsageError` from `src/cli-args.ts`; `ATTACHMENTS_MARKER`, `isValidRepo`, `parseRepoFromRemoteUrl`, `GhTarget` from `src/github.ts` (Tasks 2–3).
- Produces:
  - `type CommandRunner = (cmd: string, args: string[], input?: string) => string` — returns stdout, throws on non-zero exit
  - `execRunner: CommandRunner` — the real implementation
  - `resolveRepo(explicit: string | undefined, run?: CommandRunner): string` — throws `UsageError` when unresolvable
  - `upsertAttachmentsComment(target: GhTarget, body: string, run?: CommandRunner): { created: boolean }`

- [ ] **Step 1: Write the failing tests**

Create `packages/uploads/test/github-gh.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { UsageError } from "../src/cli-args.js";
import { ATTACHMENTS_MARKER, type GhTarget } from "../src/github.js";
import { resolveRepo, upsertAttachmentsComment, type CommandRunner } from "../src/github-gh.js";

/** Fake runner: matches on command name, records calls. */
function fakeRunner(handlers: Record<string, (args: string[], input?: string) => string>) {
  const calls: { cmd: string; args: string[]; input?: string }[] = [];
  const run: CommandRunner = (cmd, args, input) => {
    calls.push({ cmd, args, input });
    const handler = handlers[cmd];
    if (!handler) throw new Error(`command not found: ${cmd}`);
    return handler(args, input);
  };
  return { run, calls };
}

describe("resolveRepo", () => {
  it("validates and returns an explicit --repo", () => {
    const { run } = fakeRunner({});
    expect(resolveRepo("buildinternet/uploads", run)).toBe("buildinternet/uploads");
  });

  it("rejects a bare --repo name", () => {
    const { run } = fakeRunner({});
    expect(() => resolveRepo("uploads", run)).toThrow(UsageError);
  });

  it("prefers gh repo view", () => {
    const { run } = fakeRunner({
      gh: () => "buildinternet/uploads\n",
    });
    expect(resolveRepo(undefined, run)).toBe("buildinternet/uploads");
  });

  it("falls back to the git remote when gh fails", () => {
    const { run } = fakeRunner({
      gh: () => {
        throw new Error("gh: not logged in");
      },
      git: () => "git@github.com:buildinternet/uploads.git\n",
    });
    expect(resolveRepo(undefined, run)).toBe("buildinternet/uploads");
  });

  it("throws UsageError when nothing resolves", () => {
    const { run } = fakeRunner({});
    expect(() => resolveRepo(undefined, run)).toThrow(UsageError);
  });
});

describe("upsertAttachmentsComment", () => {
  const target: GhTarget = { repo: "o/r", kind: "pull", num: 5 };

  it("creates a comment when no managed comment exists", () => {
    const { run, calls } = fakeRunner({
      gh: (args) => {
        if (args[1]?.includes("/comments?per_page=100")) {
          return JSON.stringify([{ id: 1, body: "unrelated comment" }]);
        }
        return JSON.stringify({ id: 99 });
      },
    });
    const result = upsertAttachmentsComment(target, `${ATTACHMENTS_MARKER}\nbody`, run);
    expect(result.created).toBe(true);
    const post = calls[1];
    expect(post.args).toContain("repos/o/r/issues/5/comments");
    expect(post.args).toContain("body=@-");
    expect(post.input).toContain(ATTACHMENTS_MARKER);
  });

  it("PATCHes the existing managed comment in place", () => {
    const { run, calls } = fakeRunner({
      gh: (args) => {
        if (args[1]?.includes("/comments?per_page=100")) {
          return JSON.stringify([
            { id: 1, body: "unrelated" },
            { id: 42, body: `${ATTACHMENTS_MARKER}\nold body` },
          ]);
        }
        return JSON.stringify({ id: 42 });
      },
    });
    const result = upsertAttachmentsComment(target, `${ATTACHMENTS_MARKER}\nnew body`, run);
    expect(result.created).toBe(false);
    const patch = calls[1];
    expect(patch.args).toContain("repos/o/r/issues/comments/42");
    expect(patch.args).toContain("PATCH");
    expect(patch.input).toContain("new body");
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
pnpm --filter @buildinternet/uploads test
```

Expected: FAIL — cannot resolve `../src/github-gh.js`.

- [ ] **Step 3: Implement**

Create `packages/uploads/src/github-gh.ts`:

```ts
import { execFileSync } from "node:child_process";
import { UsageError } from "./cli-args.js";
import {
  ATTACHMENTS_MARKER,
  isValidRepo,
  parseRepoFromRemoteUrl,
  type GhTarget,
} from "./github.js";

/** Runs a command and returns stdout; throws on non-zero exit. Injectable for tests. */
export type CommandRunner = (cmd: string, args: string[], input?: string) => string;

export const execRunner: CommandRunner = (cmd, args, input) =>
  execFileSync(cmd, args, { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] });

/**
 * Resolve "owner/name". Order: explicit --repo (validated) → `gh repo view`
 * (fork-aware) → parse the origin remote → UsageError.
 */
export function resolveRepo(explicit: string | undefined, run: CommandRunner = execRunner): string {
  if (explicit !== undefined) {
    if (!isValidRepo(explicit)) {
      throw new UsageError(`--repo must be owner/name (got: ${explicit})`);
    }
    return explicit;
  }
  try {
    const out = run("gh", [
      "repo",
      "view",
      "--json",
      "nameWithOwner",
      "--jq",
      ".nameWithOwner",
    ]).trim();
    if (isValidRepo(out)) return out;
  } catch {
    // gh missing, unauthenticated, or not in a repo — fall through
  }
  try {
    const url = run("git", ["config", "--get", "remote.origin.url"]).trim();
    const parsed = parseRepoFromRemoteUrl(url);
    if (parsed) return parsed;
  } catch {
    // not a git repo — fall through
  }
  throw new UsageError("could not infer repository from git — pass --repo owner/name");
}

interface GhComment {
  id: number;
  body: string;
}

/**
 * PR comments live on the issues endpoint, so one path covers PRs and issues.
 * Only the first 100 comments are searched (accepted v1 limitation).
 */
function findManagedComment(target: GhTarget, run: CommandRunner): GhComment | undefined {
  const raw = run("gh", ["api", `repos/${target.repo}/issues/${target.num}/comments?per_page=100`]);
  const comments = JSON.parse(raw) as GhComment[];
  return comments.find((c) => typeof c.body === "string" && c.body.includes(ATTACHMENTS_MARKER));
}

/**
 * Create the managed attachments comment, or edit it in place if it already
 * exists. Never touches any other comment. Body is passed via stdin
 * (`-F body=@-`) so it is never shell-interpolated.
 */
export function upsertAttachmentsComment(
  target: GhTarget,
  body: string,
  run: CommandRunner = execRunner,
): { created: boolean } {
  const existing = findManagedComment(target, run);
  if (existing) {
    run(
      "gh",
      [
        "api",
        `repos/${target.repo}/issues/comments/${existing.id}`,
        "-X",
        "PATCH",
        "-F",
        "body=@-",
      ],
      body,
    );
    return { created: false };
  }
  run("gh", ["api", `repos/${target.repo}/issues/${target.num}/comments`, "-F", "body=@-"], body);
  return { created: true };
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
pnpm --filter @buildinternet/uploads test
```

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm --filter @buildinternet/uploads typecheck
git add packages/uploads/src/github-gh.ts packages/uploads/test/github-gh.test.ts
git commit -m "feat(uploads): gh wrapper — repo inference and comment upsert"
```

---

### Task 5: `put --pr` / `put --issue` (stable keys)

**Files:**

- Modify: `packages/uploads/src/commands.ts`
- Test: `packages/uploads/test/commands-put.test.ts`

**Interfaces:**

- Consumes: `ghAttachmentKey`, `GhTarget` (Task 2); `resolveRepo`, `execRunner`, `CommandRunner` (Task 4); existing `runPut`, `CliContext`, `flagInt`, `flagString`, `flagBool`, `UsageError`.
- Produces:
  - `runPut(ctx, args, help?, run?: CommandRunner)` — 4th parameter added, defaults to `execRunner`. `cli.ts` keeps calling it with 3 args.
  - `ghTargetFromFlags(flags, run): GhTarget | undefined` — module-private helper in `commands.ts`, reused by Tasks 6–7. Returns `undefined` when neither `--pr` nor `--issue` is present; throws `UsageError` on conflicts.

- [ ] **Step 1: Write the failing tests**

Create `packages/uploads/test/commands-put.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { UsageError } from "../src/cli-args.js";
import type { UploadsClient } from "../src/client.js";
import { runPut, type CliContext } from "../src/commands.js";
import type { CommandRunner } from "../src/github-gh.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Fake client capturing put() calls; other methods throw if reached. */
function fakeClient() {
  const puts: { key?: string; filename: string }[] = [];
  const client = {
    put: async (_body: Uint8Array, opts: { filename: string; key?: string }) => {
      puts.push({ key: opts.key, filename: opts.filename });
      return {
        workspace: "test",
        key: opts.key ?? "generated/key.png",
        url: `https://x.test/${opts.key ?? "generated/key.png"}`,
        size: 3,
        contentType: "image/png",
      };
    },
    list: async () => ({ items: [], cursor: null }),
    delete: async () => {
      throw new Error("unexpected delete");
    },
    head: async () => {
      throw new Error("unexpected head");
    },
    health: async () => ({ ok: true }),
  } as unknown as UploadsClient;
  return { client, puts };
}

function ctxWith(client: UploadsClient): CliContext {
  return {
    config: {
      apiUrl: "https://x.test",
      workspace: "test",
      token: "up_test_x",
      workspaceSource: "override",
    },
    client,
    json: false,
    quiet: true,
  };
}

function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "uploads-test-"));
  const file = join(dir, "shot.png");
  writeFileSync(file, "png");
  return file;
}

const noRun: CommandRunner = () => {
  throw new Error("runner should not be called");
};

describe("runPut --pr/--issue", () => {
  it("builds a stable PR key with no hash", async () => {
    const { client, puts } = fakeClient();
    const code = await runPut(
      ctxWith(client),
      [tmpFile(), "--pr", "123", "--repo", "buildinternet/uploads"],
      false,
      noRun,
    );
    expect(code).toBe(0);
    expect(puts[0].key).toBe("gh/buildinternet/uploads/pull/123/shot.png");
  });

  it("builds an issue key", async () => {
    const { client, puts } = fakeClient();
    await runPut(ctxWith(client), [tmpFile(), "--issue", "7", "--repo", "o/r"], false, noRun);
    expect(puts[0].key).toBe("gh/o/r/issues/7/shot.png");
  });

  it("rejects --pr with --issue", async () => {
    const { client } = fakeClient();
    await expect(
      runPut(
        ctxWith(client),
        [tmpFile(), "--pr", "1", "--issue", "2", "--repo", "o/r"],
        false,
        noRun,
      ),
    ).rejects.toThrow(UsageError);
  });

  it("rejects --pr with --key", async () => {
    const { client } = fakeClient();
    await expect(
      runPut(
        ctxWith(client),
        [tmpFile(), "--pr", "1", "--key", "x/y.png", "--repo", "o/r"],
        false,
        noRun,
      ),
    ).rejects.toThrow(UsageError);
  });

  it("rejects --pr with --ref", async () => {
    const { client } = fakeClient();
    await expect(
      runPut(
        ctxWith(client),
        [tmpFile(), "--pr", "1", "--ref", "abc", "--repo", "o/r"],
        false,
        noRun,
      ),
    ).rejects.toThrow(UsageError);
  });

  it("still uses the hashed screenshot key path without --pr/--issue", async () => {
    const { client, puts } = fakeClient();
    await runPut(ctxWith(client), [tmpFile(), "--repo", "myapp", "--no-git"], false, noRun);
    expect(puts[0].key).toBeUndefined(); // client falls back to buildScreenshotKey
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
pnpm --filter @buildinternet/uploads test
```

Expected: FAIL — `runPut` takes 3 args / keys don't match.

- [ ] **Step 3: Implement in `packages/uploads/src/commands.ts`**

Add imports at the top (merge with existing import lines):

```ts
import {
  ghAttachmentKey,
  ghKeyPrefix,
  attachmentsCommentBody,
  type GhTarget,
  type AttachmentItem,
} from "./github.js";
import {
  resolveRepo,
  execRunner,
  upsertAttachmentsComment,
  type CommandRunner,
} from "./github-gh.js";
import type { CommandFlags } from "./cli-args.js";
```

(`ghKeyPrefix`, `attachmentsCommentBody`, `upsertAttachmentsComment`, `AttachmentItem` are used in Tasks 6–7; importing them now is fine, but if the linter/typecheck complains about unused imports, add only what this task uses and extend in Task 6.)

Add the shared helper (above `runPut`):

```ts
/** Reads --pr/--issue (+ --repo) into a GhTarget; undefined when neither flag is present. */
function ghTargetFromFlags(flags: CommandFlags["flags"], run: CommandRunner): GhTarget | undefined {
  const pr = flagInt(flags, "--pr", "--pr");
  const issue = flagInt(flags, "--issue", "--issue");
  if (pr === undefined && issue === undefined) return undefined;
  if (pr !== undefined && issue !== undefined) {
    throw new UsageError("--pr and --issue are mutually exclusive");
  }
  const repo = resolveRepo(flagString(flags, "--repo"), run);
  return { repo, kind: pr !== undefined ? "pull" : "issues", num: (pr ?? issue) as number };
}
```

Change `runPut`'s signature:

```ts
export async function runPut(
  ctx: CliContext,
  args: string[],
  help = false,
  run: CommandRunner = execRunner,
): Promise<number> {
```

Inside `runPut`, right after `const keyHint = flagString(parsed.flags, "--key");` (before reading file bytes), add:

```ts
const ghTarget = ghTargetFromFlags(parsed.flags, run);
if (ghTarget) {
  if (keyHint) throw new UsageError("--key cannot be combined with --pr/--issue");
  if (flagString(parsed.flags, "--ref")) {
    throw new UsageError("--ref cannot be combined with --pr/--issue");
  }
}
```

Change the `ctx.client.put` call's `key` line from `key: keyHint,` to:

```ts
    key: ghTarget ? ghAttachmentKey(ghTarget, filename) : keyHint,
```

Update `PUT_HELP`: after the `--ref <id>` line, add:

```
  --pr <num>            Attach to a pull request: key gh/<owner>/<repo>/pull/<num>/<name> (stable URL, no hash)
  --issue <num>         Attach to an issue: key gh/<owner>/<repo>/issues/<num>/<name>
  --comment             With --pr/--issue: create/update the attachments comment via your local gh auth
```

And add an example line: `  uploads --env-file .env put ./after.png --pr 123 --comment`

(`--comment` behavior itself lands in Task 6; documenting it here avoids editing the same help block twice.)

- [ ] **Step 4: Run tests, verify they pass**

```bash
pnpm --filter @buildinternet/uploads test
```

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm --filter @buildinternet/uploads typecheck
git add packages/uploads/src/commands.ts packages/uploads/test/commands-put.test.ts
git commit -m "feat(uploads): put --pr/--issue with stable attachment keys"
```

---

### Task 6: `uploads comment` command + `put --comment`

**Files:**

- Modify: `packages/uploads/src/commands.ts`
- Modify: `packages/uploads/src/cli.ts`
- Test: `packages/uploads/test/commands-comment.test.ts`

**Interfaces:**

- Consumes: `ghTargetFromFlags` (Task 5), `ghKeyPrefix`, `attachmentsCommentBody`, `AttachmentItem` (Tasks 2–3), `upsertAttachmentsComment` (Task 4).
- Produces:
  - `runComment(ctx: CliContext, args: string[], help?: boolean, run?: CommandRunner): Promise<number>` — exported from `commands.ts`, wired into `cli.ts` as the `comment` command (authenticated path, same as `put`).
  - `syncAttachmentsComment(ctx, target, run): Promise<{ action: "created" | "updated" | "skipped"; count: number }>` — module-private; lists **all pages** under `ghKeyPrefix(target)`, skips when empty, otherwise upserts. Throws on `gh` failure (callers decide soft vs hard).

- [ ] **Step 1: Write the failing tests**

Create `packages/uploads/test/commands-comment.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { UsageError } from "../src/cli-args.js";
import type { UploadsClient } from "../src/client.js";
import { runComment, type CliContext } from "../src/commands.js";
import { ATTACHMENTS_MARKER } from "../src/github.js";
import type { CommandRunner } from "../src/github-gh.js";

function listClient(items: { key: string; url: string | null }[]) {
  return {
    list: async () => ({ items, cursor: null }),
  } as unknown as UploadsClient;
}

function ctxWith(client: UploadsClient): CliContext {
  return {
    config: {
      apiUrl: "https://x.test",
      workspace: "test",
      token: "up_test_x",
      workspaceSource: "override",
    },
    client,
    json: false,
    quiet: true,
  };
}

/** gh runner that reports no existing comments and records the create call. */
function ghRunner() {
  const calls: { args: string[]; input?: string }[] = [];
  const run: CommandRunner = (cmd, args, input) => {
    if (cmd !== "gh") throw new Error(`unexpected command: ${cmd}`);
    calls.push({ args, input });
    if (args[1]?.includes("per_page=100")) return "[]";
    return JSON.stringify({ id: 9 });
  };
  return { run, calls };
}

describe("runComment", () => {
  it("requires --pr or --issue", async () => {
    const { run } = ghRunner();
    await expect(runComment(ctxWith(listClient([])), [], false, run)).rejects.toThrow(UsageError);
  });

  it("creates a comment listing the PR's attachments", async () => {
    const { run, calls } = ghRunner();
    const client = listClient([
      { key: "gh/o/r/pull/5/after.png", url: "https://x.test/gh/o/r/pull/5/after.png" },
    ]);
    const code = await runComment(ctxWith(client), ["--pr", "5", "--repo", "o/r"], false, run);
    expect(code).toBe(0);
    const create = calls.find((c) => c.args.includes("repos/o/r/issues/5/comments"));
    expect(create).toBeDefined();
    expect(create!.input).toContain(ATTACHMENTS_MARKER);
    expect(create!.input).toContain("after.png");
  });

  it("skips gh entirely when there are no attachments", async () => {
    const { run, calls } = ghRunner();
    const code = await runComment(
      ctxWith(listClient([])),
      ["--pr", "5", "--repo", "o/r"],
      false,
      run,
    );
    expect(code).toBe(0);
    expect(calls.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
pnpm --filter @buildinternet/uploads test
```

Expected: FAIL — `runComment` is not exported.

- [ ] **Step 3: Implement in `packages/uploads/src/commands.ts`**

Ensure these are imported (Task 5 note): `ghKeyPrefix`, `attachmentsCommentBody`, `type AttachmentItem` from `./github.js`; `upsertAttachmentsComment` from `./github-gh.js`.

Add below `ghTargetFromFlags`:

```ts
/**
 * List every attachment under the target's prefix and create/update the
 * managed comment. Throws on gh failure — callers decide whether that is
 * fatal (`comment` command) or a warning (`put --comment`).
 */
async function syncAttachmentsComment(
  ctx: CliContext,
  target: GhTarget,
  run: CommandRunner,
): Promise<{ action: "created" | "updated" | "skipped"; count: number }> {
  const items: AttachmentItem[] = [];
  let cursor: string | undefined;
  do {
    const page = await ctx.client.list({ prefix: ghKeyPrefix(target), cursor });
    items.push(...page.items.map(({ key, url }) => ({ key, url })));
    cursor = page.cursor ?? undefined;
  } while (cursor);

  if (items.length === 0) return { action: "skipped", count: 0 };

  const body = attachmentsCommentBody(items);
  const { created } = upsertAttachmentsComment(target, body, run);
  return { action: created ? "created" : "updated", count: items.length };
}
```

Add the command:

```ts
const COMMENT_HELP = `uploads comment (--pr <num> | --issue <num>) [--repo <owner/name>] [--workspace <name>]

Create or update the managed attachments comment on a GitHub PR or issue,
listing everything uploaded for it. Uses your local gh auth. Finds its own
prior comment via a hidden marker and edits it in place; never touches other
comments or the description.

Examples:
  uploads --env-file .env comment --pr 123
  uploads comment --issue 45 --repo buildinternet/uploads
`;

export async function runComment(
  ctx: CliContext,
  args: string[],
  help = false,
  run: CommandRunner = execRunner,
): Promise<number> {
  const parsed = parseCommandArgs(args);
  if (help || parsed.help) {
    process.stderr.write(COMMENT_HELP);
    return 0;
  }
  const target = ghTargetFromFlags(parsed.flags, run);
  if (!target) throw new UsageError("comment requires --pr or --issue");

  const result = await syncAttachmentsComment(ctx, target, run);
  if (ctx.json) {
    await writeJson({ ...target, ...result });
  } else if (!ctx.quiet) {
    process.stderr.write(
      result.action === "skipped"
        ? `no attachments under ${ghKeyPrefix(target)} — nothing to do\n`
        : `${result.action} attachments comment on ${target.repo}#${target.num} (${result.count} file${result.count === 1 ? "" : "s"})\n`,
    );
  }
  return 0;
}
```

Wire `put --comment` in `runPut`. In the validation block added in Task 5, extend to:

```ts
const ghTarget = ghTargetFromFlags(parsed.flags, run);
const wantComment = parsed.flags.has("--comment");
if (wantComment && typeof parsed.flags.get("--comment") === "string") {
  throw new UsageError("--comment takes no value — place it after the file argument");
}
if (wantComment && !ghTarget) throw new UsageError("--comment requires --pr or --issue");
if (ghTarget) {
  if (keyHint) throw new UsageError("--key cannot be combined with --pr/--issue");
  if (flagString(parsed.flags, "--ref")) {
    throw new UsageError("--ref cannot be combined with --pr/--issue");
  }
}
```

At the end of `runPut`, just before `return 0;`, add:

```ts
if (wantComment && ghTarget) {
  try {
    const sync = await syncAttachmentsComment(ctx, ghTarget, run);
    if (!ctx.quiet && format === "human") {
      process.stderr.write(`>> attachments comment ${sync.action}\n`);
    }
  } catch (err) {
    // Upload already succeeded; the comment is best-effort by design.
    process.stderr.write(
      `warning: upload succeeded but the GitHub comment failed (is gh installed and authenticated?): ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}
```

Wire the command in `packages/uploads/src/cli.ts`:

1. Import `runComment` alongside the other command imports from `./commands.js`.
2. In `ROOT_HELP`'s `Commands:` block, after the `put` line, add:
   `  comment             Create/update a PR/issue attachments comment (via gh)`
3. In the `switch (parsed.command)`, add `case "comment":` to the authenticated group (`case "put": case "list": case "delete": case "doctor":`) and inside the inner switch add:

```ts
          case "comment":
            return runComment(ctx, cmdArgs, showHelp);
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
pnpm --filter @buildinternet/uploads test
```

- [ ] **Step 5: Smoke-test help wiring**

```bash
pnpm --filter @buildinternet/uploads build
node packages/uploads/bin/uploads.js comment --help
```

Expected: `COMMENT_HELP` text on stderr, exit 0.

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm --filter @buildinternet/uploads typecheck
git add packages/uploads/src/commands.ts packages/uploads/src/cli.ts packages/uploads/test/commands-comment.test.ts
git commit -m "feat(uploads): comment command and put --comment"
```

---

### Task 7: `list --pr` / `list --issue`

**Files:**

- Modify: `packages/uploads/src/commands.ts` (`runList`, `LIST_HELP`)
- Test: `packages/uploads/test/commands-list.test.ts`

**Interfaces:**

- Consumes: `ghTargetFromFlags` (Task 5), `ghKeyPrefix` (Task 2).
- Produces: `runList(ctx, args, help?, run?: CommandRunner)` — 4th parameter added, defaulting to `execRunner`; `cli.ts` keeps calling with 3 args.

- [ ] **Step 1: Write the failing tests**

Create `packages/uploads/test/commands-list.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { UsageError } from "../src/cli-args.js";
import type { UploadsClient } from "../src/client.js";
import { runList, type CliContext } from "../src/commands.js";
import type { CommandRunner } from "../src/github-gh.js";

function fakeListClient() {
  const prefixes: (string | undefined)[] = [];
  const client = {
    list: async (opts: { prefix?: string }) => {
      prefixes.push(opts.prefix);
      return { items: [], cursor: null };
    },
  } as unknown as UploadsClient;
  return { client, prefixes };
}

function ctxWith(client: UploadsClient): CliContext {
  return {
    config: {
      apiUrl: "https://x.test",
      workspace: "test",
      token: "up_test_x",
      workspaceSource: "override",
    },
    client,
    json: false,
    quiet: true,
  };
}

const noRun: CommandRunner = () => {
  throw new Error("runner should not be called");
};

describe("runList --pr/--issue", () => {
  it("translates --pr to the gh prefix", async () => {
    const { client, prefixes } = fakeListClient();
    const code = await runList(
      ctxWith(client),
      ["--pr", "123", "--repo", "buildinternet/uploads"],
      false,
      noRun,
    );
    expect(code).toBe(0);
    expect(prefixes[0]).toBe("gh/buildinternet/uploads/pull/123/");
  });

  it("rejects --pr combined with --prefix", async () => {
    const { client } = fakeListClient();
    await expect(
      runList(ctxWith(client), ["--pr", "1", "--prefix", "x/", "--repo", "o/r"], false, noRun),
    ).rejects.toThrow(UsageError);
  });

  it("leaves plain --prefix behavior unchanged", async () => {
    const { client, prefixes } = fakeListClient();
    await runList(ctxWith(client), ["--prefix", "screenshots/"], false, noRun);
    expect(prefixes[0]).toBe("screenshots/");
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
pnpm --filter @buildinternet/uploads test
```

- [ ] **Step 3: Implement in `packages/uploads/src/commands.ts`**

Change `runList`'s signature:

```ts
export async function runList(
  ctx: CliContext,
  args: string[],
  help = false,
  run: CommandRunner = execRunner,
): Promise<number> {
```

Replace the line `const prefix = flagString(parsed.flags, "--prefix");` with:

```ts
let prefix = flagString(parsed.flags, "--prefix");
const ghTarget = ghTargetFromFlags(parsed.flags, run);
if (ghTarget) {
  if (prefix) throw new UsageError("--prefix cannot be combined with --pr/--issue");
  prefix = ghKeyPrefix(ghTarget);
}
```

Update `LIST_HELP` to:

```ts
const LIST_HELP = `uploads list [--prefix <p>] [--pr <num> | --issue <num>] [--repo <owner/name>] [--limit <n>] [--cursor <c>] [--all] [--workspace <name>]

Examples:
  uploads list --prefix screenshots/
  uploads list --pr 123
  uploads list --all --json
`;
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
pnpm --filter @buildinternet/uploads test
```

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm --filter @buildinternet/uploads typecheck
git add packages/uploads/src/commands.ts packages/uploads/test/commands-list.test.ts
git commit -m "feat(uploads): list --pr/--issue"
```

---

### Task 8: Public exports and docs sweep

**Files:**

- Modify: `packages/uploads/src/index.ts`
- Modify: `AGENTS.md` (repo root — one line)
- Modify: `packages/uploads/README.md` **only if it exists** (check with `ls packages/uploads/README.md`); skip silently if not.

**Interfaces:**

- Consumes: everything from Tasks 2–4.
- Produces: library consumers can import the GitHub helpers from `@buildinternet/uploads`.

- [ ] **Step 1: Add exports to `packages/uploads/src/index.ts`** (append)

```ts
export {
  ATTACHMENTS_MARKER,
  attachmentsCommentBody,
  ghAttachmentKey,
  ghKeyPrefix,
  isValidRepo,
  parseRepoFromRemoteUrl,
  type AttachmentItem,
  type GhTarget,
  type GhTargetKind,
} from "./github.js";
export {
  execRunner,
  resolveRepo,
  upsertAttachmentsComment,
  type CommandRunner,
} from "./github-gh.js";
```

- [ ] **Step 2: Update AGENTS.md**

In the `## Commands` code block in `AGENTS.md`, after the `pnpm uploads put <file> --env-file .env` line, add:

```
pnpm uploads put <file> --pr <num> --comment   # PR attachment + managed GitHub comment
```

- [ ] **Step 3: Full verification**

```bash
pnpm --filter @buildinternet/uploads test
pnpm typecheck
pnpm --filter @buildinternet/uploads build
node packages/uploads/bin/uploads.js --help 2>&1 | grep comment
```

Expected: tests pass, typecheck clean across workspaces, help shows the `comment` command.

- [ ] **Step 4: Commit**

```bash
git add packages/uploads/src/index.ts AGENTS.md
git commit -m "feat(uploads): export GitHub helpers; document PR attachments"
```

---

### Task 9: Update the `github-screenshots` skill (separate repo)

**Different repo:** `/Users/zachdunn/Code/buildinternet-skills`. Check `git -C /Users/zachdunn/Code/buildinternet-skills status` first; if the working tree is dirty, create a branch before committing and mention it in the task report. This task is documentation-only — do not modify the skill's `scripts/`.

**Files:**

- Modify: `/Users/zachdunn/Code/buildinternet-skills/skills/github-screenshots/SKILL.md`

**Interfaces:**

- Consumes: the CLI behavior shipped in Tasks 5–6 (`uploads put --pr/--issue [--comment]`).
- Produces: the skill instructs agents to prefer the uploads.sh CLI when configured, keeping direct-R2 as fallback.

- [ ] **Step 1: Add a "Preferred path" section to SKILL.md**

Insert the following section immediately after the `## Why this skill exists` section (before `## One-time setup`):

```markdown
## Preferred path: uploads.sh CLI

If the environment has `UPLOADS_TOKEN` set (or an `.env` with `UPLOADS_TOKEN`,
e.g. `~/Code/uploads/.env`), skip the R2 setup below and use the
`@buildinternet/uploads` CLI instead — it uploads via api.uploads.sh and
handles PR/issue organization:

    pnpm --dir ~/Code/uploads uploads put ./shot.png --pr 123 --env-file ~/Code/uploads/.env

- `--pr <num>` / `--issue <num>` store the file under a **stable key**
  (`gh/<owner>/<repo>/pull/<num>/<name>` — no content hash), so re-uploading a
  file with the same name updates every place the URL is already embedded.
  The command prints the URL and ready-to-paste markdown.
- Add `--comment` to also create/update a managed "Attachments" comment on
  the PR/issue through your local `gh` auth.
- The repo is inferred from the current git remote; pass `--repo owner/name`
  to override.
- Because URLs are stable per filename, embed once and re-upload to refresh
  the image — no need to edit the PR body again.

Fall back to the direct-R2 flow below only when uploads.sh credentials are
not available.
```

- [ ] **Step 2: Verify and commit (in the skills repo)**

```bash
git -C /Users/zachdunn/Code/buildinternet-skills diff
git -C /Users/zachdunn/Code/buildinternet-skills add skills/github-screenshots/SKILL.md
git -C /Users/zachdunn/Code/buildinternet-skills commit -m "github-screenshots: prefer uploads.sh CLI for PR/issue attachments"
```

Do **not** push; report the commit for the user to review.

---

### Task 10: Manual end-to-end verification

No code. Run against production with the **`buildinternet` workspace** (BYO bucket — its URLs are unaffected by the parallel shared-bucket-prefix work; see the spec's compatibility section). Credentials: `--env-file /Users/zachdunn/Code/uploads/.env` with `--workspace buildinternet`. Use a real test PR in `buildinternet/uploads` (an existing open PR or a scratch PR).

- [ ] **Step 1: Upload with `--pr`, capture URL**

```bash
pnpm --filter @buildinternet/uploads build
node packages/uploads/bin/uploads.js --env-file /Users/zachdunn/Code/uploads/.env --workspace buildinternet put <some.png> --pr <NUM> --repo buildinternet/uploads
```

Expected: key `gh/buildinternet/uploads/pull/<NUM>/<some.png>` and a URL that serves the image (curl it, expect 200 and correct content type).

- [ ] **Step 2: Replace the file, confirm the URL content changes**

Upload a _different_ image with the same filename and the same `--pr`. Expected: same key, same URL; `curl` now returns the new bytes. This is the core stable-URL guarantee — if the key gained a hash suffix, the implementation is wrong.

- [ ] **Step 3: Comment idempotence**

```bash
node packages/uploads/bin/uploads.js --env-file /Users/zachdunn/Code/uploads/.env --workspace buildinternet comment --pr <NUM> --repo buildinternet/uploads
```

Run it **twice**. Expected: first run prints `created attachments comment…`, second prints `updated…`; the PR shows exactly **one** comment containing "📎 Attachments" (check with `gh pr view <NUM> --comments`).

- [ ] **Step 4: Graceful degradation**

```bash
env PATH=/usr/bin:/bin "$(command -v node)" packages/uploads/bin/uploads.js --env-file /Users/zachdunn/Code/uploads/.env --workspace buildinternet put <some.png> --pr <NUM> --repo buildinternet/uploads --comment; echo "exit: $?"
```

(The stripped `PATH` hides `gh` from the child process; `$(command -v node)` resolves node's absolute path first so node itself still runs.) Expected: upload succeeds, URL prints, a `warning: upload succeeded but the GitHub comment failed…` line appears, exit code 0.

- [ ] **Step 5: Clean up**

Delete the test objects (`node packages/uploads/bin/uploads.js … delete gh/buildinternet/uploads/pull/<NUM>/<some.png>`) and the test comment if the PR was not a scratch PR. Report results.
