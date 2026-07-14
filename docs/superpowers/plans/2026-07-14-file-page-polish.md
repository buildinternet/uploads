# File Page Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Polish the public file page (`apps/web/src/pages/f/[workspace]/[...key].astro`, `ok` branch) and the per-item gallery page (`apps/web/src/pages/g/[id]/[item].astro`) with four improvements: a static GitHub chip, a real click-to-copy control, a single "Copy as" embed-format picker, and a working one-click Download — per the approved design spec (`docs/superpowers/specs/2026-07-14-file-page-polish-design.md`).

**Architecture:** Two small `apps/api` additions (a new `embedUrl` field on the public-files JSON, and two new streaming download routes sharing one helper) unlock the web-side work. A pure, unit-tested embed-format-string builder (`apps/web/src/lib/embed-formats.ts`) is shared by both `.astro` pages. Both pages' CSPs widen `script-src` to allow one small inline `<script>` per page (the same `data-copy` delegated-listener pattern already used on `/account/index.astro` and `/account/workspaces.astro`). No React, no `@uploads/ui`, no new dependencies.

**Tech Stack:** Hono (Cloudflare Workers API), Astro SSR pages with plain inline `<style>`/`<script>` (web), files-sdk 2.1.0 (`StoredFile.stream()`), vitest.

## Global Constraints

- **Static chip only.** No live GitHub fetch, no per-item gallery chip — gallery items carry no per-item GitHub context in the data model. The gallery-level `GalleryReferences` block is unchanged.
- **Embed snippet formats use `embedUrl ?? url`.** "Direct file URL" (the plain-URL option) uses the stable `url`, not the embed host.
- **CSP `script-src` widens to EXACTLY** `'self' 'unsafe-inline' https://static.cloudflareinsights.com` on both `PUBLIC_FILE_CSP` (file page `ok` branch) and `PUBLIC_GALLERY_CSP` (gallery pages). No `connect-src` change on either. Note: `PUBLIC_GALLERY_CSP` is a single shared constant used by both `/g/[id].astro` (index) and `/g/[id]/[item].astro` (item) — widening it affects the index page's headers too, even though only the item page gains a script. This is the accepted default per the design spec ("applied to `PUBLIC_GALLERY_CSP`... the same way").
- **Download routes** stream via `StoredFile.stream()` (no full-buffer), set `Content-Disposition: attachment; filename="..."` (RFC 5987 `filename*=UTF-8''...` plus an ASCII `filename=` fallback) and the correct `Content-Type`, reuse the existing public-visibility gate (workspace/gallery record → public-URL existence → `store.exists`/`head` → `objectVisibility` 401), full-file only (no range support). The download link renders **unconditionally** (even for `unsupported`/SVG file kinds) — forced `attachment` disposition sidesteps the inline-render XSS concern that hides "Open original" for those kinds, so Download is actually the _safer_ affordance there.
- **Route-ordering hazard (the #158 lesson, concretely):** the file route's key param is `:key{.+}` — a greedy multi-segment match. In Hono, the _first-registered_ route whose compiled pattern matches wins. `/:workspace/:key{.+}/download` MUST be registered before the generic `/:workspace/:key{.+}` in the same `Hono` chain, or the generic route silently swallows `/download` as part of the key and the download route is never reached. (The gallery route's `:id` is a single, non-greedy segment, so `/:id/items/:item/download` vs `/:id` has no such hazard — but verify on a preview worker anyway per the global lesson.) Before calling either download route done, hit it through a live preview worker with a real key containing `/` and an extension, not just vitest.
- **Preserve all existing branches/headers/metadata list; no media-stage redesign.** Plain Astro + inline `<style>`/`<script>`, no `@uploads/ui`, no new deps.
- **Discovery — gallery-side `embedUrl` is already shipped.** `apps/api/src/gallery-service.ts`'s `hydratePublicGallery` (and `PublicGalleryItemDto`) already return `embedUrl` on the public gallery item payload — landed in PR #154 (`c5b36a3`, "dual-host embedUrl for GitHub Camo"), and `apps/api/test/routes-galleries.test.ts` (~line 464) already asserts it's in the public item's field list. The design spec's claim that this is "simply dropped before reaching the web" is **stale** as of this plan's writing. Only the **web-side** type (`PublicGalleryItem`) and validator (`isPublicGallery`) are missing the field — Task 5 covers that; there is no gallery API change in this plan. The **file-page** `embedUrl` (Task 2) genuinely does not exist yet and is real, new work.
- Web typecheck command is `pnpm --filter @uploads/web typecheck` (**not** `types` — that's the narrower `wrangler types` codegen step `typecheck` already runs first). API tests: `pnpm --filter @uploads/api test`. Web has no React/Astro render harness — `.astro` "tests" are typecheck + build + preview-worker verification, not vitest; say so explicitly rather than fabricating a render test.
- Commit after each task.

---

### Task 1: Shared embed-format-string builder

**Files:**

- Create: `apps/web/src/lib/embed-formats.ts`
- Test: `apps/web/src/lib/embed-formats.test.ts`

**Interfaces:**

- Produces:
  ```ts
  export type EmbedFormatId = "page" | "url" | "markdown-image" | "markdown-link" | "html-img";
  export interface EmbedFormatOption {
    id: EmbedFormatId;
    label: string;
    value: string;
  }
  export interface EmbedFormatInput {
    canonical: string;
    url: string;
    embedUrl: string | null;
    filename: string;
    kind: "image" | "video" | "file" | "unsupported";
  }
  export function buildEmbedFormats(input: EmbedFormatInput): EmbedFormatOption[];
  ```
- Consumed by: Task 8 (file page) and Task 9 (gallery item page) with the exact same signature — file page's `MediaKind` (`fileKind()` in `public-file.ts`) and gallery's `MediaKind` minus `"missing"` (only called when an item is `"available"`) both satisfy `kind`.

This is the pure function the design spec's §3.3 table maps to: Page link (always) → Direct file URL (always) → Markdown image (image only) → Markdown link (always) → HTML `<img>` (image only), in that order. `embedSrc` (used by the two embed-snippet formats) is `embedUrl ?? url`; "Direct file URL" always uses the stable `url`.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/lib/embed-formats.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildEmbedFormats } from "./embed-formats";

const base = {
  canonical: "https://uploads.sh/f/acme/screenshots/shot.png",
  url: "https://storage.uploads.sh/acme/screenshots/shot.png",
  embedUrl: "https://embed.uploads.sh/acme/screenshots/shot.png" as string | null,
  filename: "shot.png",
};

describe("buildEmbedFormats", () => {
  it("returns all five formats, in order, for an image", () => {
    const formats = buildEmbedFormats({ ...base, kind: "image" });
    expect(formats.map((f) => f.id)).toEqual([
      "page",
      "url",
      "markdown-image",
      "markdown-link",
      "html-img",
    ]);
    expect(formats).toEqual([
      { id: "page", label: "Page link", value: base.canonical },
      { id: "url", label: "Direct file URL", value: base.url },
      { id: "markdown-image", label: "Markdown image", value: `![](${base.embedUrl})` },
      { id: "markdown-link", label: "Markdown link", value: `[shot.png](${base.canonical})` },
      {
        id: "html-img",
        label: "HTML <img>",
        value: `<img src="${base.embedUrl}" alt="shot.png">`,
      },
    ]);
  });

  it("drops the markdown-image and html-img formats for video/file/unsupported kinds", () => {
    for (const kind of ["video", "file", "unsupported"] as const) {
      const formats = buildEmbedFormats({ ...base, kind });
      expect(formats.map((f) => f.id)).toEqual(["page", "url", "markdown-link"]);
    }
  });

  it("embed snippet formats prefer embedUrl over url; Direct file URL always uses the stable url", () => {
    const formats = buildEmbedFormats({ ...base, kind: "image" });
    const direct = formats.find((f) => f.id === "url")!;
    const mdImage = formats.find((f) => f.id === "markdown-image")!;
    const html = formats.find((f) => f.id === "html-img")!;
    expect(direct.value).toBe(base.url);
    expect(mdImage.value).toContain(base.embedUrl);
    expect(html.value).toContain(base.embedUrl);
  });

  it("falls back to url for embed snippets when embedUrl is null", () => {
    const formats = buildEmbedFormats({ ...base, embedUrl: null, kind: "image" });
    expect(formats.find((f) => f.id === "markdown-image")!.value).toBe(`![](${base.url})`);
    expect(formats.find((f) => f.id === "html-img")!.value).toBe(
      `<img src="${base.url}" alt="shot.png">`,
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @uploads/web test -- embed-formats.test.ts`
Expected: FAIL — `./embed-formats` module does not exist.

- [ ] **Step 3: Implement the helper**

Create `apps/web/src/lib/embed-formats.ts`:

```ts
/**
 * Pure embed-format-string builder shared by the public file page
 * (`pages/f/[workspace]/[...key].astro`) and the public gallery-item page
 * (`pages/g/[id]/[item].astro`) — issue's "Copy as" control (design spec
 * §3.3). Kept dependency-free and framework-free so both `.astro` pages can
 * import it directly and it stays unit-testable without a render harness.
 */

export type EmbedFormatId = "page" | "url" | "markdown-image" | "markdown-link" | "html-img";

export interface EmbedFormatOption {
  id: EmbedFormatId;
  label: string;
  value: string;
}

export interface EmbedFormatInput {
  /** On-site canonical page URL (`/f/<workspace>/<key>` or `/g/<id>/<item>`). */
  canonical: string;
  /** Stable public URL — `PublicFile.url` / `PublicGalleryItem.url`. */
  url: string;
  /** Embed-host URL when available (dual-host GitHub Camo policy); null otherwise. */
  embedUrl: string | null;
  filename: string;
  /** `"missing"` gallery items never reach this — callers only call it when a URL exists. */
  kind: "image" | "video" | "file" | "unsupported";
}

/**
 * Five candidate formats, gated by `kind`, in the fixed order the design
 * spec's §3.3 table lists them: Page link, Direct file URL, Markdown image
 * (image only), Markdown link, HTML `<img>` (image only). Embed *snippet*
 * formats (Markdown image, HTML img) prefer `embedUrl` and fall back to the
 * stable `url`; "Direct file URL" always uses the stable `url` — mirrors
 * `packages/uploads/src/commands.ts`'s existing "MARKDOWN prefers embedUrl"
 * convention.
 */
export function buildEmbedFormats(input: EmbedFormatInput): EmbedFormatOption[] {
  const embedSrc = input.embedUrl ?? input.url;
  const options: EmbedFormatOption[] = [
    { id: "page", label: "Page link", value: input.canonical },
    { id: "url", label: "Direct file URL", value: input.url },
  ];
  if (input.kind === "image") {
    options.push({ id: "markdown-image", label: "Markdown image", value: `![](${embedSrc})` });
  }
  options.push({
    id: "markdown-link",
    label: "Markdown link",
    value: `[${input.filename}](${input.canonical})`,
  });
  if (input.kind === "image") {
    options.push({
      id: "html-img",
      label: "HTML <img>",
      value: `<img src="${embedSrc}" alt="${input.filename}">`,
    });
  }
  return options;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @uploads/web test -- embed-formats.test.ts`
Expected: PASS (all four cases).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/embed-formats.ts apps/web/src/lib/embed-formats.test.ts
git commit -m "feat(web): shared embed-format-string builder for the Copy-as control"
```

---

### Task 2: API — surface `embedUrl` on the public file route

**Files:**

- Modify: `apps/api/src/routes/public-files.ts`
- Test: `apps/api/test/routes-public-files.test.ts`

**Interfaces:**

- Consumes: `objectPublicUrls(env, cfg, key) => { url: string | null; embedUrl: string | null }` from `../storage` (already used by `files.ts`/`gallery-service.ts`; swaps out the narrower `publicUrl()` this route currently calls).
- Produces: `GET /public/files/:workspace/:key` response gains `embedUrl: string | null` alongside the existing `url`.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/test/routes-public-files.test.ts`, inside the existing `describe("GET /public/files/:workspace/:key", ...)` block (after the `"returns metadata + the public URL..."` test):

```ts
it("includes an embedUrl alongside the stable url", async () => {
  const { env } = await makeEnv();
  await seedShot(env);

  const res = await app.request("/public/files/default/screenshots/shot.png", {}, env);
  expect(res.status).toBe(200);
  const json = (await res.json()) as { url: string; embedUrl: string | null };
  expect(json.url).toBe("https://storage.uploads.sh/default/screenshots/shot.png");
  expect(json.embedUrl).toBe("https://embed.uploads.sh/default/screenshots/shot.png");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @uploads/api test -- routes-public-files.test.ts`
Expected: FAIL — `json.embedUrl` is `undefined`, not the expected string.

- [ ] **Step 3: Add `embedUrl` to the route**

In `apps/api/src/routes/public-files.ts`, change the import (line 5):

```ts
import { objectPublicUrls, storage, storageConfig } from "../storage";
```

(drops `publicUrl`, adds `objectPublicUrls`.)

Replace the URL resolution + response body:

```ts
// Phase 1 is public-workspace-only: resolving the public URL doubles as the
// visibility gate. A workspace without a public base URL cannot be wrapped
// here — that is #123's signed-URL territory, swapped in when it lands.
const cfg = await storageConfig(c.env, record);
const urls = objectPublicUrls(c.env, cfg, key);
if (!urls.url) throw new NotFoundError();

const store = await storage(c.env, record);
if (!(await store.exists(key))) throw new NotFoundError();
const meta = await store.head(key);

if (objectVisibility(meta.metadata ?? undefined)) {
  throw new UnauthorizedError("sign in to view this file", { code: "auth_required" });
}

// Fetched only after the visibility gate above — a private object 401s
// before this D1 read ever happens, so metadata never leaks.
const metadata = await getFileMetadata(c.env.DB, workspace, key);
const github = deriveGithubContext(metadata);

return c.json({
  workspace,
  key,
  url: urls.url,
  embedUrl: urls.embedUrl,
  size: meta.size ?? 0,
  contentType: meta.type ?? "application/octet-stream",
  ...(meta.lastModified != null ? { uploaded: new Date(meta.lastModified).toISOString() } : {}),
  ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  ...(github ? { github } : {}),
});
```

(This is the same handler body, just resolving `url`/`embedUrl` together via `objectPublicUrls` instead of `publicUrl`, and adding `embedUrl` to the JSON. No other behavior changes.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @uploads/api test -- routes-public-files.test.ts`
Expected: PASS — including all pre-existing tests in the file (embedUrl is additive; nothing else in the response shape changed).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @uploads/api typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/public-files.ts apps/api/test/routes-public-files.test.ts
git commit -m "feat(api): surface embedUrl on the public file route"
```

---

### Task 3: API — shared streaming download helper + file download route

**Files:**

- Modify: `apps/api/src/files-core.ts` (new `downloadResponse` helper, next to the existing `store.download()` use in `setObjectVisibility`)
- Modify: `apps/api/src/routes/public-files.ts` (new `resolvePublicObject` helper + `/download` route, registered before the generic route)
- Test: `apps/api/test/routes-public-files.test.ts`

**Interfaces:**

- Produces (in `files-core.ts`):
  ```ts
  export function downloadResponse(store: Files, key: string, filename: string): Promise<Response>;
  ```
  Streams `store.download(key)` straight into a `Response` body (`StoredFile.stream()`, never buffered), with `Content-Type` from the stored object and `Content-Disposition: attachment; filename="<ascii fallback>"; filename*=UTF-8''<RFC 5987 encoded>`.
- Consumed by: `public-files.ts`'s new download route (this task) and `public-galleries.ts`'s new download route (Task 4) — the one shared streaming helper the design spec calls for.

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/test/routes-public-files.test.ts`, as a new `describe` block after the existing `describe("GET /public/files/:workspace/:key", ...)`:

```ts
describe("GET /public/files/:workspace/:key/download", () => {
  it("streams the object with a forced attachment disposition", async () => {
    const { env } = await makeEnv();
    await seedShot(env);

    const res = await app.request("/public/files/default/screenshots/shot.png/download", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Content-Disposition")).toBe(
      "attachment; filename=\"shot.png\"; filename*=UTF-8''shot.png",
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes).toEqual(PNG);
  });

  it("401s with auth_required for a private object, without streaming bytes", async () => {
    const { env } = await makeEnv();
    await seedShot(env, { "X-Uploads-Visibility": "private" });

    const res = await app.request("/public/files/default/screenshots/shot.png/download", {}, env);
    expect(res.status).toBe(401);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "auth_required" },
    });
  });

  it("404s for a missing object", async () => {
    const { env } = await makeEnv();
    const res = await app.request(
      "/public/files/default/screenshots/missing.png/download",
      {},
      env,
    );
    expect(res.status).toBe(404);
  });

  it("does not let the /download suffix route shadow a key literally named 'download'", async () => {
    // Regression for the #158-style routing risk: :key{.+} is greedy, so the
    // /download route must be registered before the generic metadata route,
    // or a key ending in "/download" would always hit the download handler,
    // AND a key that just happens to be named "download" must still resolve
    // through the plain metadata route unharmed.
    const { env } = await makeEnv();
    const put = await app.request(
      "/v1/default/files/screenshots/download",
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "image/png" },
        body: PNG,
      },
      env,
    );
    expect(put.status).toBe(201);
    const meta = await app.request("/public/files/default/screenshots/download", {}, env);
    expect(meta.status).toBe(200);
    expect(((await meta.json()) as { key: string }).key).toBe("screenshots/download");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @uploads/api test -- routes-public-files.test.ts`
Expected: FAIL — `/download` 404s (no such route yet), so the first three new tests fail on status; the fourth already passes today (no code change needed for it yet) but keep it here so it stays green as a regression guard through the rest of this task.

- [ ] **Step 3: Add the streaming helper to `files-core.ts`**

In `apps/api/src/files-core.ts`, add after `setObjectVisibility` (after the closing brace that currently ends around line 272):

```ts
/** Non-ASCII-safe fallback for the `filename=` param (browsers that ignore `filename*`). */
function asciiFilenameFallback(filename: string): string {
  return filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
}

/** RFC 5987 `filename*=UTF-8''...` value for a Content-Disposition header. */
function encodeRfc5987Filename(filename: string): string {
  return encodeURIComponent(filename)
    .replace(/['()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/\*/g, "%2A");
}

/**
 * Stream a stored object as a forced-download `Response`. Shared by the
 * public file (`routes/public-files.ts`) and public gallery-item
 * (`routes/public-galleries.ts`) download routes (design spec §3.4) — bytes
 * are proxied through this Worker specifically for the download action (the
 * inline-preview path keeps using the R2 custom domain directly, unchanged).
 * Full-file only: no `Range` support. Uses `StoredFile.stream()` so the whole
 * object is never buffered into Worker memory.
 */
export async function downloadResponse(
  store: Files,
  key: string,
  filename: string,
): Promise<Response> {
  const file = await store.download(key);
  const headers = new Headers();
  headers.set("Content-Type", file.type || "application/octet-stream");
  headers.set(
    "Content-Disposition",
    `attachment; filename="${asciiFilenameFallback(filename)}"; ` +
      `filename*=UTF-8''${encodeRfc5987Filename(filename)}`,
  );
  if (typeof file.size === "number") headers.set("Content-Length", String(file.size));
  headers.set("Cache-Control", "no-store");
  return new Response(file.stream(), { headers });
}
```

- [ ] **Step 4: Add the resolver + download route to `public-files.ts`**

In `apps/api/src/routes/public-files.ts`, update the imports:

```ts
import { NotFoundError, UnauthorizedError } from "@uploads/errors";
import { Hono } from "hono";
import type { Files } from "@uploads/storage";
import { badKey, downloadResponse } from "../files-core";
import { getFileMetadata } from "../file-metadata";
import { objectPublicUrls, storage, storageConfig } from "../storage";
import { objectVisibility } from "../visibility";
import { loadWorkspaceRecord, type WorkspaceVars } from "../workspace";
```

Add a shared resolver above the route definitions (after `deriveGithubContext`):

```ts
interface ResolvedPublicObject {
  store: Files;
  meta: { size?: number; type?: string; lastModified?: number; metadata?: Record<string, string> };
  urls: { url: string | null; embedUrl: string | null };
}

/**
 * Shared lookup + visibility gate for every `/public/files/:workspace/:key*`
 * GET handler: workspace record → publicUrl existence → store.exists/head →
 * objectVisibility 401. Both the metadata route and the download route below
 * call this so the two can never disagree about who gets to see (or
 * download) an object.
 */
async function resolvePublicObject(
  env: Env,
  workspace: string,
  key: string,
): Promise<ResolvedPublicObject> {
  if (badKey(key)) throw new NotFoundError();
  const record = await loadWorkspaceRecord(env, workspace);
  if (!record) throw new NotFoundError();
  const cfg = await storageConfig(env, record);
  const urls = objectPublicUrls(env, cfg, key);
  if (!urls.url) throw new NotFoundError();
  const store = await storage(env, record);
  if (!(await store.exists(key))) throw new NotFoundError();
  const meta = await store.head(key);
  if (objectVisibility(meta.metadata ?? undefined)) {
    throw new UnauthorizedError("sign in to view this file", { code: "auth_required" });
  }
  return { store, meta, urls };
}
```

Replace the `export const publicFiles = ...` block with (a `?download=1` query
flag on the existing handler, not a separate `/download` suffix route — a
static suffix after the greedy `:key{.+}` param is inherently ambiguous, since
a request for `.../screenshots/download` could mean the suffix OR an object
literally named `screenshots/download`; see the `?metadata=1` precedent in
`routes/files.ts` for the same reasoning. The visibility gate in
`resolvePublicObject` runs exactly once either way — this is purely a
"stream vs json" branch on the same resolved object):

```ts
export const publicFiles = new Hono<WorkspaceVars>().get("/:workspace/:key{.+}", async (c) => {
  const workspace = c.req.param("workspace");
  const key = c.req.param("key");
  const { store, meta, urls } = await resolvePublicObject(c.env, workspace, key);

  const downloadParam = c.req.query("download");
  if (downloadParam === "1" || downloadParam === "true") {
    const filename = key.split("/").filter(Boolean).pop() ?? key;
    return downloadResponse(store, key, filename);
  }

  const metadata = await getFileMetadata(c.env.DB, workspace, key);
  const github = deriveGithubContext(metadata);

  return c.json({
    workspace,
    key,
    url: urls.url,
    embedUrl: urls.embedUrl,
    size: meta.size ?? 0,
    contentType: meta.type ?? "application/octet-stream",
    ...(meta.lastModified != null ? { uploaded: new Date(meta.lastModified).toISOString() } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    ...(github ? { github } : {}),
  });
});
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @uploads/api test -- routes-public-files.test.ts`
Expected: PASS — all tests in the file, including the new `/download` describe block and the pre-existing metadata-route tests (unchanged behavior via `resolvePublicObject`).

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @uploads/api typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/files-core.ts apps/api/src/routes/public-files.ts apps/api/test/routes-public-files.test.ts
git commit -m "feat(api): stream a forced-download response for public files"
```

---

### Task 4: API — gallery-item download route

**Files:**

- Modify: `apps/api/src/routes/public-galleries.ts`
- Test: `apps/api/test/routes-galleries.test.ts`

**Interfaces:**

- Consumes: `downloadResponse` from `../files-core` (Task 3); `storage` from `../storage`; `resolvePublicGallery`, `listGalleryItems` from `../galleries` (already imported).
- Produces: `GET /public/galleries/:id/items/:item/download` — 200 streaming the item's object, 404 for an unknown/non-public gallery or item, 404 when the underlying object no longer exists (tombstoned item).

Unlike the file route, `:id` is a single non-greedy path segment, so there's no `{.+}`-shadowing hazard between `/:id/items/:item/download` and `/:id` — but register the more specific route first anyway for consistency, and still verify on a preview worker per the global routing lesson.

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/test/routes-galleries.test.ts`, as a new `describe` block near the end of the file (same `env`/`request`/`create` helpers already set up by the file's `beforeEach`):

```ts
describe("GET /public/galleries/:id/items/:item/download", () => {
  it("streams the item's object with a forced attachment disposition", async () => {
    const gallery = await create();
    const added = await request(`/v1/alpha/galleries/${gallery.id}/items`, {
      method: "POST",
      body: JSON.stringify({ expectedVersion: 1, objectKey: "screenshots/one.png" }),
    });
    expect(added.status).toBe(201);
    const item = (await added.json()) as { id: string };

    const res = await app.request(
      `/public/galleries/${gallery.id}/items/${item.id}/download`,
      {},
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toBe(
      "attachment; filename=\"one.png\"; filename*=UTF-8''one.png",
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes).toEqual(PNG);
  });

  it("404s for an unknown item id", async () => {
    const gallery = await create();
    const res = await app.request(
      `/public/galleries/${gallery.id}/items/item_missing/download`,
      {},
      env,
    );
    expect(res.status).toBe(404);
  });

  it("404s for a non-public (unknown) gallery id", async () => {
    const res = await app.request("/public/galleries/gal_doesnotexist/items/x/download", {}, env);
    expect(res.status).toBe(404);
  });

  it("404s when the item's underlying object has been deleted (tombstone)", async () => {
    const gallery = await create();
    const added = await request(`/v1/alpha/galleries/${gallery.id}/items`, {
      method: "POST",
      body: JSON.stringify({ expectedVersion: 1, objectKey: "screenshots/one.png" }),
    });
    const item = (await added.json()) as { id: string };
    await bucket.delete("alpha/screenshots/one.png");

    const res = await app.request(
      `/public/galleries/${gallery.id}/items/${item.id}/download`,
      {},
      env,
    );
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @uploads/api test -- routes-galleries.test.ts`
Expected: FAIL — `/download` 404s across the board (no such route), so the first test's `200` assertion fails.

- [ ] **Step 3: Add the download route**

In `apps/api/src/routes/public-galleries.ts`, update the imports:

```ts
import { NotFoundError } from "@uploads/errors";
import { Hono } from "hono";
import { downloadResponse } from "../files-core";
import { listExternalReferences, listGalleryItems, resolvePublicGallery } from "../galleries";
import { hydratePublicGallery } from "../gallery-service";
import { storage } from "../storage";
import { type WorkspaceRecord, type WorkspaceVars } from "../workspace";
```

Replace the `export const publicGalleries = ...` block with (download route registered first, matching the file route's convention):

```ts
export const publicGalleries = new Hono<WorkspaceVars>()
  .get("/:id/items/:item/download", async (c) => {
    const record = await resolvePublicGallery(c.env.DB, c.req.param("id"));
    if (!record) throw new NotFoundError("Gallery not found.", { code: "gallery_not_found" });

    const items = await listGalleryItems(c.env.DB, record.workspace, record.id);
    const item = items.find((entry) => entry.id === c.req.param("item"));
    if (!item) {
      throw new NotFoundError("Gallery item not found.", { code: "gallery_item_not_found" });
    }

    const workspace = await c.env.REGISTRY.get<WorkspaceRecord>(`ws:${record.workspace}`, {
      type: "json",
      cacheTtl: 60,
    });
    if (!workspace) throw new NotFoundError("Gallery not found.", { code: "gallery_not_found" });

    const store = await storage(c.env, workspace);
    if (!(await store.exists(item.object_key))) {
      throw new NotFoundError("Gallery item not found.", { code: "gallery_item_not_found" });
    }
    const filename = item.object_key.split("/").filter(Boolean).pop() ?? item.object_key;
    return downloadResponse(store, item.object_key, filename);
  })
  .get("/:id", async (c) => {
    const record = await resolvePublicGallery(c.env.DB, c.req.param("id"));
    if (!record) throw new NotFoundError("Gallery not found.", { code: "gallery_not_found" });
    const workspace = await c.env.REGISTRY.get<WorkspaceRecord>(`ws:${record.workspace}`, {
      type: "json",
      cacheTtl: 60,
    });
    if (!workspace) throw new NotFoundError("Gallery not found.", { code: "gallery_not_found" });
    const [items, references] = await Promise.all([
      listGalleryItems(c.env.DB, record.workspace, record.id),
      listExternalReferences(c.env.DB, record.workspace, record.id),
    ]);
    return c.json(await hydratePublicGallery(c.env, workspace, record, items, references));
  });
```

(The `/:id` handler body is unchanged from today — only re-pasted here because it now sits after the new `.get(...)` in the same chained expression.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @uploads/api test -- routes-galleries.test.ts`
Expected: PASS — new download-route tests plus every pre-existing test in the file.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @uploads/api typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/public-galleries.ts apps/api/test/routes-galleries.test.ts
git commit -m "feat(api): stream a forced-download response for gallery items"
```

---

### Task 5: Web — surface `embedUrl` on both public DTOs

**Files:**

- Modify: `apps/web/src/lib/public-file.ts`, `apps/web/src/lib/public-file.test.ts`
- Modify: `apps/web/src/lib/public-gallery.ts`, `apps/web/src/lib/public-gallery.test.ts`

**Interfaces:**

- Produces: `PublicFile.embedUrl: string | null` (required field) + `isPublicFile` validates it; `PublicGalleryItem.embedUrl: string | null` (required field) + `isPublicGallery` validates it per-item.
- As noted in Global Constraints, the gallery API side already returns `embedUrl` (PR #154) — this task's gallery half is a type/validator-only change that _unlocks_ an already-shipped field for the web page (Task 9); its file-page half is genuinely new, unblocked by Task 2.

- [ ] **Step 1: Write the failing tests**

In `apps/web/src/lib/public-file.test.ts`, update the shared `file` fixture (top of the file) to include `embedUrl`:

```ts
const file = {
  workspace: "acme",
  key: "screenshots/shot.png",
  url: "https://storage.uploads.sh/acme/screenshots/shot.png",
  embedUrl: "https://embed.uploads.sh/acme/screenshots/shot.png" as string | null,
  size: 20480,
  contentType: "image/png",
  uploaded: "2026-07-13T12:00:00.000Z",
} as const;
```

Add a new test inside `describe("isPublicFile", ...)`, after the `"accepts the bounded DTO..."` case:

```ts
it("accepts a null embedUrl but rejects a non-https one", () => {
  expect(isPublicFile({ ...file, embedUrl: null })).toBe(true);
  expect(isPublicFile({ ...file, embedUrl: "http://embed.uploads.sh/x" })).toBe(false);
  const { embedUrl: _omit, ...noEmbedUrl } = file;
  expect(isPublicFile(noEmbedUrl)).toBe(false);
});
```

In `apps/web/src/lib/public-gallery.test.ts`, update the shared `gallery` fixture's single item to include `embedUrl`:

```ts
  items: [
    {
      id: "item-1",
      filename: "screen.png",
      position: 1000,
      caption: "<img onerror=alert(1)>",
      altText: "Screenshot",
      status: "available",
      url: "https://storage.uploads.sh/screen.png",
      embedUrl: "https://embed.uploads.sh/screen.png" as string | null,
      contentType: "image/png",
    },
  ],
```

Add a new case inside `describe("public gallery API", ...)`, after the `"rejects unsafe URLs..."` case:

```ts
it("accepts a null item embedUrl but rejects a non-https one", () => {
  expect(isPublicGallery({ ...gallery, items: [{ ...gallery.items[0], embedUrl: null }] })).toBe(
    true,
  );
  expect(
    isPublicGallery({
      ...gallery,
      items: [{ ...gallery.items[0], embedUrl: "http://embed.uploads.sh/x" }],
    }),
  ).toBe(false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @uploads/web test -- public-file.test.ts public-gallery.test.ts`
Expected: FAIL — `PublicFile`/`PublicGalleryItem` don't have `embedUrl` yet, so the fixtures fail to typecheck-adjacent-validate (`isPublicFile`/`isPublicGallery` currently ignore the extra field and, for the "rejects... non-https" and "requires the field" cases, wrongly return `true`).

- [ ] **Step 3: Add `embedUrl` to `public-file.ts`**

Update the `PublicFile` interface:

```ts
export interface PublicFile {
  workspace: string;
  key: string;
  url: string;
  /** Embed-host URL when the dual-host policy applies (GitHub Camo); null otherwise. */
  embedUrl: string | null;
  size: number;
  contentType: string;
  uploaded: string | null;
  /** Queryable `gh.*`-and-other custom metadata pairs; omitted when there are none. */
  metadata?: Record<string, string>;
  /** Convenience view of `gh.repo`/`gh.kind`/`gh.number`, when all three are present and valid. */
  github?: GithubContext;
}
```

Add a nullable variant of the existing `httpsUrl` check, right after it:

```ts
/** `httpsUrl`, but also accepts `null` — for optional-but-typed URL fields like `embedUrl`. */
function nullableHttpsUrl(value: unknown): value is string | null {
  return value === null || httpsUrl(value);
}
```

Update `isPublicFile`'s return expression to require it:

```ts
return (
  text(file.workspace, 64) &&
  text(file.key, 1024) &&
  httpsUrl(file.url) &&
  nullableHttpsUrl(file.embedUrl) &&
  Number.isSafeInteger(file.size) &&
  (file.size as number) >= 0 &&
  text(file.contentType, 128) &&
  uploadedOk &&
  metadataOk &&
  githubOk
);
```

- [ ] **Step 4: Add `embedUrl` to `public-gallery.ts`**

Update the `PublicGalleryItem` interface:

```ts
export interface PublicGalleryItem {
  id: string;
  filename: string;
  position: number;
  caption: string | null;
  altText: string | null;
  status: "available" | "missing";
  url: string | null;
  /** Embed-host URL when the dual-host policy applies; null otherwise. Always present (see gallery-service.ts). */
  embedUrl: string | null;
  contentType: string | null;
}
```

Update the per-item validator inside `isPublicGallery` (the `gallery.items.every(...)` block):

```ts
return gallery.items.every((entry) => {
  if (typeof entry !== "object" || entry === null) return false;
  const item = entry as Record<string, unknown>;
  return (
    text(item.id, 64) &&
    text(item.filename, 1024) &&
    Number.isSafeInteger(item.position) &&
    (item.position as number) > 0 &&
    nullableText(item.caption, 500) &&
    nullableText(item.altText, 300) &&
    (item.status === "available" || item.status === "missing") &&
    safeUrl(item.url) &&
    safeUrl(item.embedUrl) &&
    nullableText(item.contentType, 128) &&
    (item.status === "missing" ? item.url === null : item.url !== null)
  );
});
```

(`safeUrl` already accepts `null` — same helper the existing `url` field uses.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @uploads/web test -- public-file.test.ts public-gallery.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @uploads/web typecheck`
Expected: no errors. (This is also where a stale `PublicFile`/`PublicGalleryItem` literal elsewhere in `apps/web` would surface as a missing-field error — grep confirmed the only other references are the two `.astro` pages themselves, updated in Tasks 8–9, and `AccountFileBrowser.tsx`'s unrelated `openPublicFile` function name.)

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/public-file.ts apps/web/src/lib/public-file.test.ts apps/web/src/lib/public-gallery.ts apps/web/src/lib/public-gallery.test.ts
git commit -m "feat(web): surface embedUrl on the public file + gallery item types"
```

---

### Task 6: CSP — widen `script-src` on both public pages

**Files:**

- Modify: `apps/web/src/lib/public-file.ts`, `apps/web/src/lib/public-file.test.ts`
- Modify: `apps/web/src/lib/public-gallery.ts`, `apps/web/src/lib/public-gallery.test.ts`

**Interfaces:**

- `PUBLIC_FILE_CSP` and `PUBLIC_GALLERY_CSP`'s `script-src` directive both become `'self' 'unsafe-inline' https://static.cloudflareinsights.com` (imports `CF_RUM_SCRIPT_SRC` from `./csp`, unchanged constant). No other directive changes on either.

- [ ] **Step 1: Update (RED) the existing gallery CSP test**

In `apps/web/src/lib/public-gallery.test.ts`, the existing assertion at line 46 currently pins the _old_ strict value and will fail once Step 3 below ships:

```ts
expect(PUBLIC_GALLERY_CSP).toContain("script-src https://static.cloudflareinsights.com");
```

Change it to assert the widened value:

```ts
// Copy button + Copy-as control (design spec §3.2/§3.3) need inline
// script — same posture the file page's auth_required branch already
// shipped and tested.
expect(PUBLIC_GALLERY_CSP).toContain(
  "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com",
);
```

Add the equivalent new assertion to `apps/web/src/lib/public-file.test.ts`'s `describe("public file headers", ...)` block, after the existing `"locks down like the public gallery..."` test:

```ts
it("widens script-src on the ok branch too — same posture as authRequiredFileCsp", () => {
  expect(PUBLIC_FILE_CSP).toContain(
    "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com",
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @uploads/web test -- public-file.test.ts public-gallery.test.ts`
Expected: FAIL — `PUBLIC_GALLERY_CSP` still has the old strict `script-src`; `PUBLIC_FILE_CSP`'s new assertion fails too.

- [ ] **Step 3: Widen `PUBLIC_FILE_CSP`**

In `apps/web/src/lib/public-file.ts`, change:

```ts
export const PUBLIC_FILE_CSP = buildFileCsp();
```

to:

```ts
/**
 * Public file page CSP — same posture as the public gallery: locked down
 * except for self-hosted styles/fonts, the Cloudflare RUM beacon, and (as of
 * the file-page-polish work) inline script for the click-to-copy button and
 * "Copy as" control. `connect-src` stays untouched — clipboard writes never
 * hit the network, and the download link needs no script at all.
 */
export const PUBLIC_FILE_CSP = buildFileCsp({
  scriptSrc: `'self' 'unsafe-inline' ${CF_RUM_SCRIPT_SRC}`,
});
```

- [ ] **Step 4: Widen `PUBLIC_GALLERY_CSP`**

In `apps/web/src/lib/public-gallery.ts`, change:

```ts
  `script-src ${CF_RUM_SCRIPT_SRC}`,
```

to:

```ts
  // Widened for the copy button + "Copy as" control on the item page (design
  // spec §4.5); the gallery index page shares this constant and inherits the
  // widening even though it adds no script of its own.
  `script-src 'self' 'unsafe-inline' ${CF_RUM_SCRIPT_SRC}`,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @uploads/web test -- public-file.test.ts public-gallery.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/public-file.ts apps/web/src/lib/public-file.test.ts apps/web/src/lib/public-gallery.ts apps/web/src/lib/public-gallery.test.ts
git commit -m "feat(web): widen script-src on the public file + gallery CSPs for copy/embed controls"
```

---

### Task 7: File page — GitHub chip

**Files:**

- Modify: `apps/web/src/pages/f/[workspace]/[...key].astro`

**Interfaces:**

- Consumes: `GitHubMark` (`../../../components/GitHubMark.astro`, already exists), `file.github: GithubContext | undefined`.
- No test harness for `.astro` — this task's "test" is typecheck + build; visual confirmation happens in Task 10.

- [ ] **Step 1: Import `GitHubMark`**

In `apps/web/src/pages/f/[workspace]/[...key].astro`, add to the frontmatter imports:

```astro
---
import BaseHead from "../../../components/BaseHead.astro";
import Brand from "../../../components/Brand.astro";
import Footer from "../../../components/Footer.astro";
import GitHubMark from "../../../components/GitHubMark.astro";
import {
  applyPublicFileHeaders,
  authRequiredFileCsp,
  fetchPublicFile,
  fileKind as kind,
  filePath,
  formatBytes,
} from "../../../lib/public-file";
import { env } from "cloudflare:workers";
```

- [ ] **Step 2: Move the chip out of `dl.meta` into its own row**

Remove this block from inside `<dl class="meta">` (currently between the `Uploaded` pair and the closing `</dl>`):

```astro
                {file.github && (
                  <>
                    <dt>Attached to</dt>
                    <dd>
                      <a href={file.github.url} rel="noopener noreferrer">{file.github.repo}#{file.github.number}</a>
                      <span class="gh-kind">{file.github.kind === "pull" ? "PR" : "Issue"}</span>
                    </dd>
                  </>
                )}
```

Insert a standalone chip directly after `<div class="filename">{filename}</div>` and before `<dl class="meta">`:

```astro
              <div class="filename">{filename}</div>
              {file.github && (
                <a class="gh-chip" href={file.github.url} rel="noopener noreferrer">
                  <GitHubMark size={14} />
                  <span class="gh-chip-name">{file.github.repo}#{file.github.number}</span>
                  <span class="gh-chip-kind">{file.github.kind === "pull" ? "PR" : "Issue"}</span>
                </a>
              )}
              <dl class="meta">
```

- [ ] **Step 3: Replace the `.gh-kind` style with `.gh-chip` styles**

Remove:

```css
.gh-kind {
  margin-left: 8px;
  padding: 1px 5px;
  border: 1px solid var(--line);
  border-radius: 4px;
  color: var(--muted);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
```

Add, in the same spot:

```css
.gh-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 10px 0 0;
  padding: 6px 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--panel);
  color: var(--fg);
  font: 12px var(--mono);
  text-decoration: none;
}
.gh-chip:hover,
.gh-chip:focus-visible {
  border-color: var(--accent);
  color: var(--accent);
  outline: none;
}
.gh-chip-kind {
  padding: 1px 5px;
  border: 1px solid var(--line);
  border-radius: 4px;
  color: var(--muted);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
```

- [ ] **Step 4: Typecheck + build**

Run: `pnpm --filter @uploads/web typecheck && pnpm --filter @uploads/web build`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/src/pages/f/[workspace]/[...key].astro"
git commit -m "feat(web): Notion-style GitHub chip on the public file page"
```

---

### Task 8: File page — copy, Copy-as, and Download

**Files:**

- Modify: `apps/web/src/lib/public-file.ts`, `apps/web/src/lib/public-file.test.ts` (new `fileDownloadUrl` helper)
- Modify: `apps/web/src/pages/f/[workspace]/[...key].astro`

**Interfaces:**

- Produces: `export function fileDownloadUrl(origin: string, workspace: string, key: string): string` in `public-file.ts` — the absolute URL for the Task 3 download route.
- Consumes: `buildEmbedFormats` (Task 1) with `kind: fileKind(file.contentType)` (file page's own `MediaKind`, which already excludes `"missing"` — a direct match for `EmbedFormatInput["kind"]`).
- No test harness for the `.astro` markup/script itself — verified via typecheck + build here, and end-to-end on a preview worker in Task 10.

- [ ] **Step 1: Write the failing test for `fileDownloadUrl`**

Add to `apps/web/src/lib/public-file.test.ts`, in the `describe("key safety + path building", ...)` block, after the `filePath` test:

```ts
it("builds the absolute download-route URL, encoding each key segment", () => {
  expect(fileDownloadUrl("https://api.uploads.sh", "acme", "f/My Shot#1.png")).toBe(
    "https://api.uploads.sh/public/files/acme/f/My%20Shot%231.png/download",
  );
});
```

Add `fileDownloadUrl` to the test file's import list:

```ts
import {
  applyPublicFileHeaders,
  authRequiredFileCsp,
  fetchPublicFile,
  fileDownloadUrl,
  fileKind,
  filePath,
  formatBytes,
  isPublicFile,
  isSafeKey,
  PUBLIC_FILE_CSP,
} from "./public-file";
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @uploads/web test -- public-file.test.ts`
Expected: FAIL — `fileDownloadUrl` is not exported.

- [ ] **Step 3: Implement `fileDownloadUrl`**

In `apps/web/src/lib/public-file.ts`, add right after `filePath`:

```ts
/** Build the API's forced-download URL (absolute) for a public file — Task 3's `/download` route. */
export function fileDownloadUrl(origin: string, workspace: string, key: string): string {
  return new URL(
    `/public/files/${encodeURIComponent(workspace)}/${encodeKey(key)}/download`,
    origin,
  ).href;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @uploads/web test -- public-file.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire up the page**

In `apps/web/src/pages/f/[workspace]/[...key].astro`, update the frontmatter imports:

```astro
---
import BaseHead from "../../../components/BaseHead.astro";
import Brand from "../../../components/Brand.astro";
import Footer from "../../../components/Footer.astro";
import GitHubMark from "../../../components/GitHubMark.astro";
import { buildEmbedFormats } from "../../../lib/embed-formats";
import {
  applyPublicFileHeaders,
  authRequiredFileCsp,
  fetchPublicFile,
  fileDownloadUrl,
  fileKind as kind,
  filePath,
  formatBytes,
} from "../../../lib/public-file";
import { env } from "cloudflare:workers";
```

After the existing `metadataEntries` computation, add:

```ts
const embedFormats = file
  ? buildEmbedFormats({
      canonical,
      url: file.url,
      embedUrl: file.embedUrl,
      filename,
      kind: kind(file.contentType),
    })
  : [];
const downloadUrl = file ? fileDownloadUrl(origin, workspace, key) : null;
```

Replace the `.actions` block:

```astro
              <div class="actions">
                {kind(file.contentType) !== "unsupported" && <a class="original" href={file.url} rel="noopener noreferrer">Open original ↗</a>}
                {downloadUrl && <a class="original download" href={downloadUrl} rel="noopener noreferrer">Download</a>}
                <span class="linkfield">
                  <label for="copy-format">Copy as</label>
                  <div class="copyrow">
                    <select id="copy-format" aria-label="Copy as format">
                      {embedFormats.map((format) => <option value={format.id}>{format.label}</option>)}
                    </select>
                    <input id="copy-value" type="text" readonly value={embedFormats[0]?.value ?? canonical} aria-label="Value to copy" />
                    <button type="button" id="copy-format-btn" data-copy={embedFormats[0]?.value ?? canonical} aria-live="polite">Copy</button>
                  </div>
                </span>
              </div>
```

Add the copy script right after `</main>`, alongside (not replacing) the existing `auth_required` progressive-enhancement script — same file, two independent conditionals:

```astro
    {file && (
      <script define:vars={{ formats: embedFormats }}>
        (function () {
          const shell = document.querySelector(".shell");
          if (!shell) return;

          // Same data-copy delegated-listener pattern as account/index.astro
          // and account/workspaces.astro.
          shell.addEventListener("click", (event) => {
            void (async () => {
              const button = event.target.closest("button[data-copy]");
              if (!button) return;
              try {
                await navigator.clipboard.writeText(button.dataset.copy || "");
                const previous = button.textContent;
                button.textContent = "copied ✓";
                setTimeout(() => (button.textContent = previous), 1500);
              } catch {
                // Clipboard blocked — leave the label.
              }
            })();
          });

          const select = document.getElementById("copy-format");
          const input = document.getElementById("copy-value");
          const copyButton = document.getElementById("copy-format-btn");
          if (select instanceof HTMLSelectElement && input instanceof HTMLInputElement && copyButton) {
            select.addEventListener("change", () => {
              const format = formats.find((f) => f.id === select.value) ?? formats[0];
              if (!format) return;
              input.value = format.value;
              copyButton.dataset.copy = format.value;
            });
          }
        })();
      </script>
    )}
```

- [ ] **Step 6: Update styles**

Replace the `.linkfield` styles block:

```css
.linkfield {
  flex: 1;
  min-width: 220px;
}
.linkfield label {
  display: block;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font: 11px var(--mono);
  margin-bottom: 5px;
}
.linkfield input {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--bg);
  color: var(--body);
  font: 12px var(--mono);
}
```

with:

```css
.linkfield {
  flex: 1;
  min-width: 260px;
}
.linkfield label {
  display: block;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font: 11px var(--mono);
  margin-bottom: 5px;
}
.copyrow {
  display: flex;
  gap: 6px;
  align-items: stretch;
}
.copyrow select {
  padding: 8px;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--bg);
  color: var(--body);
  font: 12px var(--mono);
}
.copyrow input {
  flex: 1;
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--bg);
  color: var(--body);
  font: 12px var(--mono);
}
.copyrow button {
  padding: 8px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--panel);
  color: var(--fg);
  font: 12px var(--mono);
  cursor: pointer;
}
.copyrow button:hover,
.copyrow button:focus-visible {
  border-color: var(--accent);
  color: var(--accent);
  outline: none;
}
```

(`.actions a.original` already covers the new `.download` link's look — `.download` is an additional class only for potential future differentiation, no new rule needed.)

- [ ] **Step 7: Typecheck + build**

Run: `pnpm --filter @uploads/web typecheck && pnpm --filter @uploads/web build`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/lib/public-file.ts apps/web/src/lib/public-file.test.ts "apps/web/src/pages/f/[workspace]/[...key].astro"
git commit -m "feat(web): click-to-copy, Copy-as, and Download on the public file page"
```

---

### Task 9: Gallery item page — copy, Copy-as, and Download

**Files:**

- Modify: `apps/web/src/lib/public-gallery.ts`, `apps/web/src/lib/public-gallery.test.ts` (new `galleryItemDownloadUrl` helper)
- Modify: `apps/web/src/pages/g/[id]/[item].astro`

**Interfaces:**

- Produces: `export function galleryItemDownloadUrl(origin: string, galleryId: string, itemId: string): string` in `public-gallery.ts`.
- Consumes: `buildEmbedFormats` (Task 1), called only when `item.status === "available"` (guarantees `item.url !== null` per the `isPublicGallery` invariant) with `kind: mediaKind(item) === "missing" ? "file" : mediaKind(item)` narrowed to drop `"missing"` (unreachable in the `available` branch, but keeps the type checker happy without an assertion).
- **No GitHub chip on this page** — per spec §4.5, gallery items carry no per-item GitHub context; the existing `GalleryReferences` block is untouched.

- [ ] **Step 1: Write the failing test for `galleryItemDownloadUrl`**

Add to `apps/web/src/lib/public-gallery.test.ts`, as a new `describe` block:

```ts
describe("galleryItemDownloadUrl", () => {
  it("builds the absolute download-route URL for a gallery item", () => {
    expect(galleryItemDownloadUrl("https://api.uploads.sh", ID, "item-1")).toBe(
      `https://api.uploads.sh/public/galleries/${ID}/items/item-1/download`,
    );
  });
});
```

Add `galleryItemDownloadUrl` to the file's import list:

```ts
import {
  applyPublicGalleryHeaders,
  fetchPublicGallery,
  galleryItemDownloadUrl,
  isPublicGallery,
  PUBLIC_GALLERY_CSP,
} from "./public-gallery";
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @uploads/web test -- public-gallery.test.ts`
Expected: FAIL — `galleryItemDownloadUrl` is not exported.

- [ ] **Step 3: Implement `galleryItemDownloadUrl`**

In `apps/web/src/lib/public-gallery.ts`, add right after `galleryItemPath`:

```ts
/** Build the API's forced-download URL (absolute) for a gallery item — Task 4's `/download` route. */
export function galleryItemDownloadUrl(origin: string, galleryId: string, itemId: string): string {
  return new URL(
    `/public/galleries/${encodeURIComponent(galleryId)}/items/${encodeURIComponent(itemId)}/download`,
    origin,
  ).href;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @uploads/web test -- public-gallery.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire up the page**

In `apps/web/src/pages/g/[id]/[item].astro`, update the frontmatter imports:

```astro
---
import BaseHead from "../../../components/BaseHead.astro";
import GalleryReferences from "../../../components/GalleryReferences.astro";
import Brand from "../../../components/Brand.astro";
import Footer from "../../../components/Footer.astro";
import { buildEmbedFormats, type EmbedFormatOption } from "../../../lib/embed-formats";
import {
  applyPublicGalleryHeaders,
  fetchPublicGallery,
  galleryItemDownloadUrl,
  galleryItemPath,
  galleryPath,
  mediaKind as kind,
  type PublicGalleryItem,
} from "../../../lib/public-gallery";
import { env } from "cloudflare:workers";
```

After the existing `title` computation, add:

```ts
const embedFormats: EmbedFormatOption[] =
  item && item.status === "available" && item.url
    ? buildEmbedFormats({
        canonical,
        url: item.url,
        embedUrl: item.embedUrl,
        filename: item.filename,
        kind: kind(item) === "missing" ? "file" : kind(item),
      })
    : [];
const downloadUrl =
  item && item.status === "available" ? galleryItemDownloadUrl(origin, id, item.id) : null;
```

Replace the `<figcaption>` block:

```astro
            <figcaption class="details" id="item-caption">
              <div class="filename">{item.filename}</div>
              {item.caption && <div class="caption">{item.caption}</div>}
              {item.status === "available" && kind(item) !== "unsupported" && <a class="original" href={item.url!} rel="noopener noreferrer">Open original</a>}
              {item.status === "available" && (
                <div class="actions">
                  {downloadUrl && <a class="original download" href={downloadUrl} rel="noopener noreferrer">Download</a>}
                  <span class="linkfield">
                    <label for="copy-format">Copy as</label>
                    <div class="copyrow">
                      <select id="copy-format" aria-label="Copy as format">
                        {embedFormats.map((format) => <option value={format.id}>{format.label}</option>)}
                      </select>
                      <input id="copy-value" type="text" readonly value={embedFormats[0]?.value ?? canonical} aria-label="Value to copy" />
                      <button type="button" id="copy-format-btn" data-copy={embedFormats[0]?.value ?? canonical} aria-live="polite">Copy</button>
                    </div>
                  </span>
                </div>
              )}
            </figcaption>
```

Add the copy script right before `</body>` (this page has no scripts today, unlike the file page):

```astro
      {item && item.status === "available" && (
        <script define:vars={{ formats: embedFormats }}>
          (function () {
            const shell = document.querySelector(".shell");
            if (!shell) return;

            shell.addEventListener("click", (event) => {
              void (async () => {
                const button = event.target.closest("button[data-copy]");
                if (!button) return;
                try {
                  await navigator.clipboard.writeText(button.dataset.copy || "");
                  const previous = button.textContent;
                  button.textContent = "copied ✓";
                  setTimeout(() => (button.textContent = previous), 1500);
                } catch {
                  // Clipboard blocked — leave the label.
                }
              })();
            });

            const select = document.getElementById("copy-format");
            const input = document.getElementById("copy-value");
            const copyButton = document.getElementById("copy-format-btn");
            if (select instanceof HTMLSelectElement && input instanceof HTMLInputElement && copyButton) {
              select.addEventListener("change", () => {
                const format = formats.find((f) => f.id === select.value) ?? formats[0];
                if (!format) return;
                input.value = format.value;
                copyButton.dataset.copy = format.value;
              });
            }
          })();
        </script>
      )}
    </main>
  </body>
</html>
```

(The `</main>` / `</body>` / `</html>` closing tags already exist at the end of the file — this step wraps the new conditional script around them; make sure the file ends with exactly one copy of each closing tag after the edit.)

- [ ] **Step 6: Add styles**

Add to the `<style>` block (this page currently has no `.actions`/`.linkfield`/`.copyrow` rules — copy the same block Task 8 added to the file page, right after the existing `.original:hover, .original:focus-visible` rule):

```css
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  margin-top: 14px;
}
.actions a.original {
  display: inline-block;
  padding: 9px 15px;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--panel);
  color: var(--fg);
  font: 12px var(--mono);
  text-decoration: none;
  margin-top: 0;
}
.actions a.original:hover,
.actions a.original:focus-visible {
  border-color: var(--accent);
  color: var(--accent);
  outline: none;
}
.linkfield {
  flex: 1;
  min-width: 260px;
}
.linkfield label {
  display: block;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font: 11px var(--mono);
  margin-bottom: 5px;
}
.copyrow {
  display: flex;
  gap: 6px;
  align-items: stretch;
}
.copyrow select {
  padding: 8px;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--bg);
  color: var(--body);
  font: 12px var(--mono);
}
.copyrow input {
  flex: 1;
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--bg);
  color: var(--body);
  font: 12px var(--mono);
}
.copyrow button {
  padding: 8px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--panel);
  color: var(--fg);
  font: 12px var(--mono);
  cursor: pointer;
}
.copyrow button:hover,
.copyrow button:focus-visible {
  border-color: var(--accent);
  color: var(--accent);
  outline: none;
}
```

(The pre-existing `.original` rule at the top of the block, used by the standalone "Open original" link outside `.actions`, is untouched — `.actions a.original` above is scoped narrowly enough not to conflict.)

- [ ] **Step 7: Typecheck + build**

Run: `pnpm --filter @uploads/web typecheck && pnpm --filter @uploads/web build`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/lib/public-gallery.ts apps/web/src/lib/public-gallery.test.ts "apps/web/src/pages/g/[id]/[item].astro"
git commit -m "feat(web): click-to-copy, Copy-as, and Download on the gallery item page"
```

---

### Task 10: Preview-worker verification (routing + visual)

**Files:** none (verification only — no code changes).

The #158 lesson: vitest exercises the Hono app directly, not the deployed router. Every new route added in Tasks 3, 4, 8, and 9 needs a pass through a real preview worker before this feature is considered done.

- [ ] **Step 1: Start the dev stack**

Use this repo's existing dev-server launch config (per `docs/superpowers/plans/2026-07-14-metadata-search-ui.md`'s Task 5 Step 5 precedent and the `uploads dev-server-gotchas` project notes) to bring up both `apps/api` and `apps/web` against a real Worker runtime, not just `vitest`.

- [ ] **Step 2: Verify the file download route**

Upload or pick an existing public file whose key contains a `/` and an extension (e.g. `screenshots/shot.png`). Confirm:

- `GET /public/files/<workspace>/<key>` still returns 200 JSON with `embedUrl` present (Task 2).
- `GET /public/files/<workspace>/<key>/download` returns 200, **not 404** — this is the routing check (the #158 hazard from Global Constraints) — with `Content-Disposition: attachment` and the browser actually offers a save dialog / lands the file in Downloads, not a new tab.
- A key path that ends with a segment literally named the same as an existing file also still resolves through the plain metadata route (spot-check, not just the vitest regression from Task 3).

- [ ] **Step 3: Verify the gallery-item download route**

Pick a gallery with at least one item. Confirm `GET /public/galleries/<id>/items/<item>/download` returns 200 with the right `Content-Disposition` and actually downloads (not a routing 404, and not an "Open original" redirect).

- [ ] **Step 4: Visual check — file page**

Load `/f/<workspace>/<key>` for:

- One image file with a `gh.*`-derived GitHub attachment: confirm the chip renders with the GitHub glyph, links out to the correct PR/issue URL, and reads `{repo}#{number}` + `PR`/`Issue`.
- One file without GitHub metadata: confirm no chip renders and nothing else shifts oddly.
- Confirm: the Copy button copies the "Page link" value by default and shows "copied ✓"; switching "Copy as" to each option updates both the readonly input and what gets copied; "Markdown image"/"HTML `<img>`" only appear for the image file, not for a PDF/video test file; "Download" triggers a save, "Open original ↗" still opens inline as before.

- [ ] **Step 5: Visual check — gallery item page**

Load `/g/<id>/<item>` for an available item: confirm the same copy/Copy-as/Download behavior, confirm there is **no** GitHub chip anywhere on this page, and confirm the gallery-level "Connected work items" (`GalleryReferences`) block still renders unchanged below the pager.

- [ ] **Step 6: Confirm no horizontal scroll at the narrow breakpoint**

Resize to ≤760px (or use the browser's preview device toolbar) on both pages and confirm the `.actions` row wraps (chip / Open original / Download / Copy-as all stack) without introducing horizontal scroll — the shell has none today (design spec §5).

- [ ] **Step 7: Report**

No commit for this task (verification only). Summarize pass/fail for each check above in the PR description; attach a screenshot of the file page's chip + Copy-as control per the `github-screenshots` skill if a review would benefit from seeing it (optional, at PR-creation time, not part of this plan's task list).

---

## Self-Review

**Spec coverage:**

- (a) Static GitHub chip, file page only, moved out of `dl.meta` into its own row → Task 7. ✓
- (b) Server-side download routes (file + gallery item), streamed, shared helper, plain `<a>` no JS → Tasks 3, 4, 8, 9. ✓
- (c) Five-format "Copy as" control, `embedUrl ?? url` for snippets / stable `url` for Direct file URL, `embedUrl` surfaced on both public payloads → Tasks 1, 2, 5, 8, 9. ✓ (Gallery-side API field was already shipped by #154 — confirmed rather than re-implemented; see Global Constraints discovery note.)
- (d) CSP `script-src` widened to the exact agreed value on both `PUBLIC_FILE_CSP` and `PUBLIC_GALLERY_CSP` → Task 6. ✓
- Click-to-copy reuses the `data-copy` delegated-listener pattern from `account/index.astro`/`workspaces.astro` → Tasks 8, 9 (same listener body, same `copied ✓` swap, same `aria-live="polite"`). ✓
- §4.5 gallery scope: copy/embed/download apply to the item page; no per-item GitHub chip; `GalleryReferences` untouched → Tasks 4, 5, 9 explicitly skip the chip. ✓
- §5 accessibility/responsive notes: real `<a>` for the chip (not a button), visible `PR`/`Issue` text (not `::before`), `aria-live="polite"` copy buttons, native `<select>` for the format picker (lower-risk than a segmented-button `radiogroup`), Download uses a distinct verb with no reused ↗ glyph, wrap-without-scroll verified in Task 10 Step 6 → all addressed. ✓
- §6 testing approach: unit tests for every new pure helper (embed-format builder, CSP constants, `isPublicFile`/`isPublicGallery`, download-URL builders), API route tests for both download routes (200/401/404 + the #158 routing regression), preview-worker verification as its own task, no fabricated `.astro` render tests → Tasks 1–9 + Task 10. ✓
- §7 out-of-scope items (live unfurl, auth route changes beyond the additive field, media-stage redesign, `@uploads/ui` extraction, signed/expiring downloads, range support, per-item GitHub, gallery-index page changes) — none implemented; gallery-index page only passively inherits the widened CSP constant, called out explicitly in Global Constraints and Task 6, not a functional change. ✓

**Placeholder scan:** No TBD/TODO in any step. Every code block is complete, copy-pasteable code — no "add error handling here" stubs. Task 9's closing-tag note (Step 5) is a structural instruction, not a placeholder — it tells the implementer exactly which existing tags the new block wraps.

**Type consistency:** `EmbedFormatInput`/`EmbedFormatOption` defined once in Task 1, consumed with identical shape by Task 8 (file page, `fileKind()`'s `MediaKind` matches `EmbedFormatInput["kind"]` exactly) and Task 9 (gallery page, `mediaKind()`'s `MediaKind` narrowed to drop the unreachable `"missing"` case in the `available` branch). `downloadResponse(store, key, filename)` defined once in Task 3 (`files-core.ts`), consumed unchanged by Task 4's gallery route. `fileDownloadUrl`/`galleryItemDownloadUrl` follow the same `(origin, ...ids) => absolute URL` shape as the existing `filePath`/`galleryItemPath` siblings they sit next to. `PublicFile.embedUrl`/`PublicGalleryItem.embedUrl` are both `string | null`, required (not optional), matching the already-shipped `PublicGalleryItemDto.embedUrl` convention in `apps/api/src/gallery-service.ts`.

**Judgment calls made while grounding this plan (flagged for the human, not buried in the diff):**

1. **Gallery-side `embedUrl` API work is already done (PR #154).** The design spec's §4.5 claims it's "simply dropped before reaching the web," but `apps/api/src/gallery-service.ts`'s `hydratePublicGallery`/`PublicGalleryItemDto` already return it, and `apps/api/test/routes-galleries.test.ts` (~line 464) already asserts it in the public payload's field list. Task 5 is scoped as a web-only type/validator change for the gallery half; only the file-page half (Task 2) is genuinely new API work. Flagged prominently in Global Constraints so nobody re-does already-shipped work.
2. **§3.2 and §3.3 merged into one control, not two.** The design doc's §3.2 mockup (readonly input + copy button, page-link only) and §3.3's "single Copy-as control" (select + one button, five formats including Page link) read as two separate proposals but describe overlapping UI. This plan implements the design's final, more specific §3.3 shape as the _only_ copy control (one `<select>` + one readonly `<input>` that mirrors the selected format's value + one `<button data-copy>`), with "Page link" as format `id: "page"`, the first/default option — rather than shipping both a separate page-link-only copy button _and_ a Copy-as selector, which would be redundant. Worth a design sign-off glance before implementation if this reading is wrong.
3. **Download link renders unconditionally**, including for `kind === "unsupported"` (SVG) files/items, where "Open original ↗" is deliberately hidden. This isn't explicitly stated either way in the spec, but it's the safer reading: forced `Content-Disposition: attachment` sidesteps the inline-render XSS concern that motivates hiding "Open original" for SVG in the first place, so there's no reason to also hide Download there.
4. **`embedUrl` is a required (non-optional) field on both `PublicFile` and `PublicGalleryItem`**, not `embedUrl?:`. This matches the already-shipped `PublicGalleryItemDto` convention and keeps `isPublicFile`/`isPublicGallery` strict, but it does mean any hand-built fixture object missing the field now fails validation — confirmed via grep that the only other places constructing these types are the two `.astro` pages (updated in this plan) and one unrelated same-named function (`openPublicFile` in `AccountFileBrowser.tsx`, not the type).
5. **Copy script container selector is `.shell`** (the page's top-level wrapper) rather than a narrower ID, since neither `.astro` page currently has a dedicated container id around just the actions row. Functionally equivalent to the account pages' pattern (delegated listener on an ancestor), just a broader ancestor.
