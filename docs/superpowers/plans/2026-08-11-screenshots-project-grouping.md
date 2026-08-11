# Project-Aware Screenshots Grouping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Group the Screenshots page by project (repo/origin) so paths from different repos stop interleaving, and start recording the capturing git repo as derived `repo` metadata.

**Architecture:** A project label (`repo` ?? `gh.repo` ?? origin from `url` ?? `"Other"`) is computed server-side inside the existing `files/by-path` aggregation, which now groups by (project, path) and returns a `projects` summary array. The web page renders nested per-project sections (overview), a `?project=` filtered view, and filters path drill-ins client-side with a small mirrored label helper. The CLI gains a derived `repo` metadata key from the git remote.

**Tech Stack:** TypeScript everywhere. API: Hono on Workers, D1 (`file_metadata` table), vitest with in-process fakes. CLI: `packages/uploads`. Web: Astro + React island, plain CSS.

**Spec:** `docs/superpowers/specs/2026-08-11-screenshots-project-grouping-design.md`

## Global Constraints

- Label precedence exactly: `repo` → `gh.repo` → origin (host) of `url` → literal `"Other"`.
- Derived `repo` values are `owner/name`, lowercase (matches the `gh.repo` convention), validated by `isValidRepo`.
- Derived metadata must never fail an upload (`mergeDerivedMeta` semantics: explicit keys win, over-cap derived keys drop silently).
- `--no-git` (and config `noGit`) suppresses the derived `repo` key; so does the shared derived-meta gate (`derivedMetaEnabled` / `UPLOADS_NO_DERIVED_META`).
- No new endpoints, no URL-prefix search, no backfill, no alias/merge of origin- vs repo-labeled buckets (spec "Out of scope").
- Old `?path=`-only links keep working (drill with no project filter).
- Run tests from the repo root with `pnpm test -- <path>` (plain vitest, unified root runner) or `pnpm --filter <pkg> test -- <file>` per package convention — check nearest package.json if unsure.
- Commit after every task; no changeset needed for web/api (ignored packages), **add a changeset** for the `uploads` CLI change (Task 4) — a changeset touching only ignored packages poisons the release, so scope it to the `uploads` package only.

---

### Task 1: Server-side project label helper

**Files:**

- Modify: `apps/api/src/file-metadata.ts` (add helper near `groupObjectsByPath`, ~line 655)
- Test: `apps/api/src/file-metadata-facets.test.ts`

**Interfaces:**

- Produces: `projectLabelFromMeta(meta: { repo?: string | null; ghRepo?: string | null; url?: string | null }): string` — exported from `apps/api/src/file-metadata.ts`. Later tasks (2) call it per row; the web mirror (Task 6) pins the same cases.

- [ ] **Step 1: Write the failing tests** — append to `file-metadata-facets.test.ts`:

```ts
import { projectLabelFromMeta } from "./file-metadata"; // add to existing import block

describe("projectLabelFromMeta", () => {
  it("prefers repo over gh.repo over url origin", () => {
    expect(
      projectLabelFromMeta({ repo: "acme/web", ghRepo: "acme/other", url: "https://x.dev/p" }),
    ).toBe("acme/web");
    expect(projectLabelFromMeta({ ghRepo: "acme/other", url: "https://x.dev/p" })).toBe(
      "acme/other",
    );
  });
  it("falls back to the url host, keeping the port", () => {
    expect(projectLabelFromMeta({ url: "https://uploads.localhost/settings" })).toBe(
      "uploads.localhost",
    );
    expect(projectLabelFromMeta({ url: "http://localhost:3000/admin" })).toBe("localhost:3000");
  });
  it("returns Other for missing or unparseable url", () => {
    expect(projectLabelFromMeta({})).toBe("Other");
    expect(projectLabelFromMeta({ url: "not a url" })).toBe("Other");
    expect(projectLabelFromMeta({ repo: null, ghRepo: null, url: null })).toBe("Other");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test -- apps/api/src/file-metadata-facets.test.ts`
Expected: FAIL — `projectLabelFromMeta` is not exported.

- [ ] **Step 3: Implement** in `apps/api/src/file-metadata.ts`:

```ts
/**
 * Project label for the screenshots page (spec:
 * docs/superpowers/specs/2026-08-11-screenshots-project-grouping-design.md).
 * Coalesces repo → gh.repo → url origin → "Other". Display/grouping only —
 * never stored. Mirrored (with identical cases) by
 * apps/web/src/lib/workspace-screenshots.ts.
 */
export function projectLabelFromMeta(meta: {
  repo?: string | null;
  ghRepo?: string | null;
  url?: string | null;
}): string {
  if (meta.repo) return meta.repo;
  if (meta.ghRepo) return meta.ghRepo;
  if (meta.url) {
    try {
      const host = new URL(meta.url).host;
      if (host) return host;
    } catch {
      // fall through — an unparseable url is just "no url"
    }
  }
  return "Other";
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test -- apps/api/src/file-metadata-facets.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/file-metadata.ts apps/api/src/file-metadata-facets.test.ts
git commit -m "feat(api): project label helper for screenshots grouping"
```

---

### Task 2: Group by (project, path) in the aggregation

**Files:**

- Modify: `apps/api/src/file-metadata.ts:657-722` (`groupObjectsByPath`, `PathGroup`)
- Test: `apps/api/src/file-metadata-facets.test.ts` (existing `groupObjectsByPath` describe, ~line 170)

**Interfaces:**

- Consumes: `projectLabelFromMeta` (Task 1).
- Produces: evolved `groupObjectsByPath(db, workspace)` returning
  `{ groups: PathGroup[]; projects: ProjectSummary[]; truncated: boolean }` where
  `PathGroup = { project: string; path: string; count: number; lastUpdated: string; recent: string[] }` and
  `ProjectSummary = { label: string; count: number; lastUpdated: string }` (exported types). `projects` ordered most-recent first; `groups` ordered by group recency as today.

- [ ] **Step 1: Write the failing tests.** In the existing `groupObjectsByPath` describe block, update existing assertions to expect `project` on each group (existing fixtures have no repo/gh.repo/url meta → `project: "Other"`, and `projects: [{ label: "Other", … }]`), and add:

```ts
it("splits the same path across projects and summarizes projects", async () => {
  const result = await groupObjectsByPath(
    metadataDb([
      { workspace: "acme", key: "a.png", meta: { path: "/admin", repo: "acme/web" } },
      { workspace: "acme", key: "b.png", meta: { path: "/admin", "gh.repo": "acme/api" } },
      { workspace: "acme", key: "c.png", meta: { path: "/admin", url: "https://x.dev/admin" } },
      { workspace: "acme", key: "d.png", meta: { path: "/other", repo: "acme/web" } },
    ]).DB,
    "acme",
  );
  expect(result.groups.map((g) => [g.project, g.path, g.count])).toEqual(
    expect.arrayContaining([
      ["acme/web", "/admin", 1],
      ["acme/api", "/admin", 1],
      ["x.dev", "/admin", 1],
      ["acme/web", "/other", 1],
    ]),
  );
  expect(result.groups).toHaveLength(4);
  const labels = result.projects.map((p) => p.label).sort();
  expect(labels).toEqual(["acme/api", "acme/web", "x.dev"]);
  expect(result.projects.find((p) => p.label === "acme/web")?.count).toBe(2);
});

it("prefers repo over gh.repo over url when a file has several", async () => {
  const result = await groupObjectsByPath(
    metadataDb([
      {
        workspace: "acme",
        key: "a.png",
        meta: { path: "/p", repo: "acme/web", "gh.repo": "acme/api", url: "https://x.dev/p" },
      },
    ]).DB,
    "acme",
  );
  expect(result.groups[0]).toMatchObject({ project: "acme/web", path: "/p" });
});
```

(Adapt the `metadataDb(...)` seeding call to however the existing tests in this file construct the fake D1 — reuse their exact helper and `.DB` access pattern.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test -- apps/api/src/file-metadata-facets.test.ts`
Expected: FAIL — no `project` on groups, no `projects` in result.

- [ ] **Step 3: Reimplement `groupObjectsByPath`.** Replace the windowed single-key SQL with a flat query joining the three label keys per object, then assemble groups in JS (rows arrive newest-first, so first-seen order is the recency order):

```ts
export type PathGroup = {
  project: string;
  path: string;
  count: number;
  lastUpdated: string;
  recent: string[];
};

export type ProjectSummary = { label: string; count: number; lastUpdated: string };

export async function groupObjectsByPath(
  db: D1Database,
  workspace: string,
): Promise<{ groups: PathGroup[]; projects: ProjectSummary[]; truncated: boolean }> {
  // One flat scan of the `path` rows (seeked via file_metadata_lookup_idx),
  // with the three project-label keys pulled per object via correlated
  // subselects on the same (workspace, object_key) index. Rows-read still
  // scales with path-tagged files. Grouping/windowing moves to JS because
  // the group key (project label) is a coalesce SQL can't express cleanly.
  const result = await db
    .prepare(
      `SELECT p.meta_value AS path, p.object_key AS object_key, p.updated_at AS updated_at,
              (SELECT meta_value FROM file_metadata m WHERE m.workspace = p.workspace AND m.object_key = p.object_key AND m.meta_key = 'repo') AS repo,
              (SELECT meta_value FROM file_metadata m WHERE m.workspace = p.workspace AND m.object_key = p.object_key AND m.meta_key = 'gh.repo') AS gh_repo,
              (SELECT meta_value FROM file_metadata m WHERE m.workspace = p.workspace AND m.object_key = p.object_key AND m.meta_key = 'url') AS url
       FROM file_metadata p
       WHERE p.workspace = ? AND p.meta_key = 'path'
       ORDER BY p.updated_at DESC, p.object_key ASC`,
    )
    .bind(workspace)
    .all<{
      path: string;
      object_key: string;
      updated_at: string;
      repo: string | null;
      gh_repo: string | null;
      url: string | null;
    }>();

  const groups: PathGroup[] = [];
  const byKey = new Map<string, PathGroup>();
  let truncated = false;
  for (const row of result.results) {
    const project = projectLabelFromMeta({ repo: row.repo, ghRepo: row.gh_repo, url: row.url });
    const groupKey = `${project} ${row.path}`;
    let group = byKey.get(groupKey);
    if (!group) {
      if (groups.length === BY_PATH_GROUP_LIMIT) {
        truncated = true;
        continue; // existing groups keep counting; new ones are dropped
      }
      group = { project, path: row.path, count: 0, lastUpdated: row.updated_at, recent: [] };
      byKey.set(groupKey, group);
      groups.push(group);
    }
    group.count += 1;
    if (group.recent.length < BY_PATH_RECENT_LIMIT) group.recent.push(row.object_key);
  }

  const projectByLabel = new Map<string, ProjectSummary>();
  for (const group of groups) {
    const existing = projectByLabel.get(group.project);
    if (existing) {
      existing.count += group.count;
      if (group.lastUpdated > existing.lastUpdated) existing.lastUpdated = group.lastUpdated;
    } else {
      projectByLabel.set(group.project, {
        label: group.project,
        count: group.count,
        lastUpdated: group.lastUpdated,
      });
    }
  }
  const projects = [...projectByLabel.values()].sort((a, b) =>
    b.lastUpdated.localeCompare(a.lastUpdated),
  );
  return { groups, projects, truncated };
}
```

Update the doc comment above the function to reference the new spec.

- [ ] **Step 4: Run to verify pass** (both new and pre-existing cases)

Run: `pnpm test -- apps/api/src/file-metadata-facets.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/file-metadata.ts apps/api/src/file-metadata-facets.test.ts
git commit -m "feat(api): group screenshots by (project, path)"
```

---

### Task 3: Route returns project + projects

**Files:**

- Modify: `apps/api/src/routes/workspace-files.ts:127-157` (the `files/by-path` handler)
- Test: `apps/api/src/routes/me.test.ts` (existing by-path describe, ~line 1800)

**Interfaces:**

- Consumes: Task 2's return shape.
- Produces: response JSON `{ groups: [{ project, path, count, lastUpdated, recent: [...] }], projects: [{ label, count, lastUpdated }], truncated }`. Task 5's client parser depends on exactly these field names.

- [ ] **Step 1: Write the failing test** — in the by-path describe in `me.test.ts`:

```ts
it("labels groups with a project and returns the projects summary", async () => {
  const db = metadataDb([
    { workspace: "acme", key: "w.png", meta: { path: "/admin", repo: "acme/web" } },
    { workspace: "acme", key: "o.png", meta: { path: "/admin", url: "https://x.dev/admin" } },
  ]);
  const env = memberEnv({ workspace: "acme", db, bucket: new FakeR2Bucket(), record: R2_RECORD });
  const res = await app().request("/me/workspaces/acme/files/by-path", {}, env);
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    groups: { project: string; path: string }[];
    projects: { label: string; count: number; lastUpdated: string }[];
  };
  expect(body.groups.map((g) => g.project).sort()).toEqual(["acme/web", "x.dev"]);
  expect(body.projects.map((p) => p.label).sort()).toEqual(["acme/web", "x.dev"]);
});
```

Also update the existing by-path test's expectation: its fixture (path-only meta) now yields `groups[0].project === "Other"`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test -- apps/api/src/routes/me.test.ts`
Expected: FAIL — no `project`/`projects` in the response.

- [ ] **Step 3: Implement** — in the handler, destructure and pass through:

```ts
const { groups, projects, truncated } = await groupObjectsByPath(c.env.DB, name);
// ... unchanged metadata/urls hydration ...
return c.json({
  groups: groups.map((group) => ({
    project: group.project,
    path: group.path,
    count: group.count,
    lastUpdated: group.lastUpdated,
    recent: group.recent.map((key) => {
      /* unchanged mapping */
    }),
  })),
  projects,
  truncated,
});
```

- [ ] **Step 4: Run to verify pass** — plus the workspace-files token-auth twin if it has its own by-path test (`grep -n "by-path" apps/api/src/routes/*.test.ts`).

Run: `pnpm test -- apps/api/src/routes/me.test.ts apps/api/src/file-metadata-facets.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/workspace-files.ts apps/api/src/routes/me.test.ts
git commit -m "feat(api): by-path response carries project labels"
```

---

### Task 4: CLI derived `repo` metadata

**Files:**

- Modify: `packages/uploads/src/keys.ts` (new `deriveRepoSlugFromGit` next to `deriveRepoFromGit`)
- Modify: `packages/uploads/src/metadata-vocab.ts:11-22` (`CANONICAL_META_KEYS`)
- Modify: `packages/uploads/src/commands.ts` (~line 2255, after the gh/staging/auto metadata branches)
- Modify: `packages/uploads/src/commands/screenshot.ts:436-439` (`withFacts`)
- Modify: `packages/uploads/src/mcp/tools.ts` (~line 846 screenshot tool, and the put tool's metadata assembly near line 500)
- Test: `packages/uploads/test/keys.test.ts`, `packages/uploads/test/commands-put.test.ts`, `packages/uploads/test/commands-screenshot.test.ts`
- Create: `.changeset/screenshots-derived-repo-meta.md`

**Interfaces:**

- Consumes: `parseRepoFromRemoteUrl` (`packages/uploads/src/github.ts`), `mergeDerivedMeta` (`metadata-vocab.ts`).
- Produces: `deriveRepoSlugFromGit(run?: (cmd: string, args: string[], input?: string) => string): string | undefined` exported from `keys.ts` — full `owner/name` lowercase slug or undefined. Uploads now carry `repo` metadata when derivable.

- [ ] **Step 1: Write the failing helper tests** in `keys.test.ts`:

```ts
import { deriveRepoSlugFromGit } from "../src/keys.js"; // extend existing import

describe("deriveRepoSlugFromGit", () => {
  it("parses ssh and https remotes to a lowercase owner/name slug", () => {
    expect(deriveRepoSlugFromGit(() => "git@github.com:BuildInternet/Uploads.git\n")).toBe(
      "buildinternet/uploads",
    );
    expect(deriveRepoSlugFromGit(() => "https://github.com/acme/web\n")).toBe("acme/web");
  });
  it("returns undefined when git fails or the remote is unparseable", () => {
    expect(
      deriveRepoSlugFromGit(() => {
        throw new Error("not a git repo");
      }),
    ).toBeUndefined();
    expect(deriveRepoSlugFromGit(() => "not-a-remote")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter uploads test -- keys.test.ts` (or root `pnpm test -- packages/uploads/test/keys.test.ts` — match how other CLI tests are run)
Expected: FAIL — not exported.

- [ ] **Step 3: Implement the helper** in `keys.ts` (import `parseRepoFromRemoteUrl` from `./github.js`):

```ts
/**
 * Full `owner/name` slug (lowercase, matching the `gh.repo` convention) from
 * the cwd's git remote — the derived `repo` metadata value. Unlike
 * `deriveRepoFromGit` above (key-segment name only), this keeps the owner.
 */
export function deriveRepoSlugFromGit(
  run?: (cmd: string, args: string[], input?: string) => string,
): string | undefined {
  try {
    const url = run
      ? run("git", ["config", "--get", "remote.origin.url"])
      : execSync("git config --get remote.origin.url", { encoding: "utf8" });
    return parseRepoFromRemoteUrl(url)?.toLowerCase();
  } catch {
    return undefined;
  }
}
```

Add `"repo"` to `CANONICAL_META_KEYS` in `metadata-vocab.ts` (alphabetical position irrelevant — append near `url`/`path`).

- [ ] **Step 4: Run helper tests to verify pass**, then **write the failing wiring tests**:

In `commands-put.test.ts` (reuse the file's existing runner-injection pattern — the fake `run` that answers `git config --get remote.origin.url`):

```ts
it("records derived repo metadata from the git remote", async () => {
  // seed runner: remote.origin.url → "git@github.com:Acme/Web.git"
  // run: uploads put <file>
  // assert: sentMetadata (or the request the fake client captured) includes repo: "acme/web"
});
it("suppresses derived repo with --no-git and lets --meta repo= win", async () => {
  // --no-git run: metadata has no `repo` key
  // --meta repo=custom/one run: metadata.repo === "custom/one"
});
```

In `commands-screenshot.test.ts`, mirror the positive + `--no-git` cases on the screenshot path. Flesh the test bodies out against the file's actual fake-client capture helpers (they exist — see how existing tests assert on uploaded metadata like `path`/`url`).

- [ ] **Step 5: Wire it in.**

`commands.ts` put path — after the `if (ghTarget) { … } else if (stagingTarget) { … } else { … }` metadata assembly (all three branches), add:

```ts
// Derived `repo` (spec: 2026-08-11-screenshots-project-grouping-design.md):
// the capturing repo, on every layout including gh/staging. mergeDerivedMeta
// keeps explicit --meta repo= wins and never breaks the caps.
if (!noGit && derivedMetaEnabled(parsed.flags, defaults)) {
  const slug = deriveRepoSlugFromGit(run);
  if (slug) metadata = mergeDerivedMeta(metadata, { repo: slug });
}
```

`commands/screenshot.ts` — extend the derived map at line ~436:

```ts
const repoSlug = deriveMeta && !noGit ? deriveRepoSlugFromGit(run) : undefined;
const withFacts = mergeDerivedMeta(explicitMeta, {
  ...(deriveMeta ? safeCaptureFacts(target, viewport, colorScheme) : {}),
  ...(repoSlug ? { repo: repoSlug } : {}),
});
```

`mcp/tools.ts` — same two insertions on the stdio MCP put and screenshot tools (they run in the caller's cwd; use each tool's existing `noGit` local and runner if one is threaded, else call `deriveRepoSlugFromGit()` bare). Follow the CLI comment convention ("Same derivation the CLI does").

- [ ] **Step 6: Run to verify pass**

Run: `pnpm test -- packages/uploads/test/keys.test.ts packages/uploads/test/commands-put.test.ts packages/uploads/test/commands-screenshot.test.ts packages/uploads/test/mcp-screenshot.test.ts`
Expected: PASS (fix any mcp-screenshot test that pins exact metadata maps).

- [ ] **Step 7: Changeset + commit**

`.changeset/screenshots-derived-repo-meta.md`:

```markdown
---
"uploads": minor
---

Derive `repo` metadata (owner/name from the git remote) on `put` and `screenshot`, suppressed by `--no-git`.
```

```bash
git add packages/uploads .changeset/screenshots-derived-repo-meta.md
git commit -m "feat(cli): derived repo metadata on put and screenshot"
```

---

### Task 5: Web client types + URL state helpers

**Files:**

- Modify: `apps/web/src/lib/api-client.ts:824-890` (types, guards, parser)
- Modify: `apps/web/src/lib/workspace-screenshots.ts` (label mirror + URL helpers)
- Test: `apps/web/src/lib/workspace-screenshots.test.ts` (and the api-client test file if one covers by-path parsing — `grep -n "by-path" apps/web/src/lib/*.test.ts`)

**Interfaces:**

- Consumes: Task 3's response shape.
- Produces (for Task 6):
  - `FilesPathGroup` gains `project: string`; `FilesByPathResult` ok-variant gains `projects: ProjectSummary[]` with `interface ProjectSummary { label: string; count: number; lastUpdated: string }`.
  - `projectLabelFromItemMeta(meta: Record<string, string> | undefined): string` — client mirror of `projectLabelFromMeta`, reading `meta.repo` / `meta["gh.repo"]` / `meta.url`.
  - `readScreenshotsView(search: string): { project: string; path: string }` (replaces `readScreenshotsPath`) and `screenshotsSearch(project: string, path: string): string` (project param first; "" omits).

- [ ] **Step 1: Write the failing tests** in `workspace-screenshots.test.ts`:

```ts
describe("projectLabelFromItemMeta", () => {
  // Pinned to the same cases as apps/api projectLabelFromMeta — keep in sync.
  it("prefers repo over gh.repo over url origin", () => {
    expect(
      projectLabelFromItemMeta({ repo: "acme/web", "gh.repo": "acme/api", url: "https://x.dev/p" }),
    ).toBe("acme/web");
    expect(projectLabelFromItemMeta({ "gh.repo": "acme/api" })).toBe("acme/api");
    expect(projectLabelFromItemMeta({ url: "http://localhost:3000/admin" })).toBe("localhost:3000");
  });
  it("returns Other for missing/unparseable", () => {
    expect(projectLabelFromItemMeta(undefined)).toBe("Other");
    expect(projectLabelFromItemMeta({})).toBe("Other");
    expect(projectLabelFromItemMeta({ url: "not a url" })).toBe("Other");
  });
});

describe("screenshots view URL state", () => {
  it("round-trips project and path", () => {
    expect(readScreenshotsView("?project=acme%2Fweb&path=%2Fadmin")).toEqual({
      project: "acme/web",
      path: "/admin",
    });
    expect(screenshotsSearch("acme/web", "/admin")).toBe("?project=acme%2Fweb&path=%2Fadmin");
    expect(screenshotsSearch("acme/web", "")).toBe("?project=acme%2Fweb");
    expect(screenshotsSearch("", "")).toBe("");
  });
  it("keeps legacy bare ?path= links working", () => {
    expect(readScreenshotsView("?path=%2Fadmin")).toEqual({ project: "", path: "/admin" });
    expect(screenshotsSearch("", "/admin")).toBe("?path=%2Fadmin");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test -- apps/web/src/lib/workspace-screenshots.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** in `workspace-screenshots.ts` (replacing `readScreenshotsPath`/`screenshotsSearch`):

```ts
/**
 * Client mirror of the API's projectLabelFromMeta (apps/api/src/file-metadata.ts)
 * — reimplemented per this page's convention; test cases pinned to the same
 * fixtures on both sides. Used to bucket search results and GitHub items
 * into their project sections.
 */
export function projectLabelFromItemMeta(meta: Record<string, string> | undefined): string {
  if (meta?.repo) return meta.repo;
  if (meta?.["gh.repo"]) return meta["gh.repo"];
  if (meta?.url) {
    try {
      const host = new URL(meta.url).host;
      if (host) return host;
    } catch {
      // unparseable url is just "no url"
    }
  }
  return "Other";
}

/** `?project=` / `?path=` view state, "" when absent. */
export function readScreenshotsView(search: string): { project: string; path: string } {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  return { project: params.get("project") ?? "", path: params.get("path") ?? "" };
}

/** Search string for a view ("" for both clears back to the overview). */
export function screenshotsSearch(project: string, path: string): string {
  const params = new URLSearchParams();
  if (project) params.set("project", project);
  if (path) params.set("path", path);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}
```

In `api-client.ts`: add `project: string` to `FilesPathGroup` + `isFilesPathGroup`; add

```ts
export interface ProjectSummary {
  label: string;
  count: number;
  lastUpdated: string;
}
```

with a guard (`label`/`count`/`lastUpdated` typeof checks), include `projects: ProjectSummary[]` in the ok-variant of `FilesByPathResult`, and validate/return it in `getWorkspaceFilesByPath` (malformed → `{ kind: "unavailable", reason: "malformed" }`, same as groups).

- [ ] **Step 4: Run to verify pass** — also typecheck the web app since the `readScreenshotsPath` rename breaks `ScreenshotsByPath.tsx` imports until Task 6; if the repo's checks would fail on it, fold the minimal component import fix into this task's commit or squash Tasks 5–6 into one commit at the end of Task 6.

Run: `pnpm test -- apps/web/src/lib/workspace-screenshots.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit** (or defer to Task 6's commit if the rename breaks the build)

```bash
git add apps/web/src/lib/api-client.ts apps/web/src/lib/workspace-screenshots.ts apps/web/src/lib/workspace-screenshots.test.ts
git commit -m "feat(web): project label mirror + project-aware view state"
```

---

### Task 6: Overview sections + project view in the component

**Files:**

- Modify: `apps/web/src/components/ScreenshotsByPath.tsx`
- Modify: `apps/web/src/styles/account-content.css` (`.wsp-*` block)

**Interfaces:**

- Consumes: Task 5's `FilesPathGroup.project`, `projects`, `projectLabelFromItemMeta`, `readScreenshotsView`, `screenshotsSearch`.
- Produces: the shipped UI. No exports consumed elsewhere.

- [ ] **Step 1: Restructure state.** Replace `drillPath` with a single view state:

```ts
const [view, setView] = useState<{ project: string; path: string }>(() =>
  readScreenshotsView(window.location.search),
);
```

URL-sync effect becomes `history.replaceState(null, "", window.location.pathname + screenshotsSearch(view.project, view.path))`; the drill fetch keys off `view.path` exactly as before (bare legacy `?path=` still fetches with `view.project === ""`).

- [ ] **Step 2: Overview rendering.** With `overview.groups` now project-labeled and `overview.projects` recency-ordered, plus GitHub items bucketed by `projectLabelFromItemMeta(item.metadata)`:

```ts
const PREVIEW_PATHS_PER_PROJECT = 3;
const ghByProject = new Map<string, SearchFileItem[]>();
if (ghState.status === "ready") {
  for (const item of ghState.items) {
    const label = projectLabelFromItemMeta(item.metadata);
    ghByProject.set(label, [...(ghByProject.get(label) ?? []), item]);
  }
}
// Section order: API projects (recency-ordered), then GH-only labels.
const sectionLabels = [
  ...overview.projects.map((p) => p.label),
  ...[...ghByProject.keys()].filter((l) => !overview.projects.some((p) => p.label === l)),
];
```

Each overview section renders: a project header (label + total count + `lastUpdatedLabel`, a "view project →" button calling `setView({ project: label, path: "" })`), the project's first `PREVIEW_PATHS_PER_PROJECT` path groups (existing `PathGroupSection`, whose `onDrill` now calls `setView({ project: group.project, path: group.path })`), and — when `ghByProject.has(label)` — the GitHub strip (existing `GitHubSection` markup, retitled "From GitHub" only inside the section). The empty state keeps its current copy and shows when there are no sections at all.

- [ ] **Step 3: Project view.** When `view.project && !view.path`: render "← all projects" (`setView({ project: "", path: "" })`), an `<h2>` with the label, then **all** of that project's path groups + its GitHub strip. Unknown label → the existing empty-state block with the title "No screenshots for this project". When `view.path`: current drill-in UI, but filter items when a project is set:

```ts
const drillItems =
  view.project === ""
    ? drill.items
    : drill.items.filter((item) => projectLabelFromItemMeta(item.metadata) === view.project);
```

Back-link from drill goes to the project view (`setView({ project: view.project, path: "" })`) when a project is set, else to the overview.

- [ ] **Step 4: CSS.** Add to the `.wsp-*` block in `account-content.css`: `.wsp-project` (section spacing), `.wsp-project__head` (flex row: label, meta, view-all — reuse the `.wsp-group__head` pattern one level up, slightly larger type), keeping the design-system tokens the file already uses. Match the existing class naming and custom-property usage — no new colors.

- [ ] **Step 5: Verify in the browser.** Follow the local signed-in recipe (memory: stack-raw on 127.0.0.1 is the only way to get a signed-in in-app-browser session — see `uploads local browser-verify recipe`): seed files across two fake projects (one `repo`-tagged, one url-only), then check overview sections, "view project →", path drill with mixed-project same-path files, legacy `?path=` link, and dark mode. Screenshot the overview for the PR.

- [ ] **Step 6: Full web test + typecheck pass**

Run: `pnpm test -- apps/web` and the repo's web typecheck (`pnpm --filter web typecheck` or as package.json names it).
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/ScreenshotsByPath.tsx apps/web/src/styles/account-content.css
git commit -m "feat(web): project sections and filtered view on screenshots page"
```

---

### Task 7: Full-suite verification + PR

- [ ] **Step 1:** `pnpm test` from the repo root — full unified runner. Expected: PASS.
- [ ] **Step 2:** `pnpm lint` (and `pnpm types` if the repo defines it — note memory: `pnpm types` ≠ typecheck; run the real typecheck target). Expected: clean.
- [ ] **Step 3:** Push the branch, open a PR against `main` titled "feat: project-aware grouping on the screenshots page", body covering: the label coalesce, the derived `repo` CLI key, the additive by-path shape, and the overview/project-view UX. Embed the Task 6 Step 5 screenshot via the `github-screenshots` skill (front-end change — a visual is warranted). Do not request a CodeRabbit review by default.
