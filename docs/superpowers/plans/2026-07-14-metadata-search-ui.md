# Metadata Search UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a signed-in member search a workspace's files by their `gh.*`/custom metadata from the web, folded into the existing file browser on `/account/workspaces`.

**Architecture:** A new session-authed API endpoint (`GET /me/workspaces/:name/files/search`) reuses the shipped `validateMetadataFilters`/`findObjectsByMetadata` helpers. On the web, testable logic lives in pure `lib/` modules (URL sync, filter validation, API client) with unit tests; two new React components (`WorkspaceFiles` wrapper + `MetadataSearchResults`) render the filter chips and results and are verified on a preview worker. The existing `AccountFileBrowser` is untouched.

**Tech Stack:** Hono (Cloudflare Workers API), Astro + React islands (web), `@uploads/ui` primitives, vitest.

## Global Constraints

- **Filter semantics:** AND-of-equality across `meta.<key>=<value>` pairs (mirror the token route in `apps/api/src/routes/files.ts`). Repeated same-key param → `ValidationError` code `file_metadata_duplicate_filter`.
- **Key format:** `^[a-z][a-z0-9._-]{0,63}$` (`META_KEY_RE`). Max 24 filters (`META_MAX_KEYS`). Value 1–512 printable ASCII (`META_VALUE_MAX`).
- **Result cap:** 100 items; return `truncated: true` when more matches exist.
- **No visibility in results** (accepted caveat — it isn't in the metadata index).
- **Per-workspace only.** No cross-workspace search, no key/value autocomplete.
- **Auth:** the endpoint lives under the `/me/*` mount (`sessionAuth` + `requireSessionUser`); authorize via `memberWorkspaceOr404`. Communal workspace → empty result.
- **Web fetches to `/me/*` must send `credentials: "include"`.**
- **Routing:** verify the new route resolves on a real preview worker, not just vitest (#158 lesson).
- Commit after each task. Follow existing file conventions (inline styles in `.astro`, `@uploads/ui` primitives in `.tsx`).

---

### Task 1: API search endpoint

**Files:**

- Modify: `apps/api/src/routes/me.ts` (imports + new route, insert after the existing `/workspaces/:name/files` handler ~line 175)
- Test: `apps/api/src/routes/me.test.ts` (new `describe` block + a metadata-seeded D1 helper)

**Interfaces:**

- Consumes: `findObjectsByMetadata(db, workspace, filters, { prefix?, limit? }) => Promise<Array<{ key: string; metadata: Record<string,string> }>>` and `validateMetadataFilters(filters: Record<string,string>) => void` from `../file-metadata`; `objectPublicUrls(env, cfg, key) => { url, embedUrl }` and `storageConfig(env, record)` from `../storage`; `loadWorkspaceRecord`, `memberWorkspaceOr404`, `requireUserId` (already in `me.ts`).
- Produces: `GET /me/workspaces/:name/files/search?meta.<key>=<value>&... → 200 { items: Array<{ key: string; url: string|null; embedUrl: string|null; metadata: Record<string,string> }>, truncated: boolean }`.

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/src/routes/me.test.ts`. First, a metadata-seeded D1 helper near `galleriesDb()` (reuse the existing `SQLiteD1`/`SQLiteStatement` classes and `DatabaseSync` imports already in the file):

```ts
function metadataDb(
  rows: Array<{ workspace: string; key: string; meta: Record<string, string> }>,
): SQLiteD1 {
  const db = new DatabaseSync(":memory:");
  db.exec(
    readFileSync(
      fileURLToPath(
        new NodeURL("../../migrations/20260713210559_file_metadata.sql", import.meta.url),
      ),
      "utf8",
    ),
  );
  const insert = db.prepare(
    "INSERT INTO file_metadata (workspace, object_key, meta_key, meta_value) VALUES (?, ?, ?, ?)",
  );
  for (const row of rows) {
    for (const [k, v] of Object.entries(row.meta)) insert.run(row.workspace, row.key, k, v);
  }
  return new SQLiteD1(db);
}

const R2_RECORD = {
  provider: "r2",
  bucket: "shared",
  binding: "UPLOADS_DEFAULT",
  prefix: "acme/",
  publicBaseUrl: "https://storage.uploads.sh",
};
```

Then the test block:

```ts
describe("GET /me/workspaces/:name/files/search", () => {
  it("returns files matching an ANDed metadata filter", async () => {
    const db = metadataDb([
      {
        workspace: "acme",
        key: "f/x/shot.png",
        meta: { "gh.repo": "buildinternet/uploads", app: "web" },
      },
      { workspace: "acme", key: "f/y/other.png", meta: { "gh.repo": "buildinternet/uploads" } },
    ]);
    const env = memberEnv({ workspace: "acme", db, bucket: new FakeR2Bucket(), record: R2_RECORD });
    const res = await app().request(
      "/me/workspaces/acme/files/search?meta.gh.repo=buildinternet/uploads&meta.app=web",
      {},
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { key: string; url: string; metadata: Record<string, string> }[];
      truncated: boolean;
    };
    expect(body.truncated).toBe(false);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      key: "f/x/shot.png",
      url: "https://storage.uploads.sh/acme/f/x/shot.png",
    });
  });

  it("rejects a repeated filter key with file_metadata_duplicate_filter", async () => {
    const env = memberEnv({ workspace: "acme", db: metadataDb([]), record: R2_RECORD });
    const res = await app().request(
      "/me/workspaces/acme/files/search?meta.app=web&meta.app=api",
      {},
      env,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("file_metadata_duplicate_filter");
  });

  it("rejects a malformed filter key with file_metadata_invalid_key", async () => {
    const env = memberEnv({ workspace: "acme", db: metadataDb([]), record: R2_RECORD });
    const res = await app().request("/me/workspaces/acme/files/search?meta.BadKey=x", {}, env);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("file_metadata_invalid_key");
  });

  it("requires at least one meta.* filter", async () => {
    const env = memberEnv({ workspace: "acme", db: metadataDb([]), record: R2_RECORD });
    const res = await app().request("/me/workspaces/acme/files/search", {}, env);
    expect(res.status).toBe(400);
  });

  it("short-circuits the communal workspace with an empty result", async () => {
    const env = memberEnv({ workspace: "default", db: metadataDb([]) });
    const res = await app().request("/me/workspaces/default/files/search?meta.app=web", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [], truncated: false });
  });

  it("404s for a workspace the caller is not a member of", async () => {
    const env = memberEnv({ workspace: "acme", db: metadataDb([]), record: R2_RECORD });
    const res = await app().request("/me/workspaces/other/files/search?meta.app=web", {}, env);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @uploads/api test -- me.test.ts`
Expected: FAIL — the `/files/search` route 404s (no handler), so status assertions fail.

- [ ] **Step 3: Add the endpoint**

In `apps/api/src/routes/me.ts`, extend the storage import (line 22) to include `objectPublicUrls`:

```ts
import { objectPublicUrls, publicUrl, storage, storageConfig } from "../storage";
```

Add `findObjectsByMetadata` + `validateMetadataFilters` imports (new import block near the top, alongside the other `../` imports):

```ts
import { findObjectsByMetadata, validateMetadataFilters } from "../file-metadata";
```

Insert this handler immediately after the existing `.get("/workspaces/:name/files", …)` handler:

```ts
  // Metadata search — the session-authed twin of the token route's
  // `GET /v1/:workspace/files?meta.*` (files.ts). Same AND-of-equality
  // semantics and shared validators; scoped to one workspace, member-gated.
  // Results carry no `visibility` (it isn't in the D1 index — accepted caveat).
  .get("/workspaces/:name/files/search", async (c) => {
    const name = c.req.param("name");
    const ws = await memberWorkspaceOr404(c.env, requireUserId(c), name);
    if (ws.communal) return c.json({ items: [], truncated: false });

    const record = await loadWorkspaceRecord(c.env, name);
    if (!record) {
      throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
    }

    const query = c.req.query();
    const metaParamKeys = Object.keys(query).filter((k) => k.startsWith("meta."));
    if (metaParamKeys.length === 0) {
      throw new ValidationError("at least one meta.* filter is required", {
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
    validateMetadataFilters(filters);

    const SEARCH_LIMIT = 100;
    const [cfg, matches] = await Promise.all([
      storageConfig(c.env, record),
      findObjectsByMetadata(c.env.DB, name, filters, {
        prefix: query.prefix,
        limit: SEARCH_LIMIT + 1,
      }),
    ]);
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

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @uploads/api test -- me.test.ts`
Expected: PASS (all six new cases).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @uploads/api types`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/me.ts apps/api/src/routes/me.test.ts
git commit -m "feat(api): session-authed metadata search endpoint (#159)"
```

---

### Task 2: Filter validation + URL sync helpers

**Files:**

- Create: `apps/web/src/lib/workspace-search-url.ts`
- Test: `apps/web/src/lib/workspace-search-url.test.ts`

**Interfaces:**

- Produces:
  - `interface MetaFilter { key: string; value: string }`
  - `isValidMetaKey(key: string): boolean`
  - `isValidMetaValue(value: string): boolean`
  - `readSearchFilters(search: string): MetaFilter[]` — parse `meta.*` params (first wins on dupes, invalid dropped)
  - `buildSearchQuery(filters: MetaFilter[]): string` — `meta.key=value&…` (no leading `?`)
  - `replaceSearchLocation(workspace: string, filters: MetaFilter[]): void` — writes `ws` + `meta.*` into the address bar via `history.replaceState`, clearing `path`

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/lib/workspace-search-url.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  buildSearchQuery,
  isValidMetaKey,
  isValidMetaValue,
  readSearchFilters,
} from "./workspace-search-url";

describe("isValidMetaKey", () => {
  it("accepts lowercase dotted keys", () => {
    expect(isValidMetaKey("gh.repo")).toBe(true);
    expect(isValidMetaKey("app")).toBe(true);
  });
  it("rejects uppercase, leading digit, and overly long keys", () => {
    expect(isValidMetaKey("BadKey")).toBe(false);
    expect(isValidMetaKey("1app")).toBe(false);
    expect(isValidMetaKey("a".repeat(65))).toBe(false);
  });
});

describe("isValidMetaValue", () => {
  it("accepts 1–512 printable ASCII", () => {
    expect(isValidMetaValue("buildinternet/uploads")).toBe(true);
  });
  it("rejects empty, over-long, and control chars", () => {
    expect(isValidMetaValue("")).toBe(false);
    expect(isValidMetaValue("x".repeat(513))).toBe(false);
    expect(isValidMetaValue("a\tb")).toBe(false);
  });
});

describe("readSearchFilters", () => {
  it("parses meta.* params, first-wins on duplicates, drops invalid", () => {
    expect(
      readSearchFilters("?ws=acme&meta.gh.repo=a/b&meta.app=web&meta.app=api&meta.BAD=x"),
    ).toEqual([
      { key: "gh.repo", value: "a/b" },
      { key: "app", value: "web" },
    ]);
  });
  it("returns empty when there are no meta params", () => {
    expect(readSearchFilters("?ws=acme&path=f/")).toEqual([]);
  });
});

describe("buildSearchQuery", () => {
  it("serializes filters to a query string", () => {
    expect(
      buildSearchQuery([
        { key: "gh.repo", value: "a/b" },
        { key: "app", value: "web" },
      ]),
    ).toBe("meta.gh.repo=a%2Fb&meta.app=web");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @uploads/web test -- workspace-search-url.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the helpers**

Create `apps/web/src/lib/workspace-search-url.ts`:

```ts
/**
 * Query-param sync for the account file browser's metadata search mode:
 *   /account/workspaces?ws=<workspace>&meta.gh.repo=owner/name&meta.app=web
 *
 * Sibling to workspace-browse-url.ts (which owns `ws` + `path`). Search mode
 * replaces `path` with one or more `meta.*` pairs. Validation mirrors the
 * API's META_KEY_RE / META_VALUE_MAX so bad input is caught before a request.
 */
import { isBrowseWorkspace } from "./workspace-browse-url";

export interface MetaFilter {
  key: string;
  value: string;
}

/** Mirrors apps/api's META_KEY_RE (file-metadata.ts). */
const META_KEY_RE = /^[a-z][a-z0-9._-]{0,63}$/;
/** Mirrors apps/api's META_VALUE_MAX. */
const META_VALUE_MAX = 512;

export function isValidMetaKey(key: string): boolean {
  return META_KEY_RE.test(key);
}

export function isValidMetaValue(value: string): boolean {
  if (value.length < 1 || value.length > META_VALUE_MAX) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return false; // printable ASCII only
  }
  return true;
}

/** Parse `meta.*` params; first value wins per key, invalid pairs dropped. */
export function readSearchFilters(search: string): MetaFilter[] {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  const params = new URLSearchParams(raw);
  const seen = new Set<string>();
  const out: MetaFilter[] = [];
  for (const [param, value] of params) {
    if (!param.startsWith("meta.")) continue;
    const key = param.slice("meta.".length);
    if (seen.has(key)) continue;
    seen.add(key);
    if (isValidMetaKey(key) && isValidMetaValue(value)) out.push({ key, value });
  }
  return out;
}

/** Serialize filters to `meta.key=value&…` (no leading `?`). */
export function buildSearchQuery(filters: MetaFilter[]): string {
  const params = new URLSearchParams();
  for (const { key, value } of filters) params.set(`meta.${key}`, value);
  return params.toString();
}

/**
 * Write `ws` + `meta.*` into the address bar (no history entry). Clears
 * `path` (search and folder-browse are mutually exclusive) and all prior
 * `meta.*` params. Empty filters + empty workspace clears search entirely.
 */
export function replaceSearchLocation(workspace: string, filters: MetaFilter[]): void {
  if (typeof window === "undefined") return;
  const next = new URL(window.location.href);
  for (const param of [...next.searchParams.keys()]) {
    if (param.startsWith("meta.")) next.searchParams.delete(param);
  }
  next.searchParams.delete("path");
  const ws = isBrowseWorkspace(workspace) ? workspace : "";
  if (ws) next.searchParams.set("ws", ws);
  else next.searchParams.delete("ws");
  for (const { key, value } of filters) {
    if (isValidMetaKey(key) && isValidMetaValue(value)) next.searchParams.set(`meta.${key}`, value);
  }
  const target = `${next.pathname}${next.search}${next.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (target !== current) window.history.replaceState(window.history.state, "", target);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @uploads/web test -- workspace-search-url.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/workspace-search-url.ts apps/web/src/lib/workspace-search-url.test.ts
git commit -m "feat(web): metadata search URL + filter-validation helpers (#159)"
```

---

### Task 3: API client — `searchWorkspaceFiles`

**Files:**

- Modify: `apps/web/src/lib/api-client.ts` (append new types + function)
- Test: `apps/web/src/lib/api-client.test.ts` (append a `describe`)

**Interfaces:**

- Consumes: `MetaFilter`, `buildSearchQuery` from `./workspace-search-url`.
- Produces:
  - `interface SearchFileItem { key: string; url: string | null; embedUrl: string | null; metadata: Record<string,string> }`
  - `type SearchFilesResult = { kind: "ok"; items: SearchFileItem[]; truncated: boolean } | { kind: "unavailable"; reason: "server" | "malformed" }`
  - `searchWorkspaceFiles(apiOrigin: string, name: string, filters: MetaFilter[]): Promise<SearchFilesResult>`

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/src/lib/api-client.test.ts` (extend the top import to include `searchWorkspaceFiles`):

```ts
describe("searchWorkspaceFiles", () => {
  it("returns matching items and the truncated flag", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          items: [
            {
              key: "f/x.png",
              url: "https://s/acme/f/x.png",
              embedUrl: null,
              metadata: { app: "web" },
            },
          ],
          truncated: true,
        }),
      ),
    );
    await expect(
      searchWorkspaceFiles("http://127.0.0.1:8787", "acme", [{ key: "app", value: "web" }]),
    ).resolves.toEqual({
      kind: "ok",
      items: [
        { key: "f/x.png", url: "https://s/acme/f/x.png", embedUrl: null, metadata: { app: "web" } },
      ],
      truncated: true,
    });
  });

  it("reports a server error as unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 500 })),
    );
    await expect(
      searchWorkspaceFiles("http://127.0.0.1:8787", "acme", [{ key: "app", value: "web" }]),
    ).resolves.toEqual({ kind: "unavailable", reason: "server" });
  });

  it("reports a malformed body as unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ nope: true })),
    );
    await expect(
      searchWorkspaceFiles("http://127.0.0.1:8787", "acme", [{ key: "app", value: "web" }]),
    ).resolves.toEqual({ kind: "unavailable", reason: "malformed" });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @uploads/web test -- api-client.test.ts`
Expected: FAIL — `searchWorkspaceFiles` is not exported.

- [ ] **Step 3: Implement the function**

Append to `apps/web/src/lib/api-client.ts` (add `import type { MetaFilter } from "./workspace-search-url";` and `import { buildSearchQuery } from "./workspace-search-url";` at the top with the other imports):

```ts
export interface SearchFileItem {
  key: string;
  url: string | null;
  embedUrl: string | null;
  metadata: Record<string, string>;
}

export type SearchFilesResult =
  | { kind: "ok"; items: SearchFileItem[]; truncated: boolean }
  | { kind: "unavailable"; reason: "server" | "malformed" };

function isSearchFileItem(value: unknown): value is SearchFileItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.key === "string" &&
    (item.url === null || typeof item.url === "string") &&
    (item.embedUrl === null || typeof item.embedUrl === "string") &&
    typeof item.metadata === "object" &&
    item.metadata !== null
  );
}

/** GET /me/workspaces/:name/files/search — session-authed metadata search. */
export async function searchWorkspaceFiles(
  apiOrigin: string,
  name: string,
  filters: MetaFilter[],
): Promise<SearchFilesResult> {
  const query = buildSearchQuery(filters);
  const url = `${trimOrigin(apiOrigin)}/me/workspaces/${encodeURIComponent(name)}/files/search?${query}`;
  let response: Response;
  try {
    response = await fetch(url, { credentials: "include", cache: "no-store" });
  } catch {
    return { kind: "unavailable", reason: "server" };
  }
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
```

Note: `trimOrigin` already exists at the top of `api-client.ts` (line ~11) — reuse it, do not redefine.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @uploads/web test -- api-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @uploads/web types`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/api-client.ts apps/web/src/lib/api-client.test.ts
git commit -m "feat(web): searchWorkspaceFiles API client (#159)"
```

---

### Task 4: `MetadataSearchResults` component

**Files:**

- Create: `apps/web/src/components/MetadataSearchResults.tsx`

**Interfaces:**

- Consumes: `MetaFilter` from `../lib/workspace-search-url`; `searchWorkspaceFiles`, `SearchFileItem` from `../lib/api-client`; `Badge`, `Button`, `Callout` from `@uploads/ui`.
- Produces:
  ```ts
  interface MetadataSearchResultsProps {
    apiOrigin: string;
    workspace: string;
    filters: MetaFilter[];
    onRemoveFilter: (key: string) => void;
  }
  export function MetadataSearchResults(props: MetadataSearchResultsProps): JSX.Element;
  ```

This component owns the results fetch + render for a given filter set. Filter _entry_ (the add-filter bar) lives in Task 5's wrapper; here we render the active-filter chips (removable) and the results. No test harness for React rendering exists in this repo, so this task is verified via the preview in Task 5.

- [ ] **Step 1: Create the component**

Create `apps/web/src/components/MetadataSearchResults.tsx`:

```tsx
import { Badge, Button, Callout } from "@uploads/ui";
import { useEffect, useState } from "react";
import { searchWorkspaceFiles, type SearchFileItem } from "../lib/api-client";
import type { MetaFilter } from "../lib/workspace-search-url";

interface MetadataSearchResultsProps {
  apiOrigin: string;
  workspace: string;
  filters: MetaFilter[];
  onRemoveFilter: (key: string) => void;
}

type State =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ok"; items: SearchFileItem[]; truncated: boolean };

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;
const filename = (key: string) => key.split("/").filter(Boolean).pop() ?? key;

export function MetadataSearchResults({
  apiOrigin,
  workspace,
  filters,
  onRemoveFilter,
}: MetadataSearchResultsProps) {
  const [state, setState] = useState<State>({ status: "loading" });
  // Re-fetch whenever the filter set changes. Serialize the filters into the
  // dependency so add/remove re-runs the search.
  const key = filters.map((f) => `${f.key}=${f.value}`).join("&");

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    void searchWorkspaceFiles(apiOrigin, workspace, filters).then((result) => {
      if (cancelled) return;
      setState(
        result.kind === "ok"
          ? { status: "ok", items: result.items, truncated: result.truncated }
          : { status: "error" },
      );
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiOrigin, workspace, key]);

  const copyLink = async (url: string, button: HTMLButtonElement) => {
    try {
      await navigator.clipboard.writeText(url);
      const previous = button.textContent;
      button.textContent = "copied ✓";
      setTimeout(() => (button.textContent = previous), 1500);
    } catch {
      /* clipboard blocked — leave the label */
    }
  };

  return (
    <div className="ws-search-results">
      <div className="ws-search-chips">
        {filters.map((f) => (
          <Badge key={f.key}>
            {f.key}={f.value}
            <button
              type="button"
              className="ws-chip-remove"
              aria-label={`Remove filter ${f.key}`}
              onClick={() => onRemoveFilter(f.key)}
            >
              ×
            </button>
          </Badge>
        ))}
      </div>

      {state.status === "loading" && <p className="ws-search-status">Searching…</p>}
      {state.status === "error" && (
        <Callout tone="danger">Search is temporarily unavailable. Try again.</Callout>
      )}
      {state.status === "ok" && state.items.length === 0 && (
        <p className="ws-search-status">No files match these filters.</p>
      )}
      {state.status === "ok" && state.items.length > 0 && (
        <>
          {state.truncated && (
            <p className="ws-search-truncated">
              Showing the first 100 matches — add a filter to narrow.
            </p>
          )}
          <ul className="ws-search-list">
            {state.items.map((item) => (
              <li key={item.key} className="ws-search-row">
                <div className="ws-search-thumb">
                  {item.url && IMAGE_EXT.test(item.key) ? (
                    <img src={item.url} alt="" loading="lazy" />
                  ) : (
                    <span className="ws-search-glyph" aria-hidden="true">
                      ▢
                    </span>
                  )}
                </div>
                <div className="ws-search-body">
                  <span className="ws-search-name">{filename(item.key)}</span>
                  <span className="ws-search-meta">
                    {Object.entries(item.metadata).map(([k, v]) => (
                      <Badge key={k}>
                        {k}={v}
                      </Badge>
                    ))}
                  </span>
                </div>
                <div className="ws-search-actions">
                  {item.url && (
                    <>
                      <a href={item.url} target="_blank" rel="noopener noreferrer">
                        Open ↗
                      </a>
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={(e) => void copyLink(item.url as string, e.currentTarget)}
                      >
                        Copy link
                      </Button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
```

Note: confirm `Callout`'s `tone`/`variant` prop name and `Button`'s `variant` values against `packages/ui/src/Callout.tsx` and `Button.tsx` before finalizing; adjust prop names to match. If `Badge` does not accept children with an inline remove button cleanly, wrap the chip in a `<span className="ws-chip">` instead of `Badge`.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @uploads/web types`
Expected: no errors. Fix any prop-name mismatches surfaced against the real `@uploads/ui` component signatures.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/MetadataSearchResults.tsx
git commit -m "feat(web): MetadataSearchResults component (#159)"
```

---

### Task 5: `WorkspaceFiles` wrapper + mount swap + styles + preview verification

**Files:**

- Create: `apps/web/src/components/WorkspaceFiles.tsx`
- Modify: `apps/web/src/pages/account/workspaces.astro` (imports, mount `WorkspaceFiles`, on-load search restore, `<style>` block for `.ws-search-*`)

**Interfaces:**

- Consumes: `AccountFileBrowser` (unchanged), `MetadataSearchResults` (Task 4), `MetaFilter`, `isValidMetaKey`, `isValidMetaValue`, `replaceSearchLocation` from `../lib/workspace-search-url`; `Button`, `Field`, `Input` from `@uploads/ui`.
- Produces:

  ```ts
  interface WorkspaceFilesProps {
    apiOrigin: string;
    workspace: string;
    hasPublicUrl: boolean;
    initialPrefix?: string;
    initialFilters?: MetaFilter[];
    onPrefixChange?: (prefix: string) => void;
  }
  export function WorkspaceFiles(props: WorkspaceFilesProps): JSX.Element;
  ```

- [ ] **Step 1: Create the wrapper**

Create `apps/web/src/components/WorkspaceFiles.tsx`:

```tsx
import { Button, Field, Input } from "@uploads/ui";
import { useState } from "react";
import { AccountFileBrowser } from "./AccountFileBrowser";
import { MetadataSearchResults } from "./MetadataSearchResults";
import {
  isValidMetaKey,
  isValidMetaValue,
  replaceSearchLocation,
  type MetaFilter,
} from "../lib/workspace-search-url";

interface WorkspaceFilesProps {
  apiOrigin: string;
  workspace: string;
  hasPublicUrl: boolean;
  initialPrefix?: string;
  initialFilters?: MetaFilter[];
  onPrefixChange?: (prefix: string) => void;
}

const EXAMPLE_KEYS = ["gh.repo", "app", "page"];

export function WorkspaceFiles({
  apiOrigin,
  workspace,
  hasPublicUrl,
  initialPrefix = "",
  initialFilters = [],
  onPrefixChange,
}: WorkspaceFilesProps) {
  const [filters, setFilters] = useState<MetaFilter[]>(initialFilters);
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const commit = (next: MetaFilter[]) => {
    setFilters(next);
    replaceSearchLocation(workspace, next);
  };

  const addFilter = () => {
    const k = key.trim();
    const v = value.trim();
    if (!isValidMetaKey(k)) {
      setError("Key must be lowercase letters/digits/._- and start with a letter.");
      return;
    }
    if (!isValidMetaValue(v)) {
      setError("Value must be 1–512 printable ASCII characters.");
      return;
    }
    if (filters.some((f) => f.key === k)) {
      setError(`Already filtering on "${k}".`);
      return;
    }
    if (filters.length >= 24) {
      setError("At most 24 filters.");
      return;
    }
    setError(null);
    setKey("");
    setValue("");
    commit([...filters, { key: k, value: v }]);
  };

  const removeFilter = (k: string) => commit(filters.filter((f) => f.key !== k));

  return (
    <div className="ws-files">
      <form
        className="ws-search-bar"
        onSubmit={(e) => {
          e.preventDefault();
          addFilter();
        }}
      >
        <Field>
          <Input
            aria-label="Metadata key"
            placeholder="key (e.g. gh.repo)"
            value={key}
            onChange={(e) => setKey(e.currentTarget.value)}
            list={`ws-search-keys-${workspace}`}
          />
        </Field>
        <Field>
          <Input
            aria-label="Metadata value"
            placeholder="value"
            value={value}
            onChange={(e) => setValue(e.currentTarget.value)}
          />
        </Field>
        <Button type="submit">Add filter</Button>
        <datalist id={`ws-search-keys-${workspace}`}>
          {EXAMPLE_KEYS.map((k) => (
            <option key={k} value={k} />
          ))}
        </datalist>
      </form>
      {error && (
        <p className="ws-search-error" role="alert">
          {error}
        </p>
      )}

      {filters.length === 0 ? (
        <AccountFileBrowser
          apiOrigin={apiOrigin}
          workspace={workspace}
          hasPublicUrl={hasPublicUrl}
          initialPrefix={initialPrefix}
          onPrefixChange={onPrefixChange}
        />
      ) : (
        <MetadataSearchResults
          apiOrigin={apiOrigin}
          workspace={workspace}
          filters={filters}
          onRemoveFilter={removeFilter}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Swap the mount in `workspaces.astro`**

In `apps/web/src/pages/account/workspaces.astro`:

Replace the import (line ~29):

```ts
import { AccountFileBrowser } from "../../components/AccountFileBrowser";
```

with:

```ts
import { WorkspaceFiles } from "../../components/WorkspaceFiles";
import { readSearchFilters } from "../../lib/workspace-search-url";
```

After `const browseOnLoad = readBrowseLocation(window.location.search);` add:

```ts
const searchFiltersOnLoad = readSearchFilters(window.location.search);
```

In the `mount()` closure (line ~268), change the rendered element from `AccountFileBrowser` to `WorkspaceFiles`, passing the initial filters when this workspace is the deep-linked one:

```ts
const mount = () => {
  createRoot(filesEl).render(
    createElement(WorkspaceFiles, {
      apiOrigin,
      workspace: ws.workspace,
      hasPublicUrl: ws.hasPublicUrl,
      initialPrefix: isDeepLinked ? browseOnLoad.path : "",
      initialFilters: isDeepLinked ? searchFiltersOnLoad : [],
      onPrefixChange: (path: string) => {
        replaceBrowseLocation({ workspace: ws.workspace, path });
      },
    }),
  );
};
```

Also broaden the eager-mount trigger so a deep link with filters (but no `path`) still mounts immediately: the existing `isDeepLinked` is `browseOnLoad.workspace === ws.workspace`; that already covers `?ws=` presence, so filter-only deep links (which include `ws`) mount eagerly. No change needed beyond passing `initialFilters`.

- [ ] **Step 3: Add styles**

Append to the `<style>` block in `workspaces.astro` (match the existing token-based style):

```css
.ws-search-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: flex-end;
  margin: 0 0 12px;
}
.ws-search-error {
  margin: 0 0 10px;
  color: var(--danger, #c0392b);
  font: 12px var(--mono);
}
.ws-search-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0 0 12px;
}
.ws-chip-remove {
  margin-left: 6px;
  border: 0;
  background: none;
  color: inherit;
  cursor: pointer;
  font: inherit;
  line-height: 1;
}
.ws-search-status {
  color: var(--muted);
  font: 13px var(--mono);
  margin: 8px 0;
}
.ws-search-truncated {
  color: var(--muted);
  font: 12px var(--mono);
  margin: 0 0 8px;
}
.ws-search-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ws-search-row {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 8px;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--panel);
}
.ws-search-thumb {
  width: 48px;
  height: 48px;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  background: var(--bg);
  border-radius: var(--radius-md);
  overflow: hidden;
}
.ws-search-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.ws-search-glyph {
  color: var(--muted);
  font-size: 18px;
}
.ws-search-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ws-search-name {
  font: 600 13px var(--mono);
  overflow-wrap: anywhere;
}
.ws-search-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.ws-search-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  flex: 0 0 auto;
}
```

- [ ] **Step 4: Typecheck + build**

Run: `pnpm --filter @uploads/web types && pnpm --filter @uploads/web build`
Expected: no errors.

- [ ] **Step 5: Verify on a preview worker (routing + end-to-end)**

The #158 lesson: the deployed Hono router must actually match `/me/workspaces/:name/files/search`. Verify against a real worker, not just vitest:

1. Start the dev stack per the project's launch config (browser preview / `dev:stack`), sign in to `/account/workspaces` (use the dev-session cookie recipe if needed).
2. In a workspace with metadata (e.g. `default`'s `gh.*` backfill), add a filter `gh.repo` = `buildinternet/uploads`.
3. Confirm: the folder browser is replaced by results; matching files render with thumbnails; **Copy link** shows "copied ✓"; the URL bar gains `&meta.gh.repo=…`; reloading restores the search; removing the chip returns to folder browse.
4. Confirm the network request `GET /me/workspaces/<ws>/files/search?meta.gh.repo=…` returns **200** (not 404) — this is the routing check.

Capture a screenshot of the results state for the PR.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/WorkspaceFiles.tsx apps/web/src/pages/account/workspaces.astro
git commit -m "feat(web): fold metadata search into the workspace file browser (#159)"
```

---

## Self-Review

**Spec coverage:**

- Surface = search-in-workspaces-island → Task 5 (wrapper + mount swap). ✓
- Backend session endpoint → Task 1. ✓
- Filter chips (key/value, AND, removable, client validation, example-key hints) → Task 5 (entry + validation) + Task 4 (chip render). ✓
- Results list (thumbnail-by-extension, filename, metadata chips, Open + Copy, states, truncated) → Task 4. ✓
- URL sync / deep-link restore → Task 2 (helpers) + Task 5 (wire-up). ✓
- No visibility toggle in results → Task 4 (none rendered). ✓
- Testing: API route cases → Task 1; pure-logic units → Tasks 2–3; preview routing verify → Task 5. ✓
- Non-goals (cross-workspace, autocomplete) → not implemented. ✓

**Placeholder scan:** No TBD/TODO. Two explicit "confirm against the real component signature" notes (Task 4/5) are deliberate — `@uploads/ui` prop names (`Callout` tone, `Button` variant, `Badge`/`Input`/`Field` shapes) must be checked against source, since this plan can't see those signatures. Adjust to match; do not invent props.

**Type consistency:** `MetaFilter` defined in Task 2, consumed unchanged in Tasks 3–5. `SearchFileItem`/`SearchFilesResult` defined in Task 3, consumed in Task 4. Endpoint response `{ items, truncated }` (Task 1) matches the client validator (Task 3) and the API test assertions (Task 1). `searchWorkspaceFiles(apiOrigin, name, filters)` signature identical across Tasks 3–4.
