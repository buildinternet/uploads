# Managed-comment attachment file-page linking — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the `uploads-sh[bot]` managed attachments comment, make every attachment (image or non-image) link to its `/f/<workspace>/<key>` file page instead of raw Camo-proxied bytes.

**Architecture:** The API computes a canonical file-page URL and returns it on the object-listing DTO (mirroring `GalleryItem.pageUrl`). Both comment renderers (the API bot-path copy and the CLI `gh`-path copy) prefer that `pageUrl` for the click-through `href`, falling back to the raw `url` when absent. Only the `href` changes; `<img src>` stays on the raw/embed host (GitHub's Camo proxy needs it).

**Tech Stack:** TypeScript, Cloudflare Workers (Hono), Vitest, pnpm workspace. Renderer is duplicated in `apps/api` (server) and `packages/uploads` (published CLI) and kept byte-identical by a shared golden fixture.

## Global Constraints

- **Two renderer copies stay byte-identical.** `apps/api/src/github-comment-render.ts` and `packages/uploads/src/github.ts` must produce identical output; the shared fixture `test/fixtures/github-comment-golden.json` is asserted from both sides. Change both copies together.
- **`<img src>` never changes.** It stays `embedUrl ?? url` (raw/embed host). Only the click-through `href` gains the `pageUrl` preference.
- **Clients must not synthesize URLs.** The file-page URL is computed server-side and returned on the DTO; the CLI only passes it through. (Convention from `client.ts:136`, `github.ts:122`.)
- **Graceful degradation:** when `pageUrl` is absent (older API), the renderer falls back to the raw `url` — byte-for-byte today's output.
- **Web origin base:** `env.WEB_ORIGIN` (value `"https://uploads.sh"`), trailing-slash-trimmed, same as `galleryUrl`.
- **File-page path shape:** `/f/<workspace>/<key>`, each path segment `encodeURIComponent`-encoded (mirror `apps/web/src/lib/public-file.ts` `filePath`).
- **Run a single test file:** `pnpm test <path-or-filename-substring>` (forwards to `vitest run --config vitest.projects.ts`). Full suite: `pnpm test`.
- **Formatter is oxfmt** (runs on commit via lint-staged) — don't hand-fight formatting.

---

### Task 1: Renderer — prefer `pageUrl` for the click-through (both copies + golden)

Self-contained and pure. Do this first; later tasks only feed the new field.

**Files:**

- Modify: `apps/api/src/github-comment-render.ts` (AttachmentItem interface ~line 55; image/non-image render ~lines 145-158)
- Modify: `packages/uploads/src/github.ts` (AttachmentItem interface ~line 112; image/non-image render ~lines 191-208)
- Modify: `test/fixtures/github-comment-golden.json`
- Test: `packages/uploads/test/github.test.ts`
- Test (parity, unchanged assertions): `apps/api/src/github-comment-render.test.ts`, `packages/uploads/test/github-render-golden.test.ts`

**Interfaces:**

- Produces: `AttachmentItem` gains `pageUrl?: string | null` in both copies. Renderer href precedence — images: `pageUrl ?? stable ?? src`; non-image bullets: `pageUrl ?? stable`. Consumed by Tasks 3 (bot path) and 4 (CLI path).

- [ ] **Step 1: Write the failing renderer tests**

Append to `packages/uploads/test/github.test.ts` inside the `describe("attachmentsCommentBody", …)` block:

```ts
it("links an image to its pageUrl (not raw url) when present", () => {
  const body = attachmentsCommentBody([
    {
      key: "gh/o/r/pull/1/after.png",
      url: "https://x.test/after.png",
      embedUrl: "https://embed.test/after.png",
      pageUrl: "https://uploads.sh/f/ws/gh/o/r/pull/1/after.png",
    },
  ]);
  expect(body).toContain(
    '<a href="https://uploads.sh/f/ws/gh/o/r/pull/1/after.png"><img width="400" alt="after.png" src="https://embed.test/after.png"></a>',
  );
});

it("links a non-image attachment to its pageUrl when present", () => {
  const body = attachmentsCommentBody([
    {
      key: "gh/o/r/pull/1/demo.mp4",
      url: "https://x.test/demo.mp4",
      pageUrl: "https://uploads.sh/f/ws/gh/o/r/pull/1/demo.mp4",
    },
  ]);
  expect(body).toContain("- [demo.mp4](https://uploads.sh/f/ws/gh/o/r/pull/1/demo.mp4)");
});

it("falls back to the raw url for the href when pageUrl is absent", () => {
  const body = attachmentsCommentBody([
    { key: "gh/o/r/pull/1/after.png", url: "https://x.test/after.png" },
  ]);
  expect(body).toContain('<a href="https://x.test/after.png"><img');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test packages/uploads/test/github.test.ts`
Expected: the two `pageUrl` tests FAIL (href is the raw url, not the page url); the fallback test passes already. TypeScript may also error that `pageUrl` is not on `AttachmentItem` — expected.

- [ ] **Step 3: Add `pageUrl` to both `AttachmentItem` interfaces**

In `packages/uploads/src/github.ts`, change the interface (currently ends at `embedUrl?`):

```ts
export interface AttachmentItem {
  key: string;
  url: string | null;
  /** Prefer for `<img src>` on GitHub (Camo-friendly host). Falls back to `url`. */
  embedUrl?: string | null;
  /** Canonical `/f/` file-page URL (server-computed). Preferred click-through target; falls back to `url`. */
  pageUrl?: string | null;
}
```

Apply the identical addition to `apps/api/src/github-comment-render.ts`'s `AttachmentItem`.

- [ ] **Step 4: Change the href precedence in both renderer copies**

In `packages/uploads/src/github.ts`, in the `for (const item of sorted)` loop, replace the image + non-image branches:

```ts
for (const item of sorted) {
  const name = item.key.slice(item.key.lastIndexOf("/") + 1);
  const stable = item.url;
  const src = item.embedUrl ?? item.url;
  const link = item.pageUrl ?? stable; // click-through: file page when known, else raw
  if (src && inferContentType(name).startsWith("image/")) {
    // Markdown ![]() has no width control — phone frames become full-column giants.
    // img src uses embed host when available (Camo revalidates); click-through prefers the file page.
    const w = attachmentImageWidth(name);
    const alt = escapeHtmlAttr(name);
    const href = escapeHtmlAttr(link ?? src);
    const imgSrc = escapeHtmlAttr(src);
    lines.push(`<a href="${href}"><img width="${w}" alt="${alt}" src="${imgSrc}"></a>`);
    lines.push("");
  } else if (link) {
    lines.push(`- [${name}](${link})`);
  } else {
    lines.push(`- ${name}`);
  }
}
```

Apply the identical change to `apps/api/src/github-comment-render.ts` (same loop body).

- [ ] **Step 5: Run the renderer tests to verify they pass**

Run: `pnpm test packages/uploads/test/github.test.ts`
Expected: PASS (all, including the three new cases).

- [ ] **Step 6: Update the golden fixture and confirm parity**

Edit `test/fixtures/github-comment-golden.json`. Add `pageUrl` to both items and update `expected` so the two attachment hrefs use the page URLs:

- Add to the `hero.png` item: `"pageUrl": "https://uploads.sh/f/acme/gh/acme/web/pull/12/hero.png"`
- Add to the `build.log` item: `"pageUrl": "https://uploads.sh/f/acme/gh/acme/web/pull/12/build.log"`
- In `expected`, change the attachments section from:
  - `- [build.log](https://uploads.sh/f/build.log)` → `- [build.log](https://uploads.sh/f/acme/gh/acme/web/pull/12/build.log)`
  - `<a href="https://uploads.sh/f/hero.png"><img width="400" alt="hero.png" src="https://embed.uploads.sh/f/hero.png"></a>` → `<a href="https://uploads.sh/f/acme/gh/acme/web/pull/12/hero.png"><img width="400" alt="hero.png" src="https://embed.uploads.sh/f/hero.png"></a>`

Leave the galleries section of `expected` unchanged (gallery previews already use `itemUrl`).

- [ ] **Step 7: Run both golden parity tests**

Run: `pnpm test github-render-golden` then `pnpm test github-comment-render`
Expected: both PASS (CLI copy and API copy each reproduce the updated `expected` byte-for-byte).

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/github-comment-render.ts packages/uploads/src/github.ts \
  test/fixtures/github-comment-golden.json packages/uploads/test/github.test.ts
git commit -m "feat(github): link managed-comment attachments to the file page when known"
```

---

### Task 2: API — `filePageUrl` helper

**Files:**

- Modify: `apps/api/src/files-core.ts` (add exported helper; `objectPublicUrls`/`Env` already in scope)
- Test: `apps/api/test/files-core-file-page-url.test.ts` (create)

**Interfaces:**

- Produces: `filePageUrl(env: Env, workspace: string, key: string): string` → `${WEB_ORIGIN}/f/<workspace>/<key>`, each segment `encodeURIComponent`-encoded, trailing slash trimmed off the origin. Consumed by Task 3.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/files-core-file-page-url.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { filePageUrl } from "../src/files-core";

// `Env` is a global ambient type (apps/api/src/env.d.ts) — no import needed.
const env = { WEB_ORIGIN: "https://uploads.sh" } as unknown as Env;

describe("filePageUrl", () => {
  it("builds /f/<workspace>/<key> against WEB_ORIGIN", () => {
    expect(filePageUrl(env, "acme", "gh/acme/web/pull/12/hero.png")).toBe(
      "https://uploads.sh/f/acme/gh/acme/web/pull/12/hero.png",
    );
  });

  it("encodes each path segment but keeps slashes between them", () => {
    expect(filePageUrl(env, "acme", "gh/o/r/pull/1/a b.png")).toBe(
      "https://uploads.sh/f/acme/gh/o/r/pull/1/a%20b.png",
    );
  });

  it("trims a trailing slash on WEB_ORIGIN", () => {
    const slashy = { WEB_ORIGIN: "https://uploads.sh/" } as unknown as Env;
    expect(filePageUrl(slashy, "acme", "x.png")).toBe("https://uploads.sh/f/acme/x.png");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test files-core-file-page-url`
Expected: FAIL — `filePageUrl` is not exported / not a function.

- [ ] **Step 3: Implement the helper**

In `apps/api/src/files-core.ts`, add near `listObjects` (after the `ListedObject` interface):

```ts
/**
 * Canonical public file-page URL (`/f/<workspace>/<key>`) for an object, built
 * against `WEB_ORIGIN` — the metadata-rich page apps/web serves (issues
 * #135/#139). Sibling to `galleryUrl`. Callers must not synthesize this;
 * the API returns it on the listing DTO.
 */
export function filePageUrl(env: Env, workspace: string, key: string): string {
  const origin = env.WEB_ORIGIN.endsWith("/") ? env.WEB_ORIGIN.slice(0, -1) : env.WEB_ORIGIN;
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  return `${origin}/f/${encodeURIComponent(workspace)}/${encodedKey}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test files-core-file-page-url`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/files-core.ts apps/api/test/files-core-file-page-url.test.ts
git commit -m "feat(api): add filePageUrl helper for the public /f/ page"
```

---

### Task 3: API — emit `pageUrl` from `listObjects` and thread the workspace name

**Files:**

- Modify: `apps/api/src/files-core.ts` (`ListedObject` interface ~line 405; `listObjects` opts + mapping ~lines 424-455)
- Modify: `apps/api/src/routes/files.ts` (list route ~line 196 — pass `workspaceName`)
- Modify: `apps/api/src/github-comment.ts` (`gatherAttachments` ~line 54 + its caller `gatherCommentBody` ~line 44)
- Test: `apps/api/test/list-page-url.test.ts` (create)

**Interfaces:**

- Consumes: `filePageUrl` (Task 2); `AttachmentItem.pageUrl` (Task 1).
- Produces: `ListedObject` gains `pageUrl?: string`; `listObjects` opts gains `workspaceName?: string`. When both a public `url` and `workspaceName` are present, each listed item carries `pageUrl`. The list HTTP route returns it verbatim (feeds the CLI's `ListItem` in Task 4).

- [ ] **Step 1: Write the failing integration test**

Create `apps/api/test/list-page-url.test.ts` (mirrors the FakeR2 harness in `routes-files-usage-resilience.test.ts`):

```ts
import { describe, expect, it } from "vitest";
import { FakeR2Bucket } from "./fake-r2";
import { listObjects } from "../src/files-core";
import type { WorkspaceRecord } from "../src/workspace";

// `Env` is a global ambient type (apps/api/src/env.d.ts) — no import needed.
function makeEnv(bucket: FakeR2Bucket) {
  return { UPLOADS_DEFAULT: bucket, WEB_ORIGIN: "https://uploads.sh" } as unknown as Env;
}

const record: WorkspaceRecord = {
  provider: "r2",
  bucket: "uploads-default",
  binding: "UPLOADS_DEFAULT",
  prefix: "default/",
  publicBaseUrl: "https://storage.uploads.sh",
};

describe("listObjects pageUrl", () => {
  it("emits a /f/ pageUrl for public-url objects when workspaceName is given", async () => {
    const bucket = new FakeR2Bucket();
    await bucket.put("default/gh/o/r/pull/1/a.png", new Uint8Array([1, 2, 3]));
    const env = makeEnv(bucket);
    const { items } = await listObjects(env, record, {
      prefix: "gh/o/r/pull/1/",
      workspaceName: "acme",
    });
    expect(items[0].pageUrl).toBe("https://uploads.sh/f/acme/gh/o/r/pull/1/a.png");
  });

  it("omits pageUrl when workspaceName is not provided", async () => {
    const bucket = new FakeR2Bucket();
    await bucket.put("default/gh/o/r/pull/1/a.png", new Uint8Array([1, 2, 3]));
    const { items } = await listObjects(makeEnv(bucket), record, { prefix: "gh/o/r/pull/1/" });
    expect(items[0].pageUrl).toBeUndefined();
  });
});
```

> If `FakeR2Bucket`'s constructor/`put` signature differs from the above (check `apps/api/test/fake-r2.ts`), match its actual API — the assertions on `pageUrl` are the point, not the fixture mechanics. The `prefix` on the record means keys are stored under `default/`; pass the caller-visible prefix (`gh/o/r/pull/1/`) to `listObjects`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test list-page-url`
Expected: FAIL — `pageUrl` is `undefined` in the first case (not yet computed) and/or `workspaceName` is not an accepted option (TS error).

- [ ] **Step 3: Add `pageUrl` to `ListedObject` and populate it in `listObjects`**

In `apps/api/src/files-core.ts`, add to the `ListedObject` interface:

```ts
  /** Canonical public `/f/` page URL (issue #135). Present only when `url` is set and the caller passed `workspaceName`. */
  pageUrl?: string;
```

Extend the `listObjects` opts type and the item mapping:

```ts
export async function listObjects(
  env: Env,
  ws: WorkspaceRecord,
  opts: {
    prefix?: string;
    delimiter?: string;
    limit?: number;
    cursor?: string;
    workspaceName?: string;
  } = {},
): Promise<{ items: ListedObject[]; cursor: string | null; prefixes?: string[] }> {
```

Inside the `result.items.map(...)` callback, after computing `urls`, add the `pageUrl` when possible:

```ts
return {
  key: item.key,
  url: urls.url,
  embedUrl: urls.embedUrl,
  ...storedMetaJson(item),
  ...(visibility ? { visibility } : {}),
  ...(urls.url && opts.workspaceName
    ? { pageUrl: filePageUrl(env, opts.workspaceName, item.key) }
    : {}),
};
```

- [ ] **Step 4: Pass `workspaceName` from the list HTTP route**

In `apps/api/src/routes/files.ts`, at the list handler (currently `listObjects(c.env, c.get("workspace"), { prefix, limit, cursor })`):

```ts
return c.json(
  await listObjects(c.env, c.get("workspace"), {
    prefix,
    limit,
    cursor,
    workspaceName: c.get("workspaceName"),
  }),
);
```

- [ ] **Step 5: Thread `workspaceName` through the bot path and map `pageUrl`**

In `apps/api/src/github-comment.ts`:

Change `gatherAttachments` to accept and use the name:

```ts
async function gatherAttachments(
  env: Env,
  ws: WorkspaceRecord,
  workspaceName: string,
  target: GhTarget,
): Promise<AttachmentItem[]> {
  const items: AttachmentItem[] = [];
  let cursor: string | undefined;
  do {
    const page = await listObjects(env, ws, {
      prefix: ghKeyPrefix(target),
      limit: 1000,
      cursor,
      workspaceName,
    });
    for (const o of page.items)
      items.push({ key: o.key, url: o.url, embedUrl: o.embedUrl, pageUrl: o.pageUrl });
    cursor = page.cursor ?? undefined;
  } while (cursor);
  return items;
}
```

Update its call in `gatherCommentBody` (which already has `workspaceName` in scope):

```ts
const [items, galleries] = await Promise.all([
  gatherAttachments(env, ws, workspaceName, target),
  gatherGalleries(env, ws, workspaceName, target),
]);
```

- [ ] **Step 6: Run the integration test to verify it passes**

Run: `pnpm test list-page-url`
Expected: PASS (both cases).

- [ ] **Step 7: Run the API package tests + types**

Run: `pnpm test github-comment` then `pnpm --filter @uploads/api types`
Expected: PASS / no type errors (the golden parity test still passes because the fixture change in Task 1 is independent of this wiring).

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/files-core.ts apps/api/src/routes/files.ts \
  apps/api/src/github-comment.ts apps/api/test/list-page-url.test.ts
git commit -m "feat(api): emit /f/ pageUrl on object listings and the bot comment path"
```

---

### Task 4: CLI — carry `pageUrl` through the client and `gh` fallback path

**Files:**

- Modify: `packages/uploads/src/client.ts` (`ListItem` interface ~line 96)
- Modify: `packages/uploads/src/commands.ts` (gh-path item mapping ~line 468)
- Test: `packages/uploads/test/commands-page-url.test.ts` (create)

**Interfaces:**

- Consumes: server-provided `pageUrl` on the list response; `AttachmentItem.pageUrl` (Task 1).
- Produces: CLI `gh` fallback comment links attachments to `pageUrl` when the API returns it. `client.list()` already spreads `...item`, so `pageUrl` passes through once typed.

- [ ] **Step 1: Write the failing test**

Create `packages/uploads/test/commands-page-url.test.ts`. This asserts the mapping keeps `pageUrl` by exercising the exact transform used in `commands.ts` against a typed `ListItem`:

```ts
import { describe, expect, it } from "vitest";
import type { ListItem } from "../src/client.js";
import { attachmentsCommentBody, type AttachmentItem } from "../src/github.js";

// Mirrors the gh-path projection in commands.ts: list items -> AttachmentItem.
function toAttachmentItems(items: ListItem[]): AttachmentItem[] {
  return items.map(({ key, url, embedUrl, pageUrl }) => ({ key, url, embedUrl, pageUrl }));
}

describe("gh-path attachment mapping", () => {
  it("carries pageUrl from the list item into the rendered href", () => {
    const items: ListItem[] = [
      {
        key: "gh/o/r/pull/1/a.png",
        url: "https://x.test/a.png",
        embedUrl: "https://embed.test/a.png",
        pageUrl: "https://uploads.sh/f/ws/gh/o/r/pull/1/a.png",
      },
    ];
    const body = attachmentsCommentBody(toAttachmentItems(items));
    expect(body).toContain('href="https://uploads.sh/f/ws/gh/o/r/pull/1/a.png"');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test commands-page-url`
Expected: FAIL — `pageUrl` is not a property of `ListItem` (TS error), so `toAttachmentItems` can't read it.

- [ ] **Step 3: Add `pageUrl` to the client `ListItem`**

In `packages/uploads/src/client.ts`:

```ts
export interface ListItem {
  key: string;
  url: string | null;
  embedUrl?: string | null;
  /** Canonical `/f/` page URL when the API provides it. Absent on older API deployments. */
  pageUrl?: string;
  size?: number;
  uploaded?: string;
}
```

- [ ] **Step 4: Map `pageUrl` in the `gh` fallback path**

In `packages/uploads/src/commands.ts`, update the items projection (currently `.map(({ key, url, embedUrl }) => ({ key, url, embedUrl }))`):

```ts
const items: AttachmentItem[] = (await client.listAll({ prefix: ghKeyPrefix(target) })).map(
  ({ key, url, embedUrl, pageUrl }) => ({ key, url, embedUrl, pageUrl }),
);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test commands-page-url`
Expected: PASS.

- [ ] **Step 6: Run the uploads package tests + full type check**

Run: `pnpm test packages/uploads` then `pnpm -r typecheck`
Expected: PASS / no type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/uploads/src/client.ts packages/uploads/src/commands.ts \
  packages/uploads/test/commands-page-url.test.ts
git commit -m "feat(cli): carry /f/ pageUrl through the gh-fallback attachments comment"
```

---

### Final verification

- [ ] **Full suite + types**

Run: `pnpm test` then `pnpm run types`
Expected: all projects green; no type errors.

- [ ] **Changeset** (required for the CLI to publish — see the release-changeset note; a change touching `packages/uploads` must include one)

Add a changeset describing the user-facing change (attachments in the managed comment now link to the file page). Use the repo's changeset workflow (`pnpm changeset`), scoping the bump to the affected published package(s).

- [ ] **Commit the changeset**

```bash
git add .changeset
git commit -m "chore: changeset for managed-comment file-page linking"
```
