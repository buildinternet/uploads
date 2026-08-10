# Screenshots-by-Path Browsing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Screenshots page in the workspace shell that shows recent uploads grouped by their `path` metadata value, with drill-in per path.

**Architecture:** One new windowed D1 query (`groupObjectsByPath` in `apps/api/src/file-metadata.ts`) behind one new session route (`GET /me/workspaces/:name/files/by-path`). One new Astro page mounting a React island; drill-in reuses the existing `/files/search?meta.path=…` route via the existing `searchWorkspaceFiles` client. Spec: `docs/superpowers/specs/2026-08-10-screenshots-by-path-design.md`.

**Tech Stack:** Hono (apps/api on Workers/D1), Astro + lazily-mounted React (apps/web), vitest with in-process fakes (`node:sqlite` for D1).

## Global Constraints

- **NEVER add a changeset.** `apps/api` / `apps/web` are changeset-ignored packages; a changeset naming them silently blocks every npm publish.
- Never edit any .env file.
- Repo test runner is plain vitest: `pnpm --filter @uploads/api test`, `pnpm --filter @uploads/web test`. Typecheck: `pnpm --filter @uploads/api typecheck`, `pnpm --filter @uploads/web typecheck` (if a `typecheck` script is missing, use the package's `types`/`check` script per its package.json — `pnpm types` at root is wrangler codegen, NOT a typecheck).
- Commits go through lint-staged hooks; let them run, don't `--no-verify`.
- Match surrounding comment density and style — comments state constraints, not narration.
- All work happens on the current branch (`claude/screenshot-browsing-by-path-2e99ce`).

---

### Task 1: `groupObjectsByPath` query

**Files:**

- Modify: `apps/api/src/file-metadata.ts` (add after `facetValues`, near line 632)
- Test: `apps/api/src/file-metadata-facets.test.ts` (append; reuse its `SQLiteD1` fake)

**Interfaces:**

- Consumes: existing `file_metadata` table, `SQLiteD1` test fake.
- Produces (Task 2 imports these from `./file-metadata`):

  ```ts
  export const BY_PATH_GROUP_LIMIT = 50;
  export const BY_PATH_RECENT_LIMIT = 6;
  export type PathGroup = { path: string; count: number; lastUpdated: string; recent: string[] };
  export async function groupObjectsByPath(
    db: D1Database,
    workspace: string,
  ): Promise<{ groups: PathGroup[]; truncated: boolean }>;
  ```

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/file-metadata-facets.test.ts`. The existing `db()` helper hardcodes one `updated_at`; recency tests need per-row timestamps, so add a sibling helper next to it:

```ts
/** Like `db()` but with a per-row timestamp, for recency-ordered queries. */
function timedDb(
  rows: Array<{ workspace: string; key: string; meta: Record<string, string>; at: string }>,
) {
  const database = new DatabaseSync(":memory:");
  database.exec(
    readFileSync(
      fileURLToPath(new NodeURL("../migrations/20260713210559_file_metadata.sql", import.meta.url)),
      "utf8",
    ),
  );
  const insert = database.prepare(
    "INSERT INTO file_metadata (workspace, object_key, meta_key, meta_value, updated_at) VALUES (?, ?, ?, ?, ?)",
  );
  for (const row of rows) {
    for (const [k, v] of Object.entries(row.meta)) {
      insert.run(row.workspace, row.key, k, v, row.at);
    }
  }
  return new SQLiteD1(database) as unknown as D1Database;
}
```

Add `groupObjectsByPath`, `BY_PATH_GROUP_LIMIT`, `BY_PATH_RECENT_LIMIT` to the import from `./file-metadata`, then:

```ts
describe("groupObjectsByPath", () => {
  const at = (i: number) => `2026-08-01T00:00:${String(i).padStart(2, "0")}.000Z`;

  it("groups keys by path value, most recently active group first", async () => {
    const result = await groupObjectsByPath(
      timedDb([
        { workspace: "acme", key: "a.png", meta: { path: "/settings" }, at: at(1) },
        { workspace: "acme", key: "b.png", meta: { path: "/home" }, at: at(2) },
        { workspace: "acme", key: "c.png", meta: { path: "/settings" }, at: at(3) },
      ]),
      "acme",
    );
    expect(result.truncated).toBe(false);
    expect(result.groups).toEqual([
      { path: "/settings", count: 2, lastUpdated: at(3), recent: ["c.png", "a.png"] },
      { path: "/home", count: 1, lastUpdated: at(2), recent: ["b.png"] },
    ]);
  });

  it("caps recent keys per group at BY_PATH_RECENT_LIMIT but counts all", async () => {
    const rows = Array.from({ length: BY_PATH_RECENT_LIMIT + 2 }, (_, i) => ({
      workspace: "acme",
      key: `shot-${i}.png`,
      meta: { path: "/home" },
      at: at(i),
    }));
    const result = await groupObjectsByPath(timedDb(rows), "acme");
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.count).toBe(BY_PATH_RECENT_LIMIT + 2);
    expect(result.groups[0]!.recent).toHaveLength(BY_PATH_RECENT_LIMIT);
    // Newest first — the two oldest fell off.
    expect(result.groups[0]!.recent[0]).toBe(`shot-${BY_PATH_RECENT_LIMIT + 1}.png`);
    expect(result.groups[0]!.recent).not.toContain("shot-0.png");
    expect(result.groups[0]!.recent).not.toContain("shot-1.png");
  });

  it("caps groups at BY_PATH_GROUP_LIMIT and reports truncation", async () => {
    const rows = Array.from({ length: BY_PATH_GROUP_LIMIT + 1 }, (_, i) => ({
      workspace: "acme",
      key: `shot-${i}.png`,
      meta: { path: `/page-${i}` },
      at: at(i),
    }));
    const result = await groupObjectsByPath(timedDb(rows), "acme");
    expect(result.groups).toHaveLength(BY_PATH_GROUP_LIMIT);
    expect(result.truncated).toBe(true);
    // Group cap keeps the most recently active groups, drops the oldest.
    expect(result.groups.map((g) => g.path)).not.toContain("/page-0");
  });

  it("ignores other workspaces and other meta keys", async () => {
    const result = await groupObjectsByPath(
      timedDb([
        { workspace: "acme", key: "a.png", meta: { path: "/home", state: "after" }, at: at(1) },
        { workspace: "other", key: "b.png", meta: { path: "/home" }, at: at(2) },
        { workspace: "acme", key: "c.png", meta: { app: "web" }, at: at(3) },
      ]),
      "acme",
    );
    expect(result.groups).toEqual([
      { path: "/home", count: 1, lastUpdated: at(1), recent: ["a.png"] },
    ]);
  });

  it("returns empty groups for a workspace with no path metadata", async () => {
    const result = await groupObjectsByPath(timedDb([]), "acme");
    expect(result).toEqual({ groups: [], truncated: false });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @uploads/api test -- file-metadata-facets`
Expected: FAIL — `groupObjectsByPath` is not exported.

- [ ] **Step 3: Implement**

In `apps/api/src/file-metadata.ts`, after `facetValues`:

```ts
/** Max path groups returned by `groupObjectsByPath`. */
export const BY_PATH_GROUP_LIMIT = 50;
/** Recent object keys returned per path group. */
export const BY_PATH_RECENT_LIMIT = 6;

export type PathGroup = {
  path: string;
  count: number;
  lastUpdated: string;
  recent: string[];
};

/**
 * Recent uploads grouped by their `path` metadata value — the screenshots
 * page's one query (spec: docs/superpowers/specs/2026-08-10-screenshots-by-path-design.md).
 * Groups come back most-recently-active first, each carrying its newest
 * BY_PATH_RECENT_LIMIT keys and total count.
 *
 * One windowed statement over the `path` rows only (seeked via
 * `file_metadata_lookup_idx (workspace, meta_key, meta_value)`), so rows-read
 * scales with path-tagged files, not the whole metadata table. For `path`
 * rows `updated_at` is effectively upload time — the key is written at
 * upload — which is what "recent" should mean here. The group cap is applied
 * while assembling (rows arrive grouped), keeping the newest groups.
 */
export async function groupObjectsByPath(
  db: D1Database,
  workspace: string,
): Promise<{ groups: PathGroup[]; truncated: boolean }> {
  const result = await db
    .prepare(
      `SELECT path, object_key, cnt, latest FROM (
         SELECT meta_value AS path, object_key,
                ROW_NUMBER() OVER (PARTITION BY meta_value ORDER BY updated_at DESC, object_key ASC) AS rn,
                COUNT(*) OVER (PARTITION BY meta_value) AS cnt,
                MAX(updated_at) OVER (PARTITION BY meta_value) AS latest
         FROM file_metadata
         WHERE workspace = ? AND meta_key = 'path'
       )
       WHERE rn <= ?
       ORDER BY latest DESC, path ASC, rn ASC`,
    )
    .bind(workspace, BY_PATH_RECENT_LIMIT)
    .all<{ path: string; object_key: string; cnt: number; latest: string }>();

  const groups: PathGroup[] = [];
  let truncated = false;
  for (const row of result.results) {
    const current = groups[groups.length - 1];
    if (current?.path === row.path) {
      current.recent.push(row.object_key);
      continue;
    }
    if (groups.length === BY_PATH_GROUP_LIMIT) {
      truncated = true;
      break;
    }
    groups.push({
      path: row.path,
      count: row.cnt,
      lastUpdated: row.latest,
      recent: [row.object_key],
    });
  }
  return { groups, truncated };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @uploads/api test -- file-metadata-facets`
Expected: PASS (all new tests plus the pre-existing facet tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/file-metadata.ts apps/api/src/file-metadata-facets.test.ts
git commit -m "feat(api): add groupObjectsByPath windowed query (#365 follow-on)"
```

---

### Task 2: `GET /me/workspaces/:name/files/by-path` route

**Files:**

- Modify: `apps/api/src/routes/me.ts` (insert after the `files/facets` route, ~line 639)
- Modify: `docs/superpowers/specs/2026-08-10-screenshots-by-path-design.md` (response example gains `url`/`embedUrl`)
- Test: `apps/api/src/routes/me.test.ts` (append near the `files/search` describe, ~line 1623)

**Interfaces:**

- Consumes: `groupObjectsByPath`, `BY_PATH_RECENT_LIMIT` (Task 1); existing `getMetadataForKeys`, `memberWorkspaceOr404`, `requireUserId`, `loadWorkspaceRecord`, `storageConfig`, `objectPublicUrls` — all already imported in `me.ts` except the Task 1 names (extend the existing `./file-metadata` import; `me.ts` already imports `getMetadataForKeys` from there).
- Produces: response consumed by Task 3:

  ```json
  {
    "groups": [
      {
        "path": "/settings",
        "count": 14,
        "lastUpdated": "…ISO…",
        "recent": [
          { "key": "…", "url": "https://…|null", "embedUrl": "https://…|null", "state": "after" }
        ]
      }
    ],
    "truncated": false
  }
  ```

  `state` is present only when set; no other metadata keys are returned.

- [ ] **Step 1: Amend the spec's response example**

The spec's response example lists `recent: [{ key, state }]` — the implementation must also return `url`/`embedUrl` (resolved server-side exactly like the sibling `files/search` route, needed for thumbnails). Update the JSON example in the spec's "Response shape" block to:

```json
{
  "groups": [
    {
      "path": "/settings",
      "count": 14,
      "lastUpdated": "2026-08-09T21:14:03Z",
      "recent": [
        {
          "key": "shots/settings-a3f9.webp",
          "url": "https://storage.uploads.sh/acme/shots/settings-a3f9.webp",
          "embedUrl": "https://storage.uploads.sh/acme/shots/settings-a3f9.webp",
          "state": "after"
        }
      ]
    }
  ],
  "truncated": false
}
```

and add below it: "`url`/`embedUrl` are resolved like the sibling `files/search` route (`objectPublicUrls`); both are `null` for workspaces without public storage URLs."

- [ ] **Step 2: Write the failing route tests**

Append to `apps/api/src/routes/me.test.ts` after the `files/search` describe block, following its `metadataDb` / `memberEnv` / `R2_RECORD` conventions exactly. Note: `metadataDb` (like the facets test `db()`) hardcodes one timestamp, which is fine here — single-group ordering isn't under test at the route layer (Task 1 covers ordering):

```ts
describe("GET /me/workspaces/:name/files/by-path", () => {
  it("groups path-tagged files with urls and state badges", async () => {
    const db = metadataDb([
      { workspace: "acme", key: "shots/a.png", meta: { path: "/settings", state: "after" } },
      { workspace: "acme", key: "shots/b.png", meta: { path: "/settings" } },
      { workspace: "acme", key: "shots/c.png", meta: { app: "web" } },
    ]);
    const env = memberEnv({ workspace: "acme", db, bucket: new FakeR2Bucket(), record: R2_RECORD });
    const res = await app().request("/me/workspaces/acme/files/by-path", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      groups: {
        path: string;
        count: number;
        lastUpdated: string;
        recent: { key: string; url: string | null; state?: string }[];
      }[];
      truncated: boolean;
    };
    expect(body.truncated).toBe(false);
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0]).toMatchObject({ path: "/settings", count: 2 });
    const byKey = Object.fromEntries(body.groups[0]!.recent.map((r) => [r.key, r]));
    expect(byKey["shots/a.png"]).toMatchObject({
      url: "https://storage.uploads.sh/acme/shots/a.png",
      state: "after",
    });
    // `state` is present only when set — no empty-string placeholder.
    expect(byKey["shots/b.png"]).not.toHaveProperty("state");
  });

  it("returns empty groups for a workspace with no path metadata", async () => {
    const env = memberEnv({
      workspace: "acme",
      db: metadataDb([]),
      bucket: new FakeR2Bucket(),
      record: R2_RECORD,
    });
    const res = await app().request("/me/workspaces/acme/files/by-path", {}, env);
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toEqual({ groups: [], truncated: false });
  });

  it("404s for a workspace the caller is not a member of", async () => {
    const env = memberEnv({ workspace: "acme", db: metadataDb([]), record: R2_RECORD });
    const res = await app().request("/me/workspaces/other/files/by-path", {}, env);
    expect(res.status).toBe(404);
  });
});
```

Check how the sibling `files/search` tests handle the signed-out case; if `memberEnv` has an unauthenticated variant used by neighbors (grep `401` in `me.test.ts`), add the same one-liner test here.

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @uploads/api test -- me.test`
Expected: FAIL — 404 on the new route (not yet defined).

- [ ] **Step 4: Implement the route**

In `apps/api/src/routes/me.ts`, directly after the `files/facets` route (before `file-url`); extend the `./file-metadata` import with `groupObjectsByPath`:

```ts
  // Recent uploads grouped by their `path` metadata value — the screenshots
  // page's single overview query (spec: docs/superpowers/specs/
  // 2026-08-10-screenshots-by-path-design.md). Drill-in reuses the sibling
  // `files/search?meta.path=…` route; this one only answers "which paths,
  // how recent, first few keys". Member- and record-gated exactly like the
  // facets route. `state` is the one metadata key enriched — the page badges
  // before/after and nothing else, so no other keys leak into the payload.
  .get("/workspaces/:name/files/by-path", async (c) => {
    const name = c.req.param("name");
    await memberWorkspaceOr404(c.env, requireUserId(c), name);

    const record = await loadWorkspaceRecord(c.env, name);
    if (!record) {
      throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
    }

    const { groups, truncated } = await groupObjectsByPath(c.env.DB, name);
    const metaByKey = await getMetadataForKeys(
      c.env.DB,
      name,
      groups.flatMap((group) => group.recent),
      { metaKeys: ["state"] },
    );
    const cfg = await storageConfig(c.env, record);

    return c.json({
      groups: groups.map((group) => ({
        path: group.path,
        count: group.count,
        lastUpdated: group.lastUpdated,
        recent: group.recent.map((key) => {
          const urls = objectPublicUrls(c.env, cfg, key);
          const state = metaByKey.get(key)?.state;
          return {
            key,
            url: urls.url,
            embedUrl: urls.embedUrl,
            ...(state !== undefined ? { state } : {}),
          };
        }),
      })),
      truncated,
    });
  })
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @uploads/api test -- me.test`
Expected: PASS. Then run the full API suite: `pnpm --filter @uploads/api test` — expected PASS (no regressions).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/me.ts apps/api/src/routes/me.test.ts docs/superpowers/specs/2026-08-10-screenshots-by-path-design.md
git commit -m "feat(api): session files/by-path route for the screenshots page"
```

---

### Task 3: `getWorkspaceFilesByPath` API client

**Files:**

- Modify: `apps/web/src/lib/api-client.ts` (add after `searchWorkspaceFiles`, ~line 821)
- Test: `apps/web/src/lib/api-client.test.ts` (append; mirror the `searchWorkspaceFiles` tests' fetch-stub pattern — read those tests first and copy their stubbing helper exactly)

**Interfaces:**

- Consumes: Task 2's response shape; existing `trimOrigin`, `fetchWithTimeout` (already imported in `api-client.ts`).
- Produces (Task 5 imports these from `../lib/api-client`):

  ```ts
  export interface PathGroupItem {
    key: string;
    url: string | null;
    embedUrl: string | null;
    state?: string;
  }
  export interface FilesPathGroup {
    path: string;
    count: number;
    lastUpdated: string;
    recent: PathGroupItem[];
  }
  export type FilesByPathResult =
    | { kind: "ok"; groups: FilesPathGroup[]; truncated: boolean }
    | { kind: "unavailable"; reason?: string };
  export async function getWorkspaceFilesByPath(
    apiOrigin: string,
    name: string,
  ): Promise<FilesByPathResult>;
  ```

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/src/lib/api-client.test.ts`, using the same fetch-stub helper its `searchWorkspaceFiles` describe uses (match names exactly — do not invent a new stub):

```ts
describe("getWorkspaceFilesByPath", () => {
  const GROUP = {
    path: "/settings",
    count: 2,
    lastUpdated: "2026-08-09T21:14:03.000Z",
    recent: [
      {
        key: "shots/a.png",
        url: "https://s.example/a.png",
        embedUrl: "https://s.example/a.png",
        state: "after",
      },
      { key: "shots/b.png", url: null, embedUrl: null },
    ],
  };

  it("returns groups on a well-formed response", async () => {
    // …stub fetch to 200 with { groups: [GROUP], truncated: false } using the file's helper…
    const result = await getWorkspaceFilesByPath("https://api.uploads.sh", "acme");
    expect(result).toEqual({ kind: "ok", groups: [GROUP], truncated: false });
    // …assert the stubbed URL was `/me/workspaces/acme/files/by-path`…
  });

  it("is unavailable on a malformed body", async () => {
    // …stub fetch to 200 with { groups: [{ path: 1 }] }…
    const result = await getWorkspaceFilesByPath("https://api.uploads.sh", "acme");
    expect(result.kind).toBe("unavailable");
  });

  it("is unavailable on a non-2xx response", async () => {
    // …stub fetch to 500…
    const result = await getWorkspaceFilesByPath("https://api.uploads.sh", "acme");
    expect(result.kind).toBe("unavailable");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @uploads/web test -- api-client`
Expected: FAIL — `getWorkspaceFilesByPath` not exported.

- [ ] **Step 3: Implement**

After `searchWorkspaceFiles` in `apps/web/src/lib/api-client.ts`:

```ts
/** One recent upload inside a `by-path` group. */
export interface PathGroupItem {
  key: string;
  url: string | null;
  embedUrl: string | null;
  /** Present only when the file carries `state` metadata (e.g. before/after). */
  state?: string;
}

/** One `path` metadata value with its recent uploads. */
export interface FilesPathGroup {
  path: string;
  count: number;
  lastUpdated: string;
  recent: PathGroupItem[];
}

export type FilesByPathResult =
  | { kind: "ok"; groups: FilesPathGroup[]; truncated: boolean }
  | { kind: "unavailable"; reason?: string };

function isPathGroupItem(value: unknown): value is PathGroupItem {
  const item = value as Record<string, unknown>;
  return (
    !!item &&
    typeof item.key === "string" &&
    (item.url === null || typeof item.url === "string") &&
    (item.embedUrl === null || typeof item.embedUrl === "string") &&
    (item.state === undefined || typeof item.state === "string")
  );
}

function isFilesPathGroup(value: unknown): value is FilesPathGroup {
  const group = value as Record<string, unknown>;
  return (
    !!group &&
    typeof group.path === "string" &&
    typeof group.count === "number" &&
    typeof group.lastUpdated === "string" &&
    Array.isArray(group.recent) &&
    group.recent.every(isPathGroupItem)
  );
}

/** GET /me/workspaces/:name/files/by-path — recent uploads grouped by `path` metadata. */
export async function getWorkspaceFilesByPath(
  apiOrigin: string,
  name: string,
): Promise<FilesByPathResult> {
  const url = `${trimOrigin(apiOrigin)}/me/workspaces/${encodeURIComponent(name)}/files/by-path`;
  const result = await fetchWithTimeout(url, { credentials: "include", cache: "no-store" });
  if (result.kind === "unavailable") return result;
  const { response } = result;
  if (!response.ok) return { kind: "unavailable", reason: "server" };
  const body = (await response.json().catch(() => null)) as {
    groups?: unknown;
    truncated?: unknown;
  } | null;
  if (
    !body ||
    !Array.isArray(body.groups) ||
    typeof body.truncated !== "boolean" ||
    !body.groups.every(isFilesPathGroup)
  ) {
    return { kind: "unavailable", reason: "malformed" };
  }
  return { kind: "ok", groups: body.groups, truncated: body.truncated };
}
```

(If `searchWorkspaceFiles`'s `SearchFilesResult` unavailable-variant carries `reason` differently, mirror that exactly instead.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @uploads/web test -- api-client`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/api-client.ts apps/web/src/lib/api-client.test.ts
git commit -m "feat(web): api client for files/by-path"
```

---

### Task 4: "screenshots" workspace nav tab

**Files:**

- Modify: `apps/web/src/lib/workspaces-nav.ts:28-41` (tab list + type) and `:249-263` (`workspaceTabFromPathname`)
- Modify: `apps/web/src/layouts/AccountLayout.astro:246-247` (inline pre-hydration fallback arrays)
- Test: `apps/web/src/lib/workspaces-nav.test.ts`

**Interfaces:**

- Produces: `WorkspaceNavTab` union gains `"screenshots"`; nav renders a `screenshots` link at `/account/workspaces/:name/screenshots` between `files` and `galleries`; `workspaceTabFromPathname("/account/workspaces/acme/screenshots")` returns `"screenshots"`.

- [ ] **Step 1: Write the failing tests**

Read `apps/web/src/lib/workspaces-nav.test.ts` first and match its existing test style for `workspaceTabFromPathname` / `renderWorkspaceSectionNavHtml`. Add:

```ts
it("maps /screenshots to the screenshots tab", () => {
  expect(workspaceTabFromPathname("/account/workspaces/acme/screenshots")).toBe("screenshots");
});

it("renders a screenshots link between files and galleries", () => {
  const html = renderWorkspaceSectionNavHtml("acme", "screenshots");
  expect(html).toContain('href="/account/workspaces/acme/screenshots"');
  expect(html.indexOf("screenshots")).toBeGreaterThan(html.indexOf("files"));
  expect(html.indexOf("screenshots")).toBeLessThan(html.indexOf("galleries"));
  expect(html).toContain('aria-current="page"');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @uploads/web test -- workspaces-nav`
Expected: FAIL — tab returns `""`, link missing.

- [ ] **Step 3: Implement**

In `workspaces-nav.ts`:

```ts
export type WorkspaceNavTab =
  | "files"
  | "screenshots"
  | "galleries"
  | "people"
  | "billing"
  | "settings";
```

Insert into `WORKSPACE_NAV_TABS` after `files`:

```ts
  { id: "screenshots", label: "screenshots", path: "/screenshots" },
```

In `workspaceTabFromPathname`, add alongside the `galleries` line:

```ts
if (segment === "screenshots") return "screenshots";
```

In `AccountLayout.astro:246-247` extend the inline fallback arrays (order must match the nav):

```js
var paths = ["", "/screenshots", "/galleries", "/people", "/billing", "/settings"];
var names = ["files", "screenshots", "galleries", "people", "billing", "settings"];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @uploads/web test -- workspaces-nav`
Expected: PASS (including all pre-existing nav tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/workspaces-nav.ts apps/web/src/lib/workspaces-nav.test.ts apps/web/src/layouts/AccountLayout.astro
git commit -m "feat(web): screenshots tab in workspace nav"
```

---

### Task 5: screenshots view helpers (`workspace-screenshots.ts`)

**Files:**

- Create: `apps/web/src/lib/workspace-screenshots.ts`
- Test: `apps/web/src/lib/workspace-screenshots.test.ts`

**Interfaces:**

- Produces (Task 6 imports all of these):

  ```ts
  export type ShotKind = "image" | "video" | "other";
  export function shotKindFromKey(key: string): ShotKind;
  export function lastUpdatedLabel(iso: string, now: Date): string; // "just now" | "5m ago" | "3h ago" | "4d ago" | "Jul 2"
  export function readScreenshotsPath(search: string): string; // ?path= value, "" when absent/blank
  export function screenshotsSearch(path: string): string; // "" or "?path=%2Fsettings"
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import {
  lastUpdatedLabel,
  readScreenshotsPath,
  screenshotsSearch,
  shotKindFromKey,
} from "./workspace-screenshots";

describe("shotKindFromKey", () => {
  it("classifies by extension, case-insensitively", () => {
    expect(shotKindFromKey("shots/hero.PNG")).toBe("image");
    expect(shotKindFromKey("a/b/c.webp")).toBe("image");
    expect(shotKindFromKey("demo.mp4")).toBe("video");
    expect(shotKindFromKey("notes.pdf")).toBe("other");
    expect(shotKindFromKey("no-extension")).toBe("other");
  });
});

describe("lastUpdatedLabel", () => {
  const now = new Date("2026-08-10T12:00:00.000Z");
  it("scales from minutes to a date", () => {
    expect(lastUpdatedLabel("2026-08-10T11:59:40.000Z", now)).toBe("just now");
    expect(lastUpdatedLabel("2026-08-10T11:55:00.000Z", now)).toBe("5m ago");
    expect(lastUpdatedLabel("2026-08-10T09:00:00.000Z", now)).toBe("3h ago");
    expect(lastUpdatedLabel("2026-08-06T12:00:00.000Z", now)).toBe("4d ago");
    expect(lastUpdatedLabel("2026-07-02T12:00:00.000Z", now)).toBe("Jul 2");
  });
  it("falls back to the raw string on an unparseable date", () => {
    expect(lastUpdatedLabel("garbage", now)).toBe("garbage");
  });
});

describe("screenshots path round-trip", () => {
  it("reads ?path= and ignores its absence", () => {
    expect(readScreenshotsPath("?path=%2Fsettings")).toBe("/settings");
    expect(readScreenshotsPath("?other=1")).toBe("");
    expect(readScreenshotsPath("")).toBe("");
  });
  it("writes a search string that reads back", () => {
    expect(readScreenshotsPath(screenshotsSearch("/settings"))).toBe("/settings");
    expect(screenshotsSearch("")).toBe("");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @uploads/web test -- workspace-screenshots`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
/**
 * Pure view helpers for the screenshots-by-path page (ScreenshotsByPath.tsx).
 * The `by-path` payload has no contentType (it comes from D1, not a storage
 * list), so media kind is inferred from the key's extension — same trade-off
 * the search results accept.
 */

export type ShotKind = "image" | "video" | "other";

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif", "avif"]);
const VIDEO_EXT = new Set(["mp4", "webm", "mov"]);

export function shotKindFromKey(key: string): ShotKind {
  const match = /\.([a-z0-9]{1,8})$/i.exec(key);
  const ext = match?.[1]?.toLowerCase() ?? "";
  if (IMAGE_EXT.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  return "other";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Compact recency label for a group header. Unparseable input passes through. */
export function lastUpdatedLabel(iso: string, now: Date): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return iso;
  const minutes = Math.floor((now.getTime() - then.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${MONTHS[then.getUTCMonth()]} ${then.getUTCDate()}`;
}

/** `?path=` drill-in value, "" when absent. */
export function readScreenshotsPath(search: string): string {
  return new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get("path") ?? "";
}

/** Search string for a drill-in URL ("" clears back to the overview). */
export function screenshotsSearch(path: string): string {
  if (!path) return "";
  const params = new URLSearchParams();
  params.set("path", path);
  return `?${params.toString()}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @uploads/web test -- workspace-screenshots`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/workspace-screenshots.ts apps/web/src/lib/workspace-screenshots.test.ts
git commit -m "feat(web): screenshots page view helpers"
```

---

### Task 6: `ScreenshotsByPath` component + page + styles

**Files:**

- Create: `apps/web/src/components/ScreenshotsByPath.tsx`
- Create: `apps/web/src/pages/account/workspaces/[name]/screenshots.astro`
- Modify: `apps/web/src/styles/account-content.css` (append a `wsp-` block)

No unit tests for the component itself (repo precedent: `WorkspaceFileTable` is browser-verified; its logic lives in tested libs, which Tasks 3–5 provided). Task 7 is the verification gate.

**Interfaces:**

- Consumes: `getWorkspaceFilesByPath`, `searchWorkspaceFiles`, `getMyWorkspaces` types via `resolveWorkspaceInfo` (`../lib/workspace-file-row`), `loadWorkspaces` (`../lib/workspaces-nav`), `onSession` (`../lib/account-shell`), `filePath` (`../lib/public-file`), `fetchWithTimeout` (`../lib/request`), Task 5 helpers, `MetaFilter` (`../lib/workspace-search-url`).
- Produces: `export function ScreenshotsByPath({ apiOrigin, workspace }: { apiOrigin: string; workspace: string }): JSX.Element`

- [ ] **Step 1: Write the component**

`apps/web/src/components/ScreenshotsByPath.tsx`. Structure (follow `WorkspaceFileTable`'s conventions for session gating and fetch effects — read its `useEffect` wiring around line 619 first):

```tsx
/**
 * Screenshots grouped by `path` metadata (spec:
 * docs/superpowers/specs/2026-08-10-screenshots-by-path-design.md).
 * Overview = one `files/by-path` fetch; drill-in (?path=) = the existing
 * `files/search?meta.path=…` route. Files without `path` metadata never
 * appear here — the empty state says how to get them.
 */
import { useEffect, useMemo, useState } from "react";
import {
  getWorkspaceFilesByPath,
  searchWorkspaceFiles,
  type FilesPathGroup,
  type SearchFileItem,
} from "../lib/api-client";
import { loadWorkspaces } from "../lib/workspaces-nav";
import { resolveWorkspaceInfo, type WorkspaceInfoStatus } from "../lib/workspace-file-row";
import { onSession } from "../lib/account-shell";
import { filePath } from "../lib/public-file";
import { fetchWithTimeout } from "../lib/request";
import {
  lastUpdatedLabel,
  readScreenshotsPath,
  screenshotsSearch,
  shotKindFromKey,
} from "../lib/workspace-screenshots";
```

State: `info: WorkspaceInfoStatus` (from `loadWorkspaces` + `resolveWorkspaceInfo`, kicked off inside `onSession`), `overview: { status: "loading" } | { status: "error" } | { status: "ready"; groups: FilesPathGroup[]; truncated: boolean }`, `drillPath: string` (init `readScreenshotsPath(window.location.search)`), `drill: { status: "idle" | "loading" | "error" } | { status: "ready"; items: SearchFileItem[]; truncated: boolean }`.

Behaviors:

- On mount (inside `onSession`): fetch overview; resolve info.
- `drillPath` changes → `history.replaceState(null, "", location.pathname + screenshotsSearch(drillPath))` and, when non-empty, `searchWorkspaceFiles(apiOrigin, workspace, [{ key: "path", value: drillPath }])`.
- Thumb rendering: `shotKindFromKey(item.key)` — `"image"` with `embedUrl` → `<span className="wsp-thumb" style={{ backgroundImage: \`url(${embedUrl})\` }} />`; `"image"`with`url === null` → lock tile (`wsp-thumb--tile`, same idea as `FileThumb`in`WorkspaceFileTable.tsx:210`); anything else → generic tile with the extension label.
- `state` present → `<span className="wsp-state">{state}</span>` badge on the tile.
- Open on click: `pageUrl ?? (hasPublicUrl ? filePath(workspace, key) : signed)` — copy the small `resolveSignedFileUrl` + `openFile` pattern from `WorkspaceFileTable.tsx:380-428` (they're module-private there; reimplement the ~15 lines rather than exporting, matching their about:blank-tab flow).
- Overview render: for each group, header row (`<button>` drilling in: `{group.path}` · `{group.count} files` · `{lastUpdatedLabel(group.lastUpdated, new Date())}` · "view all →") over a `wsp-strip` of its `recent` thumbs.
- Drill-in render: "← all paths" button (sets `drillPath` to `""`), heading with the path, `wsp-grid` of items, truncation note when `truncated`.
- Empty state (`groups.length === 0`): reuse the `ws-empty-state` classes (see `workspace-ui.ts:465`) with copy: title "No screenshots with a path yet", body explaining `uploads screenshot` records the page it captured automatically, and any upload can pass `--meta path=/settings`; link `/docs` if the galleries empty state links anywhere (mirror it).
- Loading: skeleton strips using the existing `.ws-skel` bar pattern (see `SkelBar`, `WorkspaceFileTable.tsx:~450`).
- Error: `Callout`-style retry, same as `AccountFileBrowser`'s error handling.

- [ ] **Step 2: Write the page**

`apps/web/src/pages/account/workspaces/[name]/screenshots.astro` — clone `[name].astro`'s structure exactly (placeholder div, `astro:before-swap` teardown, `onAstroPageLoad` boot, `resolveActiveWorkspace`), with: mount id `ws-screenshots`, dynamic import of `ScreenshotsByPath`, placeholder `<div id="ws-screenshots"></div>` (no HTML-string placeholder builder exists for this page; the component's own loading skeleton renders immediately after mount), and tip:

```ts
const tip = {
  body: "capture with <code>uploads screenshot https://app.example/settings</code> — the page path is recorded automatically and groups shots here.",
};
```

- [ ] **Step 3: Styles**

Append to `apps/web/src/styles/account-content.css` a `wsp-` block styled to sit beside the `wft-` table: group header row (flex, baseline, muted count/time), `wsp-strip` (horizontal flex of fixed-size thumbs, `overflow-x: auto`), `wsp-grid` (responsive `grid-template-columns: repeat(auto-fill, minmax(160px, 1fr))`), `wsp-thumb` (aspect-ratio 4/3, `background-size: cover`, border-radius matching `wft-thumb`), `wsp-thumb--tile` (centered muted glyph), `wsp-state` (absolute top-left pill, uppercase, 10px). Reuse existing CSS custom properties for colors/borders — copy variable names from the `wft-` rules in the same file, never hardcode hex.

- [ ] **Step 4: Typecheck and run the web suite**

Run: `pnpm --filter @uploads/web test` and the web package's typecheck script.
Expected: PASS / no type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ScreenshotsByPath.tsx "apps/web/src/pages/account/workspaces/[name]/screenshots.astro" apps/web/src/styles/account-content.css
git commit -m "feat(web): screenshots-by-path workspace page"
```

---

### Task 7: full verification

**Files:** none new — verification only.

- [ ] **Step 1: Full test run + typecheck**

Run: `pnpm test` at the repo root (unified runner) and both packages' typecheck scripts.
Expected: PASS everywhere. Fix anything red before proceeding.

- [ ] **Step 2: Browser verification (signed-in local stack)**

The ONLY way to get a signed-in session in the in-app browser is the raw-port stack on 127.0.0.1 (portless cannot work there — memory: "uploads local browser-verify recipe"). Follow that recipe to boot api/auth/web and seed a dev session. Then, with seeded `path`-tagged files (upload a few via the local API with `--meta path=/settings` / `--meta path=/home`, two carrying `state=before`/`state=after`):

1. Open `/account/workspaces/<ws>/screenshots` — groups render, most recent first; state badges visible; nav tab highlights.
2. Click a group — URL gains `?path=…`, grid renders; "← all paths" returns.
3. Reload with `?path=…` — drill-in restores from the URL.
4. Workspace with no path metadata — empty state with the CLI hint.
5. Check `read_console_messages` for errors; screenshot the grouped feed and drill-in for the PR.

**Expected:** all five pass with no console errors.

- [ ] **Step 3: Commit any fixes, then hand off**

Follow superpowers:finishing-a-development-branch — the branch is `claude/screenshot-browsing-by-path-2e99ce`, PR targets `main`. PR description embeds the two screenshots via the `github-screenshots` skill. Do not request a CodeRabbit review by default.
