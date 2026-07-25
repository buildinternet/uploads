# Workspace Search UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the workspace files-tab filter bar discoverable — surface the metadata keys and values a workspace actually contains, and make bare text search filenames instead of erroring.

**Architecture:** Two new read paths on the session-authed API (a facets route grouping `file_metadata`, and a `?name=` substring filter on the existing search route using `files-sdk`'s `search()`), consumed by a typeahead menu on the existing filter input. No new tables, no migration. All suggestion logic lives in a pure module so it is unit-testable in the repo's node-only test environment.

**Tech Stack:** Hono (API routes), Cloudflare D1 + R2, `files-sdk` 2.1.0, React 19 islands in Astro, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-25-workspace-search-ux-design.md`

## Global Constraints

- **No changeset.** `@uploads/api` and `@uploads/web` are in `.changeset/config.json`'s `ignore` list. A changeset naming an ignored package silently blocks every npm publish. Only `@buildinternet/uploads` may appear in a changeset header, and this plan does not touch that package.
- **No migration.** Every query reads the existing `file_metadata` table (`apps/api/migrations/20260713210559_file_metadata.sql`).
- **Test environment is node-only.** `vitest.projects.ts` sets no `environment`, and the repo has no jsdom or `@testing-library/react`. React components cannot be rendered in tests. Pure logic goes in `src/lib/*.ts` modules with `.test.ts` siblings — the existing pattern (`workspace-file-row.ts`, `workspace-search-url.ts`). Component wiring is verified in the browser.
- **Formatting.** The repo uses `oxfmt`, not prettier. A Husky pre-commit hook runs `pnpm types` then lint-staged; let it reformat rather than hand-formatting.
- **Metadata key rules** (mirrored client-side in `apps/web/src/lib/workspace-search-url.ts`): key `^[a-z][a-z0-9._-]{0,63}$`, value 1–512 printable ASCII, max 24 filters.
- **Test commands:** `pnpm test:api` and `pnpm test:web` for single packages; `pnpm test` for the whole suite.

---

## File Structure

**API (`apps/api/`)**

- `src/file-metadata.ts` — add `facetKeys()` and `facetValues()` next to the existing `findObjectsByMetadata`. This file already owns every `file_metadata` query; the new ones belong with them.
- `src/routes/me.ts` — add `GET /workspaces/:name/files/facets`; extend `GET /workspaces/:name/files/search` with `?name=`.
- `src/routes/me.test.ts` — new `describe` blocks alongside the existing `GET /me/workspaces/:name/files/search` suite, reusing its `metadataDb`, `memberEnv`, `R2_RECORD`, and `FakeR2Bucket` helpers.

**Web (`apps/web/`)**

- `src/lib/api-client.ts` — add `getWorkspaceFacets()`; add an options argument to `searchWorkspaceFiles()`.
- `src/lib/workspace-search-suggest.ts` — **new.** Pure suggestion-building: given the draft string, cached facets, and active filters, return the menu rows to display. All typeahead behaviour that can be tested lives here.
- `src/lib/workspace-search-suggest.test.ts` — **new.**
- `src/components/WorkspaceFileTable.tsx` — render the menu, wire keyboard handling, fetch and cache facets.
- `src/styles/account-content.css` — menu styles next to the existing `.wft-filterbar` rules (line ~992).
- Delete `src/components/MetadataSearchResults.tsx` and `src/components/WorkspaceFiles.tsx`.

---

### Task 1: Facet queries

**Files:**

- Modify: `apps/api/src/file-metadata.ts` (append after `findObjectsByMetadata`, which ends at line 517)
- Test: `apps/api/src/file-metadata-facets.test.ts` (create)

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces:
  - `FACET_KEY_LIMIT = 50`, `FACET_VALUE_LIMIT = 50` (exported consts)
  - `facetKeys(db: D1Database, workspace: string): Promise<{ keys: Array<{ key: string; count: number; distinctValues: number }>; truncated: boolean }>`
  - `facetValues(db: D1Database, workspace: string, key: string): Promise<{ values: Array<{ value: string; count: number }>; truncated: boolean }>`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/file-metadata-facets.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { describe, expect, it } from "vitest";
import { facetKeys, facetValues } from "./file-metadata";

class SQLiteStatement {
  values: unknown[] = [];
  constructor(
    readonly database: DatabaseSync,
    readonly sql: string,
  ) {}
  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }
  all<T>() {
    return Promise.resolve({
      success: true,
      results: this.database.prepare(this.sql).all(...(this.values as SQLInputValue[])) as T[],
      meta: {},
    } as D1Result<T>);
  }
}
class SQLiteD1 {
  constructor(readonly database: DatabaseSync) {}
  prepare(sql: string) {
    return new SQLiteStatement(this.database, sql);
  }
}

function db(rows: Array<{ workspace: string; key: string; meta: Record<string, string> }>) {
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
      insert.run(row.workspace, row.key, k, v, "2026-07-25T00:00:00.000Z");
    }
  }
  return new SQLiteD1(database) as unknown as D1Database;
}

describe("facetKeys", () => {
  it("returns each key with its file count and distinct-value count, most common first", async () => {
    const result = await facetKeys(
      db([
        { workspace: "acme", key: "a.png", meta: { "gh.repo": "o/r", app: "web" } },
        { workspace: "acme", key: "b.png", meta: { "gh.repo": "o/r", app: "api" } },
        { workspace: "acme", key: "c.png", meta: { "gh.repo": "o/other" } },
      ]),
      "acme",
    );
    expect(result.truncated).toBe(false);
    expect(result.keys).toEqual([
      { key: "gh.repo", count: 3, distinctValues: 2 },
      { key: "app", count: 2, distinctValues: 2 },
    ]);
  });

  it("excludes server-owned video.* keys", async () => {
    const result = await facetKeys(
      db([{ workspace: "acme", key: "v.mp4", meta: { "video.poster": "x", app: "web" } }]),
      "acme",
    );
    expect(result.keys.map((k) => k.key)).toEqual(["app"]);
  });

  it("does not leak another workspace's keys", async () => {
    const result = await facetKeys(
      db([
        { workspace: "acme", key: "a.png", meta: { app: "web" } },
        { workspace: "other", key: "b.png", meta: { secret: "yes" } },
      ]),
      "acme",
    );
    expect(result.keys.map((k) => k.key)).toEqual(["app"]);
  });
});

describe("facetValues", () => {
  it("returns each value with its count, most common first", async () => {
    const result = await facetValues(
      db([
        { workspace: "acme", key: "a.png", meta: { app: "web" } },
        { workspace: "acme", key: "b.png", meta: { app: "web" } },
        { workspace: "acme", key: "c.png", meta: { app: "api" } },
      ]),
      "acme",
      "app",
    );
    expect(result.truncated).toBe(false);
    expect(result.values).toEqual([
      { value: "web", count: 2 },
      { value: "api", count: 1 },
    ]);
  });

  it("flags truncation when more values exist than the cap", async () => {
    const rows = Array.from({ length: 55 }, (_, i) => ({
      workspace: "acme",
      key: `f${i}.png`,
      meta: { app: `v${i}` },
    }));
    const result = await facetValues(db(rows), "acme", "app");
    expect(result.values).toHaveLength(50);
    expect(result.truncated).toBe(true);
  });

  it("returns nothing for a server-owned key", async () => {
    const result = await facetValues(
      db([{ workspace: "acme", key: "v.mp4", meta: { "video.poster": "x" } }]),
      "acme",
      "video.poster",
    );
    expect(result.values).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:api -- file-metadata-facets`
Expected: FAIL — `facetKeys` / `facetValues` are not exported from `./file-metadata`.

- [ ] **Step 3: Write the implementation**

Append to `apps/api/src/file-metadata.ts`, after `findObjectsByMetadata` (which ends at line 517):

```ts
/** Max distinct meta keys returned by `facetKeys`. */
export const FACET_KEY_LIMIT = 50;
/** Max distinct values per key returned by `facetValues`. */
export const FACET_VALUE_LIMIT = 50;

/**
 * SQL fragment excluding server-owned namespaces from facet results. These
 * keys are not client-settable (`isServerMetaKey`), so offering them as
 * filters would advertise a filter the user cannot reproduce on upload.
 * Written as literal NOT LIKE legs rather than bound params because
 * SERVER_META_PREFIXES is a compile-time constant and D1 caps bound
 * parameters per query.
 */
const EXCLUDE_SERVER_KEYS = SERVER_META_PREFIXES.map(
  (prefix) => ` AND meta_key NOT LIKE '${prefix}%'`,
).join("");

/**
 * Distinct metadata keys in a workspace, with how many files carry each and
 * how many distinct values it has. `distinctValues` lets the UI tell a useful
 * facet (`app`, 3 values) from one that is effectively unique per file
 * (`path`, one value per object) before spending a round trip on it.
 *
 * Served by `file_metadata_lookup_idx (workspace, meta_key, meta_value)`.
 * Fetches one row beyond the cap so `truncated` is exact.
 */
export async function facetKeys(
  db: D1Database,
  workspace: string,
): Promise<{
  keys: Array<{ key: string; count: number; distinctValues: number }>;
  truncated: boolean;
}> {
  const result = await db
    .prepare(
      `SELECT meta_key, COUNT(*) AS count, COUNT(DISTINCT meta_value) AS distinct_values
       FROM file_metadata
       WHERE workspace = ?${EXCLUDE_SERVER_KEYS}
       GROUP BY meta_key
       ORDER BY count DESC, meta_key ASC
       LIMIT ?`,
    )
    .bind(workspace, FACET_KEY_LIMIT + 1)
    .all<{ meta_key: string; count: number; distinct_values: number }>();

  const truncated = result.results.length > FACET_KEY_LIMIT;
  const rows = truncated ? result.results.slice(0, FACET_KEY_LIMIT) : result.results;
  return {
    keys: rows.map((row) => ({
      key: row.meta_key,
      count: row.count,
      distinctValues: row.distinct_values,
    })),
    truncated,
  };
}

/**
 * Distinct values for one metadata key, most common first. Fetched lazily by
 * the UI when a key is selected, so a workspace with forty keys costs one
 * grouped query on open rather than forty.
 *
 * Rides the same index as an exact prefix seek (workspace + meta_key), so
 * rows-read is proportional to the one key rather than the whole workspace.
 */
export async function facetValues(
  db: D1Database,
  workspace: string,
  key: string,
): Promise<{ values: Array<{ value: string; count: number }>; truncated: boolean }> {
  if (isServerMetaKey(key)) return { values: [], truncated: false };

  const result = await db
    .prepare(
      `SELECT meta_value, COUNT(*) AS count
       FROM file_metadata
       WHERE workspace = ? AND meta_key = ?
       GROUP BY meta_value
       ORDER BY count DESC, meta_value ASC
       LIMIT ?`,
    )
    .bind(workspace, key, FACET_VALUE_LIMIT + 1)
    .all<{ meta_value: string; count: number }>();

  const truncated = result.results.length > FACET_VALUE_LIMIT;
  const rows = truncated ? result.results.slice(0, FACET_VALUE_LIMIT) : result.results;
  return {
    values: rows.map((row) => ({ value: row.meta_value, count: row.count })),
    truncated,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:api -- file-metadata-facets`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/file-metadata.ts apps/api/src/file-metadata-facets.test.ts
git commit -m "feat(api): add facet queries over file_metadata"
```

---

### Task 2: Facets route

**Files:**

- Modify: `apps/api/src/routes/me.ts` (add after the `files/search` route, which ends at line 447)
- Test: `apps/api/src/routes/me.test.ts` (append a new `describe` after the existing `GET /me/workspaces/:name/files/search` block, which ends at line 1671)

**Interfaces:**

- Consumes: `facetKeys`, `facetValues` from Task 1.
- Produces: `GET /me/workspaces/:name/files/facets` returning `{ keys, truncated }`, or `{ key, values, truncated }` when `?key=` is present.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/routes/me.test.ts`:

```ts
describe("GET /me/workspaces/:name/files/facets", () => {
  it("lists the workspace's metadata keys with counts", async () => {
    const db = metadataDb([
      { workspace: "acme", key: "a.png", meta: { "gh.repo": "o/r", app: "web" } },
      { workspace: "acme", key: "b.png", meta: { "gh.repo": "o/r" } },
    ]);
    const env = memberEnv({ workspace: "acme", db, record: R2_RECORD });
    const res = await app().request("/me/workspaces/acme/files/facets", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      keys: [
        { key: "gh.repo", count: 2, distinctValues: 1 },
        { key: "app", count: 1, distinctValues: 1 },
      ],
      truncated: false,
    });
  });

  it("lists one key's values when ?key= is given", async () => {
    const db = metadataDb([
      { workspace: "acme", key: "a.png", meta: { app: "web" } },
      { workspace: "acme", key: "b.png", meta: { app: "web" } },
      { workspace: "acme", key: "c.png", meta: { app: "api" } },
    ]);
    const env = memberEnv({ workspace: "acme", db, record: R2_RECORD });
    const res = await app().request("/me/workspaces/acme/files/facets?key=app", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      key: "app",
      values: [
        { value: "web", count: 2 },
        { value: "api", count: 1 },
      ],
      truncated: false,
    });
  });

  it("rejects a malformed key with file_metadata_invalid_key", async () => {
    const env = memberEnv({ workspace: "acme", db: metadataDb([]), record: R2_RECORD });
    const res = await app().request("/me/workspaces/acme/files/facets?key=BadKey", {}, env);
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "file_metadata_invalid_key" },
    });
  });

  it("404s for a workspace the caller is not a member of", async () => {
    const env = memberEnv({ workspace: "acme", db: metadataDb([]), record: R2_RECORD });
    const res = await app().request("/me/workspaces/other/files/facets", {}, env);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:api -- routes/me`
Expected: FAIL — the facets requests 404, because the route does not exist.

- [ ] **Step 3: Write the implementation**

In `apps/api/src/routes/me.ts`, extend the existing import from `../file-metadata` to include `facetKeys`, `facetValues`, and `META_KEY_RE`, then add this route immediately after the `files/search` route (after line 447's `})`):

```ts
  // Facet discovery for the files-tab filter bar: which metadata keys this
  // workspace actually contains, and (with `?key=`) that key's values. The
  // filter bar cannot otherwise tell a user what is filterable — keys are
  // user- and agent-defined, not a schema. Member-gated exactly as the
  // sibling search route is.
  .get("/workspaces/:name/files/facets", async (c) => {
    const name = c.req.param("name");
    await memberWorkspaceOr404(c.env, requireUserId(c), name);

    const key = c.req.query("key");
    if (key === undefined) {
      return c.json(await facetKeys(c.env.DB, name));
    }
    if (!META_KEY_RE.test(key)) {
      throw new ValidationError(`invalid metadata key: ${key}`, {
        code: "file_metadata_invalid_key",
        details: { key },
      });
    }
    const { values, truncated } = await facetValues(c.env.DB, name, key);
    return c.json({ key, values, truncated });
  })
```

Note: this route does not call `loadWorkspaceRecord` — it reads only D1 and never needs storage config, unlike the search route above it.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:api -- routes/me`
Expected: PASS, including the four new tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/me.ts apps/api/src/routes/me.test.ts
git commit -m "feat(api): add GET /me/workspaces/:name/files/facets"
```

---

### Task 3: Filename search

**Files:**

- Modify: `apps/api/src/routes/me.ts:400-447` (the `files/search` route)
- Test: `apps/api/src/routes/me.test.ts` (append to the existing `files/search` describe block)

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `?name=<term>` on `GET /me/workspaces/:name/files/search`, combinable with `meta.*`. Response shape is unchanged: `{ items, truncated }`.

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe("GET /me/workspaces/:name/files/search", …)` block in `apps/api/src/routes/me.test.ts`:

```ts
it("matches filenames case-insensitively by substring with ?name=", async () => {
  const bucket = new FakeR2Bucket();
  await bucket.put("acme/screenshots/Hero-Shot.png", "x");
  await bucket.put("acme/screenshots/footer.png", "x");
  const env = memberEnv({ workspace: "acme", db: metadataDb([]), bucket, record: R2_RECORD });
  const res = await app().request("/me/workspaces/acme/files/search?name=hero", {}, env);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: { key: string }[]; truncated: boolean };
  expect(body.items.map((i) => i.key)).toEqual(["screenshots/Hero-Shot.png"]);
  expect(body.truncated).toBe(false);
});

it("treats the term as a literal substring, not a glob", async () => {
  const bucket = new FakeR2Bucket();
  await bucket.put("acme/report.png", "x");
  const env = memberEnv({ workspace: "acme", db: metadataDb([]), bucket, record: R2_RECORD });
  const res = await app().request("/me/workspaces/acme/files/search?name=re*ort", {}, env);
  expect(res.status).toBe(200);
  expect(((await res.json()) as { items: unknown[] }).items).toEqual([]);
});

it("narrows metadata results by name without walking storage", async () => {
  const db = metadataDb([
    { workspace: "acme", key: "f/hero.png", meta: { app: "web" } },
    { workspace: "acme", key: "f/footer.png", meta: { app: "web" } },
  ]);
  // The bucket is empty: these two keys exist only in D1. If this path
  // walked storage instead of filtering the metadata results, it would
  // return nothing.
  const env = memberEnv({ workspace: "acme", db, bucket: new FakeR2Bucket(), record: R2_RECORD });
  const res = await app().request(
    "/me/workspaces/acme/files/search?meta.app=web&name=hero",
    {},
    env,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: { key: string }[] };
  expect(body.items.map((i) => i.key)).toEqual(["f/hero.png"]);
});

it("caps name results at 100 and flags truncation", async () => {
  const bucket = new FakeR2Bucket();
  for (let i = 0; i < 120; i++) await bucket.put(`acme/shot-${i}.png`, "x");
  const env = memberEnv({ workspace: "acme", db: metadataDb([]), bucket, record: R2_RECORD });
  const res = await app().request("/me/workspaces/acme/files/search?name=shot", {}, env);
  const body = (await res.json()) as { items: unknown[]; truncated: boolean };
  expect(body.items).toHaveLength(100);
  expect(body.truncated).toBe(true);
});

it("rejects a blank name with file_search_invalid_name", async () => {
  const env = memberEnv({ workspace: "acme", db: metadataDb([]), record: R2_RECORD });
  const res = await app().request("/me/workspaces/acme/files/search?name=%20%20", {}, env);
  expect(res.status).toBe(400);
  expect((await res.json()) as { error: { code: string } }).toMatchObject({
    error: { code: "file_search_invalid_name" },
  });
});

it("rejects a name longer than 128 characters", async () => {
  const env = memberEnv({ workspace: "acme", db: metadataDb([]), record: R2_RECORD });
  const res = await app().request(
    `/me/workspaces/acme/files/search?name=${"a".repeat(129)}`,
    {},
    env,
  );
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:api -- routes/me`
Expected: FAIL — `?name=` alone 400s with "at least one meta.\* filter is required".

- [ ] **Step 3: Write the implementation**

Replace the body of the `files/search` route in `apps/api/src/routes/me.ts` (lines 400–447) with:

```ts
  .get("/workspaces/:name/files/search", async (c) => {
    const name = c.req.param("name");
    await memberWorkspaceOr404(c.env, requireUserId(c), name);

    const record = await loadWorkspaceRecord(c.env, name);
    if (!record) {
      throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
    }

    const query = c.req.query();
    const metaParamKeys = Object.keys(query).filter((k) => k.startsWith("meta."));
    const rawName = c.req.query("name");
    const nameTerm = rawName === undefined ? undefined : normalizeSearchName(rawName);

    if (metaParamKeys.length === 0 && nameTerm === undefined) {
      throw new ValidationError("at least one meta.* filter or name is required", {
        code: "file_metadata_invalid_key",
      });
    }

    const filters: Record<string, string> = {};
    for (const param of metaParamKeys) {
      const key = param.slice("meta.".length);
      const values = c.req.queries(param) ?? [];
      if (values.length > 1) {
        throw new ValidationError(`repeated metadata filter for key: ${key}`, {
          code: "file_metadata_duplicate_filter",
          details: { key },
        });
      }
      filters[key] = values[0] ?? query[param];
    }
    if (metaParamKeys.length > 0) validateMetadataFilters(filters);

    const SEARCH_LIMIT = 100;
    const cfg = await storageConfig(c.env, record);

    // NOTE (post-execution correction): the two-path block below was found in
    // review to under-report `truncated`. `findObjectsByMetadata` caps at
    // SEARCH_LIMIT + 1 ordered by object_key, so filtering its results by name
    // in memory and then computing `truncated` from the filtered count reports
    // `false` while silently omitting name-matching objects beyond the D1
    // window. Truncation must be computed PER PATH from that path's own cap:
    // `found.length > SEARCH_LIMIT` on the metadata path (before the name
    // filter), `matches.length > SEARCH_LIMIT` on the name-only path. The
    // shipped code in apps/api/src/routes/me.ts is the corrected version.

    // Two paths. With metadata filters the D1 index is the selective one and
    // already caps at SEARCH_LIMIT, so a name term narrows those rows in
    // memory and storage is never walked. Name alone has no index to use, so
    // it walks via files-sdk `search()` — `maxResults` stops the walk as soon
    // as the cap is reached rather than traversing the whole workspace.
    let matches: Array<{ key: string; metadata: Record<string, string> }>;
    if (metaParamKeys.length > 0) {
      const found = await findObjectsByMetadata(c.env.DB, name, filters, {
        prefix: query.prefix,
        limit: SEARCH_LIMIT + 1,
      });
      matches = nameTerm
        ? found.filter((match) => match.key.toLowerCase().includes(nameTerm))
        : found;
    } else {
      const store = await storage(c.env, record);
      const keys: string[] = [];
      for await (const file of store.search(nameTerm!, {
        match: "substring",
        caseInsensitive: true,
        maxResults: SEARCH_LIMIT + 1,
        ...(query.prefix ? { prefix: query.prefix } : {}),
      })) {
        keys.push(file.key);
      }
      const metaByKey = await getMetadataForKeys(c.env.DB, name, keys);
      matches = keys.map((key) => ({ key, metadata: metaByKey.get(key) ?? {} }));
    }

    const truncated = matches.length > SEARCH_LIMIT;
    const page = truncated ? matches.slice(0, SEARCH_LIMIT) : matches;
    return c.json({
      items: page.map((match) => {
        const urls = objectPublicUrls(c.env, cfg, match.key);
        return { key: match.key, url: urls.url, embedUrl: urls.embedUrl, metadata: match.metadata };
      }),
      truncated,
    });
  })
```

Add this helper near the top of `apps/api/src/routes/me.ts`, below the imports:

```ts
/** Max characters accepted in a `?name=` filename search term. */
const SEARCH_NAME_MAX = 128;

/**
 * Validate and normalize a `?name=` term. Lowercased here so the substring
 * comparison against object keys needs no per-row casing work. Always passed
 * to files-sdk as a `substring` pattern, never `glob` or `regex`: glob would
 * make `*` and `?` silently meaningful in a box where people type filenames,
 * and a user-supplied regex would be a denial-of-service vector.
 */
function normalizeSearchName(raw: string): string {
  const term = raw.trim();
  if (term.length === 0 || term.length > SEARCH_NAME_MAX) {
    throw new ValidationError("name must be 1–128 characters", {
      code: "file_search_invalid_name",
    });
  }
  return term.toLowerCase();
}
```

Extend the existing imports in `apps/api/src/routes/me.ts`: add `getMetadataForKeys` to the `../file-metadata` import if not already present, and `storage` to the `../storage` import (which currently brings in `objectPublicUrls` and `storageConfig`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:api -- routes/me`
Expected: PASS. The pre-existing "requires at least one meta._ filter" test still passes — a request with neither `name` nor `meta._` still 400s.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/me.ts apps/api/src/routes/me.test.ts
git commit -m "feat(api): match filenames with ?name= on workspace file search"
```

---

### Task 4: Web API client

**Files:**

- Modify: `apps/web/src/lib/api-client.ts` (`searchWorkspaceFiles` is at line 772)
- Test: `apps/web/src/lib/api-client.test.ts`

**Interfaces:**

- Consumes: the routes from Tasks 2 and 3.
- Produces:
  - `interface FacetKey { key: string; count: number; distinctValues: number }`
  - `interface FacetValue { value: string; count: number }`
  - `type FacetsResult = { kind: "ok"; keys: FacetKey[]; truncated: boolean } | { kind: "unavailable" }`
  - `getWorkspaceFacets(apiOrigin: string, name: string): Promise<FacetsResult>`
  - `getWorkspaceFacetValues(apiOrigin: string, name: string, key: string): Promise<{ kind: "ok"; values: FacetValue[]; truncated: boolean } | { kind: "unavailable" }>`
  - `searchWorkspaceFiles(apiOrigin, name, filters, opts?: { name?: string })` — third argument unchanged, new optional fourth.

- [ ] **Step 1: Write the failing test**

Append to `apps/web/src/lib/api-client.test.ts`:

```ts
describe("getWorkspaceFacets", () => {
  it("returns keys from the facets route", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        keys: [{ key: "app", count: 2, distinctValues: 2 }],
        truncated: false,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await getWorkspaceFacets("https://api.test", "acme");
    expect(result).toEqual({
      kind: "ok",
      keys: [{ key: "app", count: 2, distinctValues: 2 }],
      truncated: false,
    });
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.test/me/workspaces/acme/files/facets");
  });

  it("reports unavailable on a malformed body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ keys: "nope" })),
    );
    expect(await getWorkspaceFacets("https://api.test", "acme")).toEqual({ kind: "unavailable" });
  });

  it("reports unavailable on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 500 })),
    );
    expect(await getWorkspaceFacets("https://api.test", "acme")).toEqual({ kind: "unavailable" });
  });
});

describe("searchWorkspaceFiles with a name term", () => {
  it("sends ?name= alongside meta filters", async () => {
    const fetchMock = vi.fn(async () => Response.json({ items: [], truncated: false }));
    vi.stubGlobal("fetch", fetchMock);
    await searchWorkspaceFiles("https://api.test", "acme", [{ key: "app", value: "web" }], {
      name: "hero",
    });
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://api.test/me/workspaces/acme/files/search?meta.app=web&name=hero",
    );
  });

  it("sends only ?name= when there are no filters", async () => {
    const fetchMock = vi.fn(async () => Response.json({ items: [], truncated: false }));
    vi.stubGlobal("fetch", fetchMock);
    await searchWorkspaceFiles("https://api.test", "acme", [], { name: "hero" });
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://api.test/me/workspaces/acme/files/search?name=hero",
    );
  });
});
```

Add `getWorkspaceFacets` to the existing import from `./api-client` at the top of the test file. Check the file's existing tests for the `vi.stubGlobal("fetch", …)` convention and match it — if the file already has a `beforeEach`/`afterEach` restoring globals, rely on that rather than adding your own.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:web -- api-client`
Expected: FAIL — `getWorkspaceFacets` is not exported.

- [ ] **Step 3: Write the implementation**

In `apps/web/src/lib/api-client.ts`, replace `searchWorkspaceFiles` (line 772) with the version below and add the facets functions after it:

```ts
/** GET /me/workspaces/:name/files/search — session-authed metadata + name search. */
export async function searchWorkspaceFiles(
  apiOrigin: string,
  name: string,
  filters: MetaFilter[],
  opts: { name?: string } = {},
): Promise<SearchFilesResult> {
  const params = new URLSearchParams(buildSearchQuery(filters));
  if (opts.name) params.set("name", opts.name);
  const url = `${trimOrigin(apiOrigin)}/me/workspaces/${encodeURIComponent(name)}/files/search?${params.toString()}`;
  const result = await fetchWithTimeout(url, { credentials: "include", cache: "no-store" });
  if (result.kind === "unavailable") return result;
  const { response } = result;
  if (!response.ok) return { kind: "unavailable", reason: "server" };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: "unavailable", reason: "malformed" };
  }
  const b = body as { items?: unknown; truncated?: unknown };
  if (
    !Array.isArray(b.items) ||
    typeof b.truncated !== "boolean" ||
    !b.items.every(isSearchFileItem)
  ) {
    return { kind: "unavailable", reason: "malformed" };
  }
  return { kind: "ok", items: b.items, truncated: b.truncated };
}

/** One metadata key present in a workspace, with its file and value counts. */
export interface FacetKey {
  key: string;
  count: number;
  distinctValues: number;
}

/** One value of a metadata key, with how many files carry it. */
export interface FacetValue {
  value: string;
  count: number;
}

export type FacetKeysResult =
  | { kind: "ok"; keys: FacetKey[]; truncated: boolean }
  | { kind: "unavailable" };

export type FacetValuesResult =
  | { kind: "ok"; values: FacetValue[]; truncated: boolean }
  | { kind: "unavailable" };

function isFacetKey(value: unknown): value is FacetKey {
  const row = value as Record<string, unknown>;
  return (
    !!row &&
    typeof row.key === "string" &&
    typeof row.count === "number" &&
    typeof row.distinctValues === "number"
  );
}

function isFacetValue(value: unknown): value is FacetValue {
  const row = value as Record<string, unknown>;
  return !!row && typeof row.value === "string" && typeof row.count === "number";
}

/**
 * GET /me/workspaces/:name/files/facets — which metadata keys this workspace
 * contains. A single `unavailable` kind (no `reason`) is enough here: the
 * filter bar degrades to its syntax hint either way and never surfaces the
 * distinction, unlike a search failure which the user must be told about.
 */
export async function getWorkspaceFacets(
  apiOrigin: string,
  name: string,
): Promise<FacetKeysResult> {
  const url = `${trimOrigin(apiOrigin)}/me/workspaces/${encodeURIComponent(name)}/files/facets`;
  const result = await fetchWithTimeout(url, { credentials: "include", cache: "no-store" });
  if (result.kind === "unavailable" || !result.response.ok) return { kind: "unavailable" };
  let body: unknown;
  try {
    body = await result.response.json();
  } catch {
    return { kind: "unavailable" };
  }
  const b = body as { keys?: unknown; truncated?: unknown };
  if (!Array.isArray(b.keys) || typeof b.truncated !== "boolean" || !b.keys.every(isFacetKey)) {
    return { kind: "unavailable" };
  }
  return { kind: "ok", keys: b.keys, truncated: b.truncated };
}

/** GET /me/workspaces/:name/files/facets?key= — one key's values. */
export async function getWorkspaceFacetValues(
  apiOrigin: string,
  name: string,
  key: string,
): Promise<FacetValuesResult> {
  const url = `${trimOrigin(apiOrigin)}/me/workspaces/${encodeURIComponent(name)}/files/facets?key=${encodeURIComponent(key)}`;
  const result = await fetchWithTimeout(url, { credentials: "include", cache: "no-store" });
  if (result.kind === "unavailable" || !result.response.ok) return { kind: "unavailable" };
  let body: unknown;
  try {
    body = await result.response.json();
  } catch {
    return { kind: "unavailable" };
  }
  const b = body as { values?: unknown; truncated?: unknown };
  if (
    !Array.isArray(b.values) ||
    typeof b.truncated !== "boolean" ||
    !b.values.every(isFacetValue)
  ) {
    return { kind: "unavailable" };
  }
  return { kind: "ok", values: b.values, truncated: b.truncated };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:web -- api-client`
Expected: PASS. Existing `searchWorkspaceFiles` tests still pass — the new fourth argument is optional.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/api-client.ts apps/web/src/lib/api-client.test.ts
git commit -m "feat(web): add facets client and name term to file search"
```

---

### Task 5: Suggestion logic

**Files:**

- Create: `apps/web/src/lib/workspace-search-suggest.ts`
- Test: `apps/web/src/lib/workspace-search-suggest.test.ts`

**Interfaces:**

- Consumes: `FacetKey`, `FacetValue` from Task 4.
- Produces:
  - `type Suggestion = { kind: "name"; term: string } | { kind: "key"; key: string; count: number; distinctValues: number } | { kind: "value"; key: string; value: string; count: number } | { kind: "hint" } | { kind: "empty-facets" }`
  - `parseDraft(draft: string): { key: string; value: string } | null`
  - `buildSuggestions(input: { draft: string; facets: FacetKey[] | null; values: FacetValue[] | null; selectedKey: string | null; activeKeys: string[] }): Suggestion[]`

This module holds every decision the menu makes. The React component renders
what it returns and owns nothing but focus, fetching, and keyboard wiring —
which is what keeps the behaviour testable in a node-only test environment.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/workspace-search-suggest.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildSuggestions, parseDraft } from "./workspace-search-suggest";

// Already ordered count-desc, as the facets route returns them. `buildSuggestions`
// deliberately preserves input order rather than re-sorting — ordering is the
// API's job and is covered by Task 1's tests.
const FACETS = [
  { key: "path", count: 212, distinctValues: 212 },
  { key: "gh.repo", count: 84, distinctValues: 6 },
  { key: "app", count: 40, distinctValues: 3 },
];

describe("parseDraft", () => {
  it("splits a key=value draft", () => {
    expect(parseDraft("gh.repo=buildinternet/uploads")).toEqual({
      key: "gh.repo",
      value: "buildinternet/uploads",
    });
  });

  it("trims around the separator", () => {
    expect(parseDraft("  app = web  ")).toEqual({ key: "app", value: "web" });
  });

  it("returns null for bare text", () => {
    expect(parseDraft("hero.png")).toBeNull();
  });

  it("returns null when the key side is empty", () => {
    expect(parseDraft("=web")).toBeNull();
  });

  it("keeps '=' inside the value", () => {
    expect(parseDraft("q=a=b")).toEqual({ key: "q", value: "a=b" });
  });
});

describe("buildSuggestions", () => {
  it("lists every key with a syntax hint when the draft is empty", () => {
    const out = buildSuggestions({
      draft: "",
      facets: FACETS,
      values: null,
      selectedKey: null,
      activeKeys: [],
    });
    expect(out).toEqual([
      { kind: "key", key: "path", count: 212, distinctValues: 212 },
      { kind: "key", key: "gh.repo", count: 84, distinctValues: 6 },
      { kind: "key", key: "app", count: 40, distinctValues: 3 },
      { kind: "hint" },
    ]);
  });

  it("omits keys already used as a filter", () => {
    const out = buildSuggestions({
      draft: "",
      facets: FACETS,
      values: null,
      selectedKey: null,
      activeKeys: ["path", "gh.repo"],
    });
    expect(out.filter((s) => s.kind === "key").map((s) => (s as { key: string }).key)).toEqual([
      "app",
    ]);
  });

  it("offers name search first for bare text, then matching keys", () => {
    const out = buildSuggestions({
      draft: "gh",
      facets: FACETS,
      values: null,
      selectedKey: null,
      activeKeys: [],
    });
    expect(out[0]).toEqual({ kind: "name", term: "gh" });
    expect(out[1]).toEqual({ kind: "key", key: "gh.repo", count: 84, distinctValues: 6 });
  });

  it("lists a selected key's values, filtered by what follows the '='", () => {
    const out = buildSuggestions({
      draft: "app=w",
      facets: FACETS,
      values: [
        { value: "web", count: 40 },
        { value: "api", count: 12 },
      ],
      selectedKey: "app",
      activeKeys: [],
    });
    expect(out).toEqual([{ kind: "value", key: "app", value: "web", count: 40 }]);
  });

  it("shows the empty-facets row when the workspace has no metadata", () => {
    const out = buildSuggestions({
      draft: "",
      facets: [],
      values: null,
      selectedKey: null,
      activeKeys: [],
    });
    expect(out).toEqual([{ kind: "empty-facets" }]);
  });

  it("falls back to the hint alone when facets could not be loaded", () => {
    const out = buildSuggestions({
      draft: "",
      facets: null,
      values: null,
      selectedKey: null,
      activeKeys: [],
    });
    expect(out).toEqual([{ kind: "hint" }]);
  });

  it("offers name search even when no key matches the text", () => {
    const out = buildSuggestions({
      draft: "hero.png",
      facets: FACETS,
      values: null,
      selectedKey: null,
      activeKeys: [],
    });
    expect(out).toEqual([{ kind: "name", term: "hero.png" }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:web -- workspace-search-suggest`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/lib/workspace-search-suggest.ts`:

```ts
/**
 * Suggestion rows for the workspace files filter bar's typeahead.
 *
 * All of the menu's decisions live here rather than in `WorkspaceFileTable`,
 * because the repo's test environment is node-only (no jsdom, no
 * @testing-library/react) — a component cannot be rendered in a test, but a
 * pure function can. Same split as `workspace-file-row.ts` and
 * `workspace-search-url.ts`.
 */
import type { FacetKey, FacetValue } from "./api-client";

export type Suggestion =
  /** Search filenames for the raw draft text. */
  | { kind: "name"; term: string }
  /** Select a metadata key, which then loads its values. */
  | { kind: "key"; key: string; count: number; distinctValues: number }
  /** Commit `key=value` as a filter. */
  | { kind: "value"; key: string; value: string; count: number }
  /** Non-selectable footer teaching the `key=value` syntax. */
  | { kind: "hint" }
  /** Non-selectable row shown when the workspace carries no metadata at all. */
  | { kind: "empty-facets" };

/**
 * Split a `key=value` draft. Only the first `=` separates, so values may
 * contain `=`. Returns null for bare text (no separator) or an empty key,
 * which is what routes the draft to filename search instead.
 */
export function parseDraft(draft: string): { key: string; value: string } | null {
  const eq = draft.indexOf("=");
  if (eq < 0) return null;
  const key = draft.slice(0, eq).trim();
  if (key.length === 0) return null;
  return { key, value: draft.slice(eq + 1).trim() };
}

export interface SuggestionInput {
  /** Raw input value. */
  draft: string;
  /** Workspace facet keys; `null` when the facets request failed or is in flight. */
  facets: FacetKey[] | null;
  /** Values for `selectedKey`; `null` when not loaded yet. */
  values: FacetValue[] | null;
  /** The key whose values are being browsed, when the draft is `key=…`. */
  selectedKey: string | null;
  /** Keys already committed as filters — never offered twice. */
  activeKeys: string[];
}

export function buildSuggestions(input: SuggestionInput): Suggestion[] {
  const { draft, facets, values, selectedKey, activeKeys } = input;
  const trimmed = draft.trim();

  // `key=…` — browsing one key's values.
  if (selectedKey) {
    const parsed = parseDraft(draft);
    const partial = parsed?.value.toLowerCase() ?? "";
    if (!values) return [];
    return values
      .filter((row) => row.value.toLowerCase().includes(partial))
      .map((row) => ({
        kind: "value" as const,
        key: selectedKey,
        value: row.value,
        count: row.count,
      }));
  }

  // Facets unavailable — the bar still works, so teach the syntax and stop.
  if (facets === null) return [{ kind: "hint" }];
  if (facets.length === 0) return [{ kind: "empty-facets" }];

  const available = facets.filter((row) => !activeKeys.includes(row.key));
  const needle = trimmed.toLowerCase();
  const keyRows = (
    needle ? available.filter((row) => row.key.toLowerCase().includes(needle)) : available
  ).map((row) => ({
    kind: "key" as const,
    key: row.key,
    count: row.count,
    distinctValues: row.distinctValues,
  }));

  // Bare text: filename search leads, matching keys follow. No trailing hint —
  // the user is mid-thought and the row set already shows both options.
  if (trimmed) return [{ kind: "name", term: trimmed }, ...keyRows];

  // Empty input: the workspace's keys, plus the syntax hint as a footer.
  return [...keyRows, { kind: "hint" }];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:web -- workspace-search-suggest`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/workspace-search-suggest.ts apps/web/src/lib/workspace-search-suggest.test.ts
git commit -m "feat(web): add filter-bar suggestion logic"
```

---

### Task 6: Typeahead UI

**Files:**

- Modify: `apps/web/src/components/WorkspaceFileTable.tsx` — state near line 358; the `filtered` predicate at line 378; the data-loading effect at line 405; the `<form className="wft-filterbar">` at line 659; the `wft-chips` block at line 717
- Modify: `apps/web/src/styles/account-content.css` — after the `.wft-filterbar` rules at line 992

**Interfaces:**

- Consumes: `getWorkspaceFacets`, `getWorkspaceFacetValues`, `searchWorkspaceFiles` (Task 4); `buildSuggestions`, `parseDraft`, `Suggestion` (Task 5).
- Produces: no exports; this is the leaf.

This task has no unit tests — the component cannot be rendered in a node-only
test environment (see Global Constraints). Its logic was extracted into Task 5
precisely so that this task is thin wiring. Verification is in the browser, in
Step 4.

- [ ] **Step 1: Add state, fetching, and the name filter**

In `WorkspaceFileTable.tsx`, add to the existing imports:

```tsx
import {
  getWorkspaceFacetValues,
  getWorkspaceFacets,
  type FacetKey,
  type FacetValue,
} from "../lib/api-client";
import { buildSuggestions, parseDraft, type Suggestion } from "../lib/workspace-search-suggest";
```

Add state beside the existing `draft` / `filters` state (near line 358):

```tsx
const [nameTerm, setNameTerm] = useState<string>("");
const [menuOpen, setMenuOpen] = useState(false);
const [activeIndex, setActiveIndex] = useState(0);
const [facets, setFacets] = useState<FacetKey[] | null>(null);
const [facetValues, setFacetValues] = useState<Record<string, FacetValue[]>>({});
```

Fetch facets once per workspace, on first focus. Add near the other effects:

```tsx
// Fetched lazily on first focus rather than on mount: most visits to this tab
// browse folders and never open the menu, and the query is pure overhead for
// them. Cached for the session — `facets` is only ever set once.
const loadFacets = async () => {
  if (facets !== null) return;
  const result = await getWorkspaceFacets(apiOrigin, workspace);
  setFacets(result.kind === "ok" ? result.keys : null);
};

const loadFacetValues = async (key: string) => {
  if (facetValues[key]) return;
  const result = await getWorkspaceFacetValues(apiOrigin, workspace, key);
  if (result.kind === "ok") setFacetValues((prev) => ({ ...prev, [key]: result.values }));
};
```

Thread `nameTerm` into the search call. In the data-loading effect (line ~405), change:

```tsx
const result = await searchWorkspaceFiles(apiOrigin, workspace, filters);
```

to:

```tsx
const result = await searchWorkspaceFiles(apiOrigin, workspace, filters, {
  name: nameTerm || undefined,
});
```

Change the `filtered` predicate (line 378) so a name term counts as filtering:

```tsx
const filtered = filters.length > 0 || nameTerm.length > 0;
```

Add `nameTerm` to that effect's dependency array alongside `filtersKey`.

- [ ] **Step 2: Render the menu**

Replace the `<form className="wft-filterbar input-group">` block (lines 659–677) with:

```tsx
<form
  className="wft-filterbar input-group"
  onSubmit={(e) => {
    e.preventDefault();
    const suggestions = currentSuggestions();
    const active = suggestions[activeIndex];
    if (active && active.kind !== "hint" && active.kind !== "empty-facets") {
      applySuggestion(active);
      return;
    }
    addFilter();
  }}
>
  <span className="input-group__field">
    <input
      role="combobox"
      aria-expanded={menuOpen}
      aria-controls="wft-suggest"
      aria-autocomplete="list"
      aria-activedescendant={menuOpen ? `wft-suggest-${activeIndex}` : undefined}
      aria-label="Filter files"
      placeholder="Filter by name, or key=value…"
      value={draft}
      onFocus={() => {
        setMenuOpen(true);
        void loadFacets();
      }}
      onBlur={() => setTimeout(() => setMenuOpen(false), 120)}
      onChange={(e) => {
        setDraft(e.currentTarget.value);
        setActiveIndex(0);
        setMenuOpen(true);
        const parsed = parseDraft(e.currentTarget.value);
        if (parsed) void loadFacetValues(parsed.key);
      }}
      onKeyDown={(e) => {
        const suggestions = currentSuggestions();
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setActiveIndex((i) => Math.min(i + 1, suggestions.length - 1));
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          setActiveIndex((i) => Math.max(i - 1, 0));
        } else if (e.key === "Escape") {
          setMenuOpen(false);
        }
      }}
    />
  </span>
  <button type="submit" className="input-group__action">
    add
  </button>
  {menuOpen && renderSuggestionMenu()}
</form>
```

Add these helpers inside the component, above the `return`:

```tsx
const parsedDraft = parseDraft(draft);
const selectedKey = parsedDraft?.key ?? null;

const currentSuggestions = (): Suggestion[] =>
  buildSuggestions({
    draft,
    facets,
    values: selectedKey ? (facetValues[selectedKey] ?? null) : null,
    selectedKey,
    activeKeys: filters.map((f) => f.key),
  });

/** Commit a highlighted row: a name row searches, a key row drills in, a value row filters. */
const applySuggestion = (suggestion: Suggestion) => {
  if (suggestion.kind === "name") {
    setNameTerm(suggestion.term);
    setDraft("");
    setMenuOpen(false);
    return;
  }
  if (suggestion.kind === "key") {
    // Drill in rather than commit: `key=` alone is not a filter, and this is
    // the step that loads the key's values for the next menu.
    setDraft(`${suggestion.key}=`);
    setActiveIndex(0);
    void loadFacetValues(suggestion.key);
    return;
  }
  if (suggestion.kind === "value") {
    setFilterError(null);
    setDraft("");
    setMenuOpen(false);
    commitFilters([...filters, { key: suggestion.key, value: suggestion.value }]);
  }
};

// A plain function, not a nested component: declaring a component inside
// another creates a new component type on every render, which would remount
// the menu (and drop its DOM state) on every keystroke.
const renderSuggestionMenu = () => {
  const suggestions = currentSuggestions();
  if (suggestions.length === 0) return null;
  return (
    <ul className="wft-suggest" id="wft-suggest" role="listbox" aria-label="Filter suggestions">
      {suggestions.map((suggestion, index) => {
        const id = `wft-suggest-${index}`;
        if (suggestion.kind === "hint") {
          return (
            <li className="wft-suggest__hint" key={id} aria-disabled="true">
              or type <code>key=value</code> to filter directly
            </li>
          );
        }
        if (suggestion.kind === "empty-facets") {
          return (
            <li className="wft-suggest__hint" key={id} aria-disabled="true">
              No metadata yet — filters appear once files are uploaded with tags.{" "}
              <a href="/docs/cli">How to tag uploads</a>
            </li>
          );
        }
        const unique = suggestion.kind === "key" && suggestion.count === suggestion.distinctValues;
        return (
          <li
            key={id}
            id={id}
            role="option"
            aria-selected={index === activeIndex}
            className={`wft-suggest__row${index === activeIndex ? " is-active" : ""}`}
            onMouseDown={(e) => {
              e.preventDefault(); // keep focus so onBlur doesn't close first
              applySuggestion(suggestion);
            }}
            onMouseEnter={() => setActiveIndex(index)}
          >
            {suggestion.kind === "name" ? (
              <>
                <span className="wft-suggest__label">name contains “{suggestion.term}”</span>
              </>
            ) : suggestion.kind === "key" ? (
              <>
                <span className="wft-suggest__label">{suggestion.key}</span>
                <span className="wft-suggest__meta">
                  {suggestion.count} files ·{" "}
                  {unique ? "unique per file" : `${suggestion.distinctValues} values`}
                </span>
              </>
            ) : (
              <>
                <span className="wft-suggest__label">{suggestion.value}</span>
                <span className="wft-suggest__meta">{suggestion.count} files</span>
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
};
```

Render the active name term as a removable chip. In the `wft-chips` block (line 717), add before the `filters.map(...)`:

```tsx
{
  nameTerm && (
    <span className="wft-chip">
      <span className="wft-chip__key">name</span>
      <span className="wft-chip__eq">~</span>
      <span className="wft-chip__value">{nameTerm}</span>
      <button
        type="button"
        className="wft-chip__remove"
        aria-label="Remove name filter"
        onClick={() => setNameTerm("")}
      >
        ×
      </button>
    </span>
  );
}
```

Change the `clear all` handler on line 744 to clear both:

```tsx
<button
  type="button"
  onClick={() => {
    setNameTerm("");
    commitFilters([]);
  }}
>
  clear all
</button>
```

- [ ] **Step 3: Add the styles**

Append to `apps/web/src/styles/account-content.css`, after the existing `.wft-filterbar` rules (line ~992). Match the surrounding file's token usage — read the neighbouring `.wft-chip` rules and reuse the same custom properties rather than introducing new colours:

```css
.wft-filterbar {
  position: relative;
}

.wft-suggest {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  z-index: 20;
  margin: 0.25rem 0 0;
  padding: 0.25rem;
  list-style: none;
  max-height: 20rem;
  overflow-y: auto;
  background: var(--ul-surface-raised, #17151d);
  border: 1px solid var(--ul-border, #2a2733);
  border-radius: 0.375rem;
}

.wft-suggest__row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.375rem 0.5rem;
  border-radius: 0.25rem;
  cursor: pointer;
}

.wft-suggest__row.is-active {
  background: var(--ul-surface-hover, #221f2b);
}

.wft-suggest__label {
  font-family: var(--ul-font-mono, monospace);
}

.wft-suggest__meta {
  font-size: 0.8125rem;
  opacity: 0.6;
  white-space: nowrap;
}

.wft-suggest__hint {
  padding: 0.375rem 0.5rem;
  font-size: 0.8125rem;
  opacity: 0.6;
}
```

- [ ] **Step 4: Verify in the browser**

Start the dev server and check the real bar. Use the `preview_start` tooling rather than running a dev server through a shell.

Verify, in order:

1. Focusing the empty input opens a menu listing the workspace's real keys with counts.
2. Typing `gh` shows `name contains "gh"` first, then matching keys.
3. Selecting a key rewrites the input to `key=` and lists that key's real values.
4. Selecting a value commits a chip and filters the table.
5. Typing `gh.repo=buildinternet/uploads` and pressing Enter still commits directly.
6. Typing `hero` and choosing the name row filters by filename — no error.
7. ↑/↓ move the highlight, Enter commits, Esc closes.
8. On a workspace with no metadata, the menu shows the empty-facets row and the docs link.

Fix anything that fails before committing.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/WorkspaceFileTable.tsx apps/web/src/styles/account-content.css
git commit -m "feat(web): add typeahead to the workspace files filter bar"
```

---

### Task 7: Remove dead components

**Files:**

- Delete: `apps/web/src/components/MetadataSearchResults.tsx`
- Delete: `apps/web/src/components/WorkspaceFiles.tsx`

**Interfaces:**

- Consumes: nothing.
- Produces: nothing.

Both duplicate the filter logic Task 6 rewrote, and neither is mounted by any
page — `WorkspaceFileTable` replaced them. Leaving them behind would leave a
third copy of a filter bar to drift.

- [ ] **Step 1: Confirm nothing imports them**

Run:

```bash
grep -rn "MetadataSearchResults\|WorkspaceFiles" apps/web/src --include="*.tsx" --include="*.astro" --include="*.ts" | grep -v "components/MetadataSearchResults.tsx" | grep -v "components/WorkspaceFiles.tsx"
```

Expected: only the doc-comment references inside `WorkspaceFileTable.tsx`. If any `.astro` page or live component imports either file, stop — the premise is wrong and the deletion is unsafe.

- [ ] **Step 2: Delete both files**

```bash
git rm apps/web/src/components/MetadataSearchResults.tsx apps/web/src/components/WorkspaceFiles.tsx
```

- [ ] **Step 3: Update the stale references in `WorkspaceFileTable.tsx`**

Its header comment (lines 4–5) and the inline comment at line 431 name both
deleted components. Reword so they describe the behaviour rather than pointing
at files that no longer exist — e.g. line 4–5's "Replaces `WorkspaceFiles` +
`AccountFileBrowser` + `MetadataSearchResults` as the single island mounted by
…" becomes "The single island mounted by …", and line 431's "same convention as
the MetadataSearchResults component this replaces" becomes "same convention as
the rest of this component's effects".

- [ ] **Step 4: Verify the build and full suite**

Run: `pnpm types && pnpm test`
Expected: types clean, whole suite passes.

- [ ] **Step 5: Commit**

```bash
git add -A apps/web/src
git commit -m "refactor(web): drop the superseded metadata search components"
```

---

## Final verification

- [ ] Run `pnpm check` — oxlint plus `oxfmt --check` across the repo.
- [ ] Run `pnpm test` — the whole suite in one Vitest process.
- [ ] Confirm no `.changeset/*.md` file was created (see Global Constraints).
- [ ] Re-run the Task 6 Step 4 browser checks once more against the final build, and capture a screenshot of the open menu for the PR using the `github-screenshots` skill.
