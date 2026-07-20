# Public file share page — title, dual dates, rail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On `/f/<workspace>/<key>`, show GitHub PR/issue titles (stamp then live resolve), first-upload vs last-modified when they differ, and a large-screen media|meta right rail.

**Architecture:** Stamp server-only Files SDK custom metadata `uploaded-at` on put (preserve on overwrite). Enrich `GET /public/files/:workspace/:key` with `uploaded` / optional `modified` and `github.title` (stamped `gh.title` then `resolveTitles`). Update the Astro public file page validators + chip/meta UI + CSS rail ≥1080px. No client GitHub calls; no gallery-item parity this PR.

**Tech Stack:** Cloudflare Workers, Hono, Files SDK via `@uploads/storage`, Vitest, Astro SSR (`apps/web`).

**Spec:** `docs/superpowers/specs/2026-07-20-file-share-page-title-dates-rail-design.md`

**Worktree:** `.claude/worktrees/file-share-page-rail` on branch `feat/file-share-page-title-dates-rail`

## Global Constraints

- All object I/O through Files SDK (`store.head` / `store.upload({ metadata })`) via `createStorage()` — never `files.raw` for this feature.
- `uploaded-at` is **server-only** (not client provenance, not D1 `file_metadata`).
- Live title resolution must **never** fail the public JSON response (catch → stamp/ref fallback).
- Public page stays noindex / CSP posture unchanged except existing polish script allowance.
- Do not auto-request CodeRabbit.
- Prefer `pnpm --filter @uploads/api test` / `pnpm --filter @uploads/web test` (or path-scoped vitest) over full monorepo suite during iteration.
- Product CLI examples in docs use `uploads …`, not `pnpm uploads …`.

## File map

| File                                              | Responsibility                                                                           |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `apps/api/src/files-core.ts`                      | Stamp/preserve `uploaded-at` on `putObject`; `existingHead` replaces size-only preflight |
| `apps/api/src/routes/public-files.ts`             | Emit `uploaded`/`modified`/`github.title`; call `resolveTitles`                          |
| `apps/web/src/lib/public-file.ts`                 | DTO types + validation for `modified` and `github.title`; pure date/display helpers      |
| `apps/web/src/lib/public-file.test.ts`            | Validator + helper tests                                                                 |
| `apps/web/src/pages/f/[workspace]/[...key].astro` | Chip title, dual dates, rail CSS                                                         |
| `apps/api/test/routes-public-files.test.ts`       | Integration tests for public JSON                                                        |
| `docs/api.md`                                     | Only if public files response is already documented — note new fields                    |

---

### Task 1: Stamp and preserve `uploaded-at` on put

**Files:**

- Modify: `apps/api/src/files-core.ts` (`existingSize` → richer preflight, `putObject` metadata bag)
- Test: `apps/api/test/routes-public-files.test.ts` (route-level puts + head via FakeR2) **or** add `apps/api/test/files-core-uploaded-at.test.ts` if unit-testing `putObject` is easier with existing fixtures

**Interfaces:**

- Consumes: Files SDK `StoredFile` from `store.head` (`size`, `lastModified?`, `metadata?`)
- Produces: object custom metadata always includes `uploaded-at` ISO string after every successful `putObject`
- Constant: `UPLOADED_AT_META_KEY = "uploaded-at"` (export from `files-core.ts` or a one-line export next to visibility key for tests)

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/test/routes-public-files.test.ts` (reuse `makeEnv`, `seedShot`, `FakeR2Bucket`):

```ts
it("stamps uploaded-at on first put and preserves it across overwrite", async () => {
  const { env, bucket } = await makeEnv();
  await seedShot(env);

  const key = "default/screenshots/shot.png"; // FakeR2 stores physical key with workspace prefix
  // Prefer reading via storage head: list bucket.store keys if prefix differs
  const stored = [...bucket.store.entries()].find(([k]) => k.endsWith("screenshots/shot.png"));
  expect(stored).toBeTruthy();
  const [, first] = stored!;
  const firstStamp = first.customMetadata?.["uploaded-at"];
  expect(firstStamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);

  // Overwrite
  await seedShot(env); // same key put again
  const stored2 = [...bucket.store.entries()].find(([k]) => k.endsWith("screenshots/shot.png"));
  expect(stored2![1].customMetadata?.["uploaded-at"]).toBe(firstStamp);
});

it("seeds uploaded-at from prior lastModified when overwriting a legacy object", async () => {
  const { env, bucket } = await makeEnv();
  await seedShot(env);
  const entry = [...bucket.store.entries()].find(([k]) => k.endsWith("screenshots/shot.png"))!;
  const priorLm = new Date("2026-01-15T10:00:00.000Z");
  // Strip stamp + backdate mtime to simulate pre-feature object
  entry[1].customMetadata = { ...(entry[1].customMetadata ?? {}) };
  delete entry[1].customMetadata!["uploaded-at"];
  bucket.setUploaded(entry[0], priorLm);

  await seedShot(env);
  const after = [...bucket.store.entries()].find(([k]) => k.endsWith("screenshots/shot.png"))!;
  expect(after[1].customMetadata?.["uploaded-at"]).toBe(priorLm.toISOString());
});
```

Adjust the physical key lookup to match how `FakeR2Bucket` stores prefixed keys in this suite (inspect one `seedShot` result if needed — workspace `default` uses `prefix: "default/"`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @uploads/api exec vitest run test/routes-public-files.test.ts -t "uploaded-at"`

Expected: FAIL — `uploaded-at` undefined on customMetadata.

- [ ] **Step 3: Implement preflight + stamp in `putObject`**

In `apps/api/src/files-core.ts`:

1. Export the key constant:

```ts
/** Server-only first-upload stamp (Files SDK object metadata). Not client provenance. */
export const UPLOADED_AT_META_KEY = "uploaded-at";
```

2. Replace `existingSize` with a private helper that returns full prior info:

```ts
async function existingHead(
  store: Files,
  key: string,
): Promise<{ size: number; lastModified?: number; metadata?: Record<string, string> } | null> {
  try {
    const meta = await store.head(key);
    return {
      size: meta.size ?? 0,
      lastModified: meta.lastModified,
      metadata: meta.metadata,
    };
  } catch {
    return null;
  }
}
```

Update `deleteObject` / any other `existingSize` callers in this file to use `existingHead` and read `.size` (or keep a thin `existingSize` wrapper that returns `existingHead(...).then(h => h?.size ?? null)`).

3. Pure resolver (keep next to putObject or as a named export for unit tests):

```ts
/** Decide uploaded-at for a put. Create → now; overwrite → prior stamp, else prior LM, else now. */
export function resolveUploadedAtMeta(
  prior: { lastModified?: number; metadata?: Record<string, string> } | null,
  now: Date = new Date(),
): string {
  if (!prior) return now.toISOString();
  const stamped = prior.metadata?.[UPLOADED_AT_META_KEY];
  if (typeof stamped === "string" && Number.isFinite(Date.parse(stamped))) return stamped;
  if (prior.lastModified != null && Number.isFinite(prior.lastModified)) {
    return new Date(prior.lastModified).toISOString();
  }
  return now.toISOString();
}
```

4. In `putObject`, after `const store = await storage(...)`:

```ts
const prior = await existingHead(store, finalKey);
const replaced = prior !== null;
const prevSize = prior?.size ?? null;
// deltaBytes uses prevSize the same way existingSize did
const uploadedAt = resolveUploadedAtMeta(prior);

const storageMetadata: Record<string, string> = {
  ...provenance,
  ...(storedVisibility ? { [VISIBILITY_META_KEY]: storedVisibility } : {}),
  [UPLOADED_AT_META_KEY]: uploadedAt,
};
```

**Do not** put `uploaded-at` through `sanitizeProvenance` (client allowlist would drop it). Set it only on the final `storageMetadata` bag.

5. `setObjectVisibility` already spreads `current.metadata` — once puts write `uploaded-at`, toggles preserve it with no code change. Still add a regression test in Task 1 or Task 2.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @uploads/api exec vitest run test/routes-public-files.test.ts -t "uploaded-at"`

Expected: PASS.

Also run the full public-files suite once:  
`pnpm --filter @uploads/api exec vitest run test/routes-public-files.test.ts`

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/files-core.ts apps/api/test/routes-public-files.test.ts
git commit -m "$(cat <<'EOF'
feat(api): stamp uploaded-at on put and preserve across overwrite

Server-only Files SDK metadata for first-upload time so public file
pages can show Uploaded vs Modified after in-place revisions.
EOF
)"
```

---

### Task 2: Public JSON `uploaded` + `modified`

**Files:**

- Modify: `apps/api/src/routes/public-files.ts`
- Modify: `apps/api/test/routes-public-files.test.ts`

**Interfaces:**

- Consumes: `meta.lastModified`, `meta.metadata?.["uploaded-at"]` from `resolvePublicObject`
- Produces: response fields `uploaded?: string`, `modified?: string` per spec §4–5

- [ ] **Step 1: Write failing tests**

```ts
it("returns uploaded from uploaded-at and omits modified when equal", async () => {
  const { env } = await makeEnv();
  await seedShot(env);
  const res = await app.request("/public/files/default/screenshots/shot.png", {}, env);
  const json = (await res.json()) as { uploaded?: string; modified?: string };
  expect(json.uploaded).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  // Fresh put: lastModified ≈ uploaded-at → modified omitted
  expect(json.modified).toBeUndefined();
});

it("includes modified when lastModified differs from uploaded-at", async () => {
  const { env, bucket } = await makeEnv();
  await seedShot(env);
  const entry = [...bucket.store.entries()].find(([k]) => k.endsWith("screenshots/shot.png"))!;
  // Keep uploaded-at, advance R2 mtime
  entry[1].customMetadata = {
    ...entry[1].customMetadata,
    "uploaded-at": "2026-01-01T00:00:00.000Z",
  };
  bucket.setUploaded(entry[0], new Date("2026-06-15T12:00:00.000Z"));

  const res = await app.request("/public/files/default/screenshots/shot.png", {}, env);
  const json = (await res.json()) as { uploaded?: string; modified?: string };
  expect(json.uploaded).toBe("2026-01-01T00:00:00.000Z");
  expect(json.modified).toBe("2026-06-15T12:00:00.000Z");
});
```

- [ ] **Step 2: Run tests — expect FAIL** (modified never present / uploaded still only lastModified semantics if stamp missing on old code paths)

Run: `pnpm --filter @uploads/api exec vitest run test/routes-public-files.test.ts -t "uploaded from uploaded-at|includes modified"`

- [ ] **Step 3: Implement date field builder in `public-files.ts`**

```ts
const UPLOADED_AT_META_KEY = "uploaded-at"; // or import from files-core

/** Same-second tolerance so storage noise does not force dual fields. */
const DATE_EQUAL_MS = 1000;

function publicDateFields(meta: { lastModified?: number; metadata?: Record<string, string> }): {
  uploaded?: string;
  modified?: string;
} {
  const modifiedIso =
    meta.lastModified != null && Number.isFinite(meta.lastModified)
      ? new Date(meta.lastModified).toISOString()
      : undefined;
  const stamped = meta.metadata?.[UPLOADED_AT_META_KEY];
  const uploadedIso =
    typeof stamped === "string" && Number.isFinite(Date.parse(stamped))
      ? new Date(stamped).toISOString()
      : modifiedIso;

  if (!uploadedIso && !modifiedIso) return {};
  if (!uploadedIso) return modifiedIso ? { uploaded: modifiedIso } : {};
  if (!modifiedIso) return { uploaded: uploadedIso };

  const delta = Math.abs(Date.parse(modifiedIso) - Date.parse(uploadedIso));
  if (delta < DATE_EQUAL_MS) return { uploaded: uploadedIso };
  return { uploaded: uploadedIso, modified: modifiedIso };
}
```

In the GET handler, replace the single lastModified spread:

```ts
const dates = publicDateFields(meta);
return c.json({
  workspace,
  key,
  url: urls.url,
  embedUrl: urls.embedUrl,
  size: meta.size ?? 0,
  contentType: meta.type ?? "application/octet-stream",
  ...dates,
  ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  ...(github ? { github } : {}),
});
```

Ensure `resolvePublicObject` / `store.head` exposes custom metadata on `meta.metadata` (FakeR2 + files-sdk r2 adapter already map `customMetadata` → `metadata`).

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/public-files.ts apps/api/test/routes-public-files.test.ts
git commit -m "$(cat <<'EOF'
feat(api): expose uploaded and modified on public file metadata

Prefer Files SDK uploaded-at for first upload; emit modified only when
lastModified meaningfully differs so share pages can show revisions.
EOF
)"
```

---

### Task 3: `github.title` on public files (stamp + live resolve)

**Files:**

- Modify: `apps/api/src/routes/public-files.ts` (`deriveGithubContext`, GET handler)
- Modify: `apps/api/test/routes-public-files.test.ts`
- Optionally extend `makeEnv` to include a minimal `GITHUB_CACHE` KV + App vars when testing live resolve

**Interfaces:**

- Consumes: `resolveTitles(env, refs)` from `apps/api/src/github-titles.ts` → `Record<string, TitleInfo | null>`
- Produces: `github.title?: string` on the public DTO

- [ ] **Step 1: Write failing tests**

```ts
it("includes github.title from stamped gh.title when live resolve is unavailable", async () => {
  const { env } = await makeEnv({}, { db: makeFakeDB() });
  // No GITHUB_CACHE / App → resolveTitles returns nulls
  await seedShot(env, {
    "X-Uploads-Meta-gh.repo": "buildinternet/uploads",
    "X-Uploads-Meta-gh.kind": "pull",
    "X-Uploads-Meta-gh.number": "142",
    "X-Uploads-Meta-gh.title": "Fix the login bug",
  });
  const res = await app.request("/public/files/default/screenshots/shot.png", {}, env);
  const json = (await res.json()) as { github?: { title?: string } };
  expect(json.github?.title).toBe("Fix the login bug");
});

it("prefers live-resolved title over stamped gh.title", async () => {
  const kv = new Map<string, string>();
  const { env } = await makeEnv({}, { db: makeFakeDB() });
  // Attach GITHUB_CACHE + App config the same way github-titles-route.test.ts does
  (env as any).GITHUB_CACHE = {
    get: async (k: string, type?: string) => {
      const v = kv.get(k);
      if (v == null) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    put: async (k: string, v: string) => {
      kv.set(k, v);
    },
  };
  // Pre-seed cache so no real GitHub network call is needed
  await (env as any).GITHUB_CACHE.put(
    "ghref:buildinternet/uploads#142",
    JSON.stringify({
      v: { title: "Live title from cache", state: "open", kind: "pull" },
    }),
  );

  await seedShot(env, {
    "X-Uploads-Meta-gh.repo": "buildinternet/uploads",
    "X-Uploads-Meta-gh.kind": "pull",
    "X-Uploads-Meta-gh.number": "142",
    "X-Uploads-Meta-gh.title": "Stamped title",
  });

  const res = await app.request("/public/files/default/screenshots/shot.png", {}, env);
  const json = (await res.json()) as { github?: { title?: string } };
  expect(json.github?.title).toBe("Live title from cache");
});

it("omits github.title when neither stamp nor live resolve provides one", async () => {
  const { env } = await makeEnv({}, { db: makeFakeDB() });
  await seedShot(env, {
    "X-Uploads-Meta-gh.repo": "buildinternet/uploads",
    "X-Uploads-Meta-gh.kind": "pull",
    "X-Uploads-Meta-gh.number": "142",
  });
  const res = await app.request("/public/files/default/screenshots/shot.png", {}, env);
  const json = (await res.json()) as { github?: { title?: string } };
  expect(json.github).toBeDefined();
  expect(json.github).not.toHaveProperty("title");
});
```

Mirror KV fixture details from `apps/api/src/routes/github-titles-route.test.ts` / `github-titles.test.ts` if cache key format or App gating differs. `resolveTitles` without App config returns null without caching — stamped path must still work.

- [ ] **Step 2: Run tests — expect FAIL**

- [ ] **Step 3: Implement**

Extend `GithubContext`:

```ts
interface GithubContext {
  repo: string;
  kind: GithubKind;
  number: number;
  url: string;
  title?: string;
}
```

In `deriveGithubContext`, after building base object:

```ts
const stamped = metadata["gh.title"]?.trim();
const base = { repo, kind, number, url: `https://github.com/${repo}/${path}/${number}` };
return stamped ? { ...base, title: stamped } : base;
```

(If `gh.title` can exceed safe display length, cap at 512 to match META_VALUE_MAX.)

In the GET handler:

```ts
import { resolveTitles } from "../github-titles";

let github = deriveGithubContext(metadata);
if (github) {
  const ref = `${github.repo.toLowerCase()}#${github.number}`;
  try {
    const titles = await resolveTitles(c.env, [ref]);
    const live = titles[ref]?.title?.trim();
    if (live) github = { ...github, title: live };
  } catch {
    // keep stamped / no title
  }
  if (!github.title) {
    const { title: _drop, ...rest } = github;
    github = rest;
  }
}
```

Note: refs in this codebase are stored lowercased in `gh.ref` / `gh.repo`. Prefer building ref as `${metadata["gh.ref"]}` when present and well-formed, else `${repo.toLowerCase()}#${number}` so cache keys match the rail.

When omitting empty title, strip the key rather than sending `title: undefined` in JSON (Hono/JSON typically drops undefined, but be explicit).

Update existing test that `expect(json.github).toEqual({...})` without title — still valid if title absent.

- [ ] **Step 4: Run full public-files tests — expect PASS**

Run: `pnpm --filter @uploads/api exec vitest run test/routes-public-files.test.ts`

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/public-files.ts apps/api/test/routes-public-files.test.ts
git commit -m "$(cat <<'EOF'
feat(api): include GitHub title on public file metadata

Prefer live resolveTitles (KV-cached App ladder) over stamped gh.title
so share pages can show PR/issue titles without a public batch API.
EOF
)"
```

---

### Task 4: Web DTO validation + pure display helpers

**Files:**

- Modify: `apps/web/src/lib/public-file.ts`
- Modify: `apps/web/src/lib/public-file.test.ts`

**Interfaces:**

- Produces:
  - `GithubContext.title?: string`
  - `PublicFile.modified: string | null` (or optional; match `uploaded` nullability style)
  - `shouldShowModified(uploaded: string | null, modified: string | null): boolean`
  - `formatFileDate(iso: string, opts?: { withTime?: boolean }): string | null`

- [ ] **Step 1: Write failing tests in `public-file.test.ts`**

```ts
it("accepts optional modified and github.title", () => {
  expect(
    isPublicFile({
      ...file,
      modified: "2026-07-14T12:00:00.000Z",
      github: {
        repo: "o/r",
        kind: "pull",
        number: 1,
        url: "https://github.com/o/r/pull/1",
        title: "Fix the thing",
      },
    }),
  ).toBe(true);
});

it("rejects overlong github.title and bad modified", () => {
  expect(
    isPublicFile({
      ...file,
      github: {
        repo: "o/r",
        kind: "pull",
        number: 1,
        url: "https://github.com/o/r/pull/1",
        title: "x".repeat(513),
      },
    }),
  ).toBe(false);
  expect(isPublicFile({ ...file, modified: "not-a-date" })).toBe(false);
});

describe("shouldShowModified", () => {
  it("is false when modified missing or within 60s", () => {
    expect(shouldShowModified("2026-07-01T00:00:00.000Z", null)).toBe(false);
    expect(shouldShowModified("2026-07-01T00:00:00.000Z", "2026-07-01T00:00:30.000Z")).toBe(false);
  });
  it("is true when day differs or delta > 60s", () => {
    expect(shouldShowModified("2026-07-01T00:00:00.000Z", "2026-07-02T00:00:00.000Z")).toBe(true);
    expect(shouldShowModified("2026-07-01T00:00:00.000Z", "2026-07-01T00:02:00.000Z")).toBe(true);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm --filter @uploads/web exec vitest run src/lib/public-file.test.ts`

- [ ] **Step 3: Implement types + validators + helpers**

```ts
export interface GithubContext {
  repo: string;
  kind: "pull" | "issue";
  number: number;
  url: string;
  title?: string;
}

export interface PublicFile {
  // ...existing fields
  uploaded: string | null;
  /** Present when API reports a distinct last-modified time. */
  modified?: string | null;
  // ...
}

function isGithubContext(value: unknown): value is GithubContext {
  // existing checks...
  const titleOk =
    github.title === undefined ||
    (text(github.title, 512) && (github.title as string).length > 0);
  return /* existing */ && titleOk;
}

// in isPublicFile:
const modifiedOk =
  file.modified === undefined ||
  file.modified === null ||
  (text(file.modified, 64) && Number.isFinite(Date.parse(file.modified as string)));
```

```ts
const SHOW_MODIFIED_MS = 60_000;

export function shouldShowModified(
  uploaded: string | null | undefined,
  modified: string | null | undefined,
): boolean {
  if (!uploaded || !modified) return false;
  const a = Date.parse(uploaded);
  const b = Date.parse(modified);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  if (Math.abs(b - a) <= SHOW_MODIFIED_MS) return false;
  return true;
}

export function formatFileDate(iso: string, opts?: { withTime?: boolean }): string | null {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  if (opts?.withTime) {
    return d.toLocaleString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** True when both timestamps fall on the same UTC calendar day. */
export function sameUtcDay(a: string, b: string): boolean {
  const da = new Date(a);
  const db = new Date(b);
  if (!Number.isFinite(da.getTime()) || !Number.isFinite(db.getTime())) return false;
  return (
    da.getUTCFullYear() === db.getUTCFullYear() &&
    da.getUTCMonth() === db.getUTCMonth() &&
    da.getUTCDate() === db.getUTCDate()
  );
}
```

In `fetchPublicFile` ok branch, normalize:

```ts
file: {
  ...value,
  uploaded: value.uploaded ?? null,
  modified: value.modified ?? null,
}
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/public-file.ts apps/web/src/lib/public-file.test.ts
git commit -m "$(cat <<'EOF'
feat(web): accept public file modified + github.title DTOs

Validate the enriched public-files fields and add pure helpers for
dual-date display on the share page.
EOF
)"
```

---

### Task 5: Share page UI — chip title, dual dates, large-screen rail

**Files:**

- Modify: `apps/web/src/pages/f/[workspace]/[...key].astro`

**Interfaces:**

- Consumes: `file.github.title`, `file.uploaded`, `file.modified`, helpers from Task 4

- [ ] **Step 1: Frontmatter — compute display values**

Near existing `uploaded` / `uploadedLabel` logic:

```ts
import {
  // existing imports...
  formatFileDate,
  shouldShowModified,
  sameUtcDay,
} from "../../../lib/public-file";

const uploadedIso = file?.uploaded ?? null;
const modifiedIso = file?.modified ?? null;
const showModified = shouldShowModified(uploadedIso, modifiedIso);
const useTime = showModified && uploadedIso && modifiedIso && sameUtcDay(uploadedIso, modifiedIso);
const uploadedLabel = uploadedIso ? formatFileDate(uploadedIso, { withTime: !!useTime }) : null;
const modifiedLabel =
  showModified && modifiedIso ? formatFileDate(modifiedIso, { withTime: !!useTime }) : null;
```

- [ ] **Step 2: Update GitHub chip markup**

```astro
{file.github && (
  <a
    class="gh-chip"
    href={file.github.url}
    rel="noopener noreferrer"
    aria-label={
      file.github.title
        ? `${file.github.kind === "pull" ? "Pull request" : "Issue"} ${file.github.title} (${file.github.repo}#${file.github.number}) on GitHub`
        : `${file.github.kind === "pull" ? "Pull request" : "Issue"} ${file.github.repo}#${file.github.number} on GitHub`
    }
  >
    <!-- kind svg unchanged -->
    <span class="gh-chip-text">
      {file.github.title ? (
        <>
          <span class="gh-chip-title">{file.github.title}</span>
          <span class="gh-chip-ref">{file.github.repo}#{file.github.number}</span>
        </>
      ) : (
        <span class="gh-chip-name">{file.github.repo}#{file.github.number}</span>
      )}
    </span>
  </a>
)}
```

CSS additions:

```css
.gh-chip-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.gh-chip-title {
  overflow-wrap: anywhere;
  font-weight: 600;
}
.gh-chip-ref {
  color: var(--muted);
  font-size: 11px;
  overflow-wrap: anywhere;
}
```

- [ ] **Step 3: Dual date rows**

```astro
<dl class="meta">
  <dt>Type</dt><dd>{file.contentType}</dd>
  <dt>Size</dt><dd>{formatBytes(file.size)}</dd>
  {uploadedLabel && (<><dt>Uploaded</dt><dd>{uploadedLabel}</dd></>)}
  {modifiedLabel && (<><dt>Modified</dt><dd>{modifiedLabel}</dd></>)}
</dl>
```

- [ ] **Step 4: Large-screen rail layout**

Update shell + stage styles (keep narrow stack):

```css
.shell {
  width: min(var(--width-viewer, 1080px), calc(100% - 48px));
  margin: auto;
  padding: 36px 0 64px;
}
/* ...existing... */
.details {
  padding: 18px 20px 22px;
  border-top: 1px solid var(--line);
}

@media (min-width: 1080px) {
  /* align with signed-in --bp-rail (1080px); media queries can't read custom props */
  .shell {
    width: min(1200px, calc(100% - 48px));
  }
  .stage {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(280px, 320px);
    align-items: stretch;
  }
  .media {
    min-height: 320px;
    max-height: 78vh;
  }
  .details {
    border-top: none;
    border-left: 1px solid var(--line);
    max-height: 78vh;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 0;
  }
}
@media (max-width: 760px) {
  .shell {
    width: min(100% - 32px, 1080px);
    padding-top: 24px;
  }
  .media {
    min-height: 220px;
  }
}
```

Ensure `CopyAsControls` still sits at the bottom of `.details` (no markup move required if it's already last in figcaption).

- [ ] **Step 5: Manual / light verification**

Run web unit tests:  
`pnpm --filter @uploads/web exec vitest run src/lib/public-file.test.ts`

If local dev is available: open a file with `gh.*` metadata and confirm chip + rail at ≥1080px width. No Playwright required.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/f/\[workspace\]/\[...key\].astro
git commit -m "$(cat <<'EOF'
feat(web): file share page title, dual dates, and large-screen rail

Show GitHub titles on the chip, Uploaded+Modified when revisions
differ, and a media|meta layout from 1080px up.
EOF
)"
```

---

### Task 6: Docs touch (only if needed) + final verification

**Files:**

- Modify (conditional): `docs/api.md` — only if `GET /public/files` response is already documented
- No changeset required (private workers + web app; no `@buildinternet/uploads` user-facing package change unless you also change CLI)

- [ ] **Step 1: Check docs**

```bash
rg -n "public/files|uploaded" docs/api.md | head -20
```

If the public endpoint is documented, add `modified?` and `github.title?` in one short sentence. If not documented, skip.

- [ ] **Step 2: Full relevant test gates**

```bash
pnpm --filter @uploads/api exec vitest run test/routes-public-files.test.ts
pnpm --filter @uploads/web exec vitest run src/lib/public-file.test.ts
```

Expected: all PASS.

Optional typecheck if you touched Env usage (GITHUB_CACHE already on Env for titles):

```bash
pnpm --filter @uploads/api typecheck
pnpm --filter @uploads/web typecheck
```

- [ ] **Step 3: Commit docs if changed**

```bash
git add docs/api.md
git commit -m "docs(api): note public file modified and github.title fields"
```

- [ ] **Step 4: Stop — ready for PR**

Do not open the PR unless asked. Summarize commits on `feat/file-share-page-title-dates-rail`.

---

## Spec coverage checklist

| Spec requirement                                  | Task                                                     |
| ------------------------------------------------- | -------------------------------------------------------- |
| `uploaded-at` on create / preserve on overwrite   | Task 1                                                   |
| Legacy overwrite seeds from prior lastModified    | Task 1                                                   |
| Visibility rewrite preserves stamp                | Task 1 (automatic via metadata spread) + optional assert |
| Public `uploaded` / `modified` fields             | Task 2                                                   |
| Omit `modified` when ~equal                       | Task 2                                                   |
| `github.title` stamp + live resolve               | Task 3                                                   |
| Resolve failure never 500s                        | Task 3                                                   |
| Web DTO validation                                | Task 4                                                   |
| Dual-date UI (60s / day rules + time if same day) | Task 4–5                                                 |
| Chip title + secondary ref                        | Task 5                                                   |
| Rail ≥1080px                                      | Task 5                                                   |
| Files SDK only                                    | Tasks 1–2                                                |
| Gallery out of scope                              | —                                                        |
| No public batch titles API                        | Task 3 (inline resolve only)                             |

## Self-review notes

- No TBD/placeholder steps.
- `UPLOADED_AT_META_KEY` / `resolveUploadedAtMeta` / `publicDateFields` / `shouldShowModified` names are consistent across tasks.
- `github` equality tests that use `.toEqual` without `title` remain correct when title is omitted.
- Cache ref casing: Task 3 uses lowercased repo / `gh.ref` when present to match `resolveTitles` keys used by the rail.
