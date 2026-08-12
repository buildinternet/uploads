# Changelog Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A prerendered `/changelog` page + `/changelog.xml` Atom feed on uploads.sh merging hand-written platform updates (Astro content collection) with CLI releases parsed from `packages/uploads/CHANGELOG.md`, declared canonical in `.well-known/releases.json` for releases.sh ingestion.

**Architecture:** A build-time data module (`apps/web/src/lib/changelog.ts`) parses the changesets CHANGELOG, fetches per-version publish dates from the npm registry `time` map, and merges with content-collection entries into one sorted list consumed by both the page and the feed. Everything is prerendered; zero client JS.

**Tech Stack:** Astro 7 (content layer + prerendered endpoint), zod (via `astro:content`), `marked` (new dep, build-time markdown→HTML), vitest (colocated `src/**/*.test.ts`).

**Spec:** `docs/superpowers/specs/2026-08-12-changelog-page-design.md`

## Global Constraints

- Public pages ship **zero framework/client JS**; `/changelog` and `/changelog.xml` are prerendered (no `prerender = false`).
- `trailingSlash: "never"`, `build.format: "file"` — page file is `src/pages/changelog.astro`, endpoint is `src/pages/changelog.xml.ts`.
- All image URLs in entries must be absolute `https://` (releases.sh mirrors 1 KB–8 MB png/jpeg/gif/webp/avif only).
- Build must **fail loudly** if: the npm `time` fetch fails, the CHANGELOG parse yields zero versions, or frontmatter validation fails.
- No `:root` tokens or `@font-face` in pages — BaseHead imports `@uploads/ui/styles.css`; use existing tokens (`--bg --fg --body --muted --line --panel --accent --sans --mono --width-content`).
- apps/web is in the changesets `ignore` list — **no changeset file needed** for this work.
- Husky pre-commit runs oxfmt on staged files; commit output may show reformatting — that's normal.
- Run web tests with `pnpm --filter @uploads/web test`; typecheck with `pnpm --filter @uploads/web typecheck`.

---

### Task 1: Changelog data module (parser, dates, merge)

**Files:**

- Create: `apps/web/src/lib/changelog.ts`
- Test: `apps/web/src/lib/changelog.test.ts`
- Modify: `apps/web/package.json` (add `marked` dependency)

**Interfaces:**

- Produces (later tasks import these from `../lib/changelog` / `./changelog`):

```ts
export type ChangelogImage = { url: string; alt: string };

export type ChangelogEntry = {
  kind: "platform" | "cli";
  /** Stable anchor id, e.g. "screenshots-page" or "cli-0-41-1" */
  id: string;
  title: string;
  /** ISO 8601 UTC timestamp */
  date: string;
  /** Rendered HTML body (marked output) */
  html: string;
  tags: string[];
  image?: ChangelogImage;
};

export function parseCliChangelog(md: string): { version: string; body: string }[];
export function cliAnchorId(version: string): string; // "0.41.1" -> "cli-0-41-1"
export function fetchCliReleaseDates(fetchImpl?: typeof fetch): Promise<Record<string, string>>;
export function renderMarkdown(md: string): string; // marked, async: false
export function mergeEntries(entries: ChangelogEntry[]): ChangelogEntry[]; // newest-first, date desc then kind (platform before cli on same date)
export function loadChangelogEntries(): Promise<ChangelogEntry[]>; // page/feed entry point
```

- [ ] **Step 1: Add the `marked` dependency**

```bash
pnpm --filter @uploads/web add marked
```

Expected: lockfile updates cleanly (supply-chain policy check runs on install).

- [ ] **Step 2: Write the failing tests**

Create `apps/web/src/lib/changelog.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ChangelogEntry,
  cliAnchorId,
  fetchCliReleaseDates,
  mergeEntries,
  parseCliChangelog,
  renderMarkdown,
} from "./changelog";

const SAMPLE = `# @buildinternet/uploads

## 0.41.1

### Patch Changes

- 2697e69: Fix \`uploads completion zsh\` producing a script that could not complete anything.

  The generated \`_arguments\` call was missing line continuations.

## 0.41.0

### Minor Changes

- 085da59: Per-key file operations now use the canonical paths (#613).
`;

describe("parseCliChangelog", () => {
  it("splits ## <version> sections newest-first with bodies intact", () => {
    const sections = parseCliChangelog(SAMPLE);
    expect(sections.map((s) => s.version)).toEqual(["0.41.1", "0.41.0"]);
    expect(sections[0].body).toContain("### Patch Changes");
    expect(sections[0].body).toContain("line continuations");
    expect(sections[0].body).not.toContain("## 0.41.0");
  });

  it("throws when no version sections are found", () => {
    expect(() => parseCliChangelog("# nothing here")).toThrow(/no version sections/i);
  });
});

describe("cliAnchorId", () => {
  it("dasherizes the version", () => {
    expect(cliAnchorId("0.41.1")).toBe("cli-0-41-1");
  });
});

describe("fetchCliReleaseDates", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the npm time map minus created/modified", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          time: {
            created: "2026-01-01T00:00:00.000Z",
            modified: "2026-08-01T00:00:00.000Z",
            "0.41.1": "2026-08-09T18:00:00.000Z",
          },
        }),
        { status: 200 },
      ),
    );
    const dates = await fetchCliReleaseDates(fetchImpl as unknown as typeof fetch);
    expect(dates).toEqual({ "0.41.1": "2026-08-09T18:00:00.000Z" });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://registry.npmjs.org/@buildinternet/uploads",
      expect.anything(),
    );
  });

  it("throws on a non-200 response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 503 }));
    await expect(fetchCliReleaseDates(fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      /npm registry/i,
    );
  });
});

describe("renderMarkdown", () => {
  it("renders markdown to HTML", () => {
    expect(renderMarkdown("some `code` here")).toContain("<code>code</code>");
  });
});

describe("mergeEntries", () => {
  const entry = (over: Partial<ChangelogEntry>): ChangelogEntry => ({
    kind: "platform",
    id: "x",
    title: "x",
    date: "2026-08-01T00:00:00.000Z",
    html: "",
    tags: [],
    ...over,
  });

  it("sorts newest first", () => {
    const sorted = mergeEntries([
      entry({ id: "old", date: "2026-07-01T00:00:00.000Z" }),
      entry({ id: "new", date: "2026-08-10T00:00:00.000Z" }),
    ]);
    expect(sorted.map((e) => e.id)).toEqual(["new", "old"]);
  });

  it("puts platform entries before cli entries on the same date", () => {
    const sorted = mergeEntries([
      entry({ id: "cli", kind: "cli" }),
      entry({ id: "post", kind: "platform" }),
    ]);
    expect(sorted.map((e) => e.id)).toEqual(["post", "cli"]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @uploads/web exec vitest run src/lib/changelog.test.ts`
Expected: FAIL — module `./changelog` not found.

- [ ] **Step 4: Implement `apps/web/src/lib/changelog.ts`**

```ts
/**
 * Build-time data source for /changelog and /changelog.xml.
 *
 * Merges two streams into one newest-first list:
 *  - platform updates: the `changelog` content collection (hand-written .md)
 *  - CLI releases: `packages/uploads/CHANGELOG.md` (changesets output),
 *    dated via the npm registry's `time` map, since changesets carry no dates.
 *
 * Everything here runs at build time only. Failures throw so a bad build
 * never ships an incomplete changelog.
 */
import { getCollection } from "astro:content";
import { marked } from "marked";
// Vite raw import — the monorepo checkout is present at build time.
import cliChangelogRaw from "../../../../packages/uploads/CHANGELOG.md?raw";

export type ChangelogImage = { url: string; alt: string };

export type ChangelogEntry = {
  kind: "platform" | "cli";
  /** Stable anchor id, e.g. "screenshots-page" or "cli-0-41-1". */
  id: string;
  title: string;
  /** ISO 8601 UTC timestamp. */
  date: string;
  /** Rendered HTML body. */
  html: string;
  tags: string[];
  image?: ChangelogImage;
};

const NPM_PACKAGE_URL = "https://registry.npmjs.org/@buildinternet/uploads";

export function parseCliChangelog(md: string): { version: string; body: string }[] {
  const sections: { version: string; body: string }[] = [];
  const matches = [...md.matchAll(/^## (\d+\.\d+\.\d+(?:-[\w.]+)?)\s*$/gm)];
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const start = (match.index ?? 0) + match[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : md.length;
    sections.push({ version: match[1], body: md.slice(start, end).trim() });
  }
  if (sections.length === 0) {
    throw new Error("parseCliChangelog: no version sections found in CHANGELOG.md");
  }
  return sections;
}

export function cliAnchorId(version: string): string {
  return `cli-${version.replaceAll(".", "-")}`;
}

export async function fetchCliReleaseDates(
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, string>> {
  const res = await fetchImpl(NPM_PACKAGE_URL, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`npm registry responded ${res.status} for @buildinternet/uploads`);
  }
  const data = (await res.json()) as { time?: Record<string, string> };
  if (!data.time) {
    throw new Error("npm registry response has no time map");
  }
  const { created: _created, modified: _modified, ...versions } = data.time;
  return versions;
}

export function renderMarkdown(md: string): string {
  return marked.parse(md, { async: false }) as string;
}

export function mergeEntries(entries: ChangelogEntry[]): ChangelogEntry[] {
  return [...entries].sort((a, b) => {
    const byDate = Date.parse(b.date) - Date.parse(a.date);
    if (byDate !== 0) return byDate;
    if (a.kind === b.kind) return 0;
    return a.kind === "platform" ? -1 : 1;
  });
}

export async function loadChangelogEntries(): Promise<ChangelogEntry[]> {
  const [posts, dates] = await Promise.all([getCollection("changelog"), fetchCliReleaseDates()]);

  const platform: ChangelogEntry[] = posts.map((post) => ({
    kind: "platform",
    id: post.id,
    title: post.data.title,
    date: post.data.date.toISOString(),
    html: renderMarkdown(post.body ?? ""),
    tags: post.data.tags,
    image: post.data.image,
  }));

  const cli: ChangelogEntry[] = parseCliChangelog(cliChangelogRaw)
    // Versions missing from npm (e.g. the skipped 0.20.0) are dropped.
    .filter((section) => dates[section.version] !== undefined)
    .map((section) => ({
      kind: "cli" as const,
      id: cliAnchorId(section.version),
      title: `CLI ${section.version}`,
      date: dates[section.version],
      html: renderMarkdown(section.body),
      tags: ["cli"],
    }));

  return mergeEntries([...platform, ...cli]);
}
```

Note: `loadChangelogEntries` imports `astro:content`, which vitest cannot resolve — that is why the tests only exercise the pure functions. Keep it that way.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @uploads/web exec vitest run src/lib/changelog.test.ts`
Expected: PASS (all describes). If the `?raw` import breaks vitest module resolution, move the raw import into `loadChangelogEntries` via `import.meta.glob` eagerly — but try the plain `?raw` first; vitest supports it.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/changelog.ts apps/web/src/lib/changelog.test.ts apps/web/package.json pnpm-lock.yaml
git commit -m "feat(web): changelog data module — changeset parser, npm dates, merged stream"
```

---

### Task 2: Content collection + first entry + authoring README

**Files:**

- Create: `apps/web/src/content.config.ts`
- Create: `apps/web/src/content/changelog/screenshots-page.md`
- Create: `apps/web/src/content/changelog/README.md`

**Interfaces:**

- Consumes: nothing from other tasks.
- Produces: the `changelog` collection consumed by `loadChangelogEntries()` (Task 1) with data shape `{ title: string; date: Date; tags: string[]; image?: { url; alt } }`.

- [ ] **Step 1: Create `apps/web/src/content.config.ts`**

```ts
import { glob } from "astro/loaders";
import { defineCollection, z } from "astro:content";

/**
 * Platform updates for /changelog. One .md per update; slug = filename.
 * Screenshots are NEVER committed — upload to the buildinternet workspace
 * (changelog/ prefix) and reference the absolute storage.uploads.sh URL.
 * See src/content/changelog/README.md for the publishing workflow.
 */
const changelog = defineCollection({
  // README.md is the authoring guide, not an entry — exclude it.
  loader: glob({ pattern: ["*.md", "!README.md"], base: "./src/content/changelog" }),
  schema: z.object({
    title: z.string().min(1),
    date: z.coerce.date(),
    tags: z.array(z.string()).default([]),
    image: z
      .object({
        url: z.string().url().startsWith("https://"),
        alt: z.string().min(1),
      })
      .optional(),
  }),
});

export const collections = { changelog };
```

- [ ] **Step 2: Create the first entry `apps/web/src/content/changelog/screenshots-page.md`**

```md
---
title: "A home for your screenshots"
date: 2026-08-11
tags: [platform, web]
---

Every screenshot the CLI captures now has a page of its own. **Screenshots**
in your workspace groups captures by the page they came from — grouped by
project, with before/after pairs kept together — so you can find last week's
capture without scrolling a flat file list.

The CLI pitches in too: `uploads screenshot` derives a stable name from the
URL (plus `--state` for before/after variants), so re-capturing the same page
replaces the old shot instead of piling up near-duplicates.
```

(The lead screenshot is added at integration time — the image is uploaded to the buildinternet workspace first, then an `image:` block plus an inline image are added to this file. The entry is valid without it; `image` is optional.)

- [ ] **Step 3: Create `apps/web/src/content/changelog/README.md`**

````md
# Publishing a changelog entry

One markdown file per platform update. CLI releases are merged in
automatically from `packages/uploads/CHANGELOG.md` — never write those here.

1. Capture the screenshot (if any).
2. Upload it — never commit images to the repo:

   ```bash
   uploads put shot.png --workspace buildinternet --key changelog/<slug>.png
   ```
````

Copy the public `storage.uploads.sh` URL from the output. 3. Create `<slug>.md` in this directory (slug becomes the page anchor):

```md
---
title: "Human-readable title"
date: 2026-08-12
tags: [platform]
image:
  url: https://storage.uploads.sh/changelog/<slug>.png
  alt: "What the screenshot shows"
---

Body in plain markdown. Inline images work too, absolute https URLs only.
```

4. Open a PR. Merge deploys /changelog and /changelog.xml; releases.sh picks
   up the new entry on its normal feed sweep.

Image rules: absolute `https://` URLs, 1 KB–8 MB, png/jpeg/gif/webp/avif —
that's what releases.sh mirrors into its own storage. `date` supports full
ISO timestamps (`2026-08-12T15:00:00Z`) when same-day ordering matters.

````

- [ ] **Step 4: Verify the collection loads**

Run: `pnpm --filter @uploads/web exec astro sync`
Expected: exits 0 and generates `.astro/` types including the `changelog` collection. (If `astro sync` complains the content dir README matched, fix the glob exclusion from Step 1.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/content.config.ts apps/web/src/content/changelog/
git commit -m "feat(web): changelog content collection with first entry and authoring guide"
````

---

### Task 3: `/changelog` page

**Files:**

- Create: `apps/web/src/pages/changelog.astro`
- Modify: `apps/web/src/components/Footer.astro` (add Changelog link to the Product column)
- Modify: `apps/web/src/pages-reachability.test.ts` (add `/changelog` to the route table)

**Interfaces:**

- Consumes: `loadChangelogEntries()`, `ChangelogEntry` from `../lib/changelog` (Task 1).

- [ ] **Step 1: Add `/changelog` to the reachability test**

Open `apps/web/src/pages-reachability.test.ts`, find the `describe.each` route table, and add an entry following the exact shape of the existing rows (they carry at least `path` and an expected marker/title):

```ts
{ path: "/changelog", title: "Changelog" },
```

Match the row shape actually present in the file — copy an existing static-page row (e.g. the `/terms` one) and adjust.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @uploads/web exec vitest run src/pages-reachability.test.ts`
Expected: FAIL on the new `/changelog` row (page doesn't exist yet).

- [ ] **Step 3: Create `apps/web/src/pages/changelog.astro`**

```astro
---
// /changelog — merged product stream: hand-written platform updates
// (src/content/changelog) interleaved with CLI releases from changesets.
// Fully prerendered, zero client JS. Machine twin: /changelog.xml (Atom).
import BaseHead from "../components/BaseHead.astro";
import Footer from "../components/Footer.astro";
import SiteHeader from "../components/SiteHeader.astro";
import { loadChangelogEntries } from "../lib/changelog";

const entries = await loadChangelogEntries();

const pageTitle = "Changelog";
const pageDescription =
  "What's new in uploads.sh — platform updates and CLI releases, newest first.";

// Static page — auth origin is baked at build time (see src/lib/auth-client.ts).
const authOrigin = import.meta.env.PUBLIC_UPLOADS_AUTH_ORIGIN ?? "https://auth.uploads.sh";

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
---

<html lang="en">
  <head>
    <BaseHead preloadSans />
    <title>{pageTitle} · uploads.sh</title>
    <meta name="description" content={pageDescription} />
    <link rel="canonical" href="https://uploads.sh/changelog" />
    <link
      rel="alternate"
      type="application/atom+xml"
      title="uploads.sh changelog"
      href="/changelog.xml"
    />
    <style>
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        min-height: 100dvh;
        background: var(--bg);
        color: var(--fg);
        font: 15.5px/1.7 var(--sans);
        display: flex;
        flex-direction: column;
      }
      main {
        width: min(var(--width-content, 720px), 100%);
        margin: 0 auto;
        padding: 32px 24px 64px;
        flex: 1;
      }
      h1 {
        font-size: clamp(26px, 5vw, 34px);
        font-weight: 600;
        letter-spacing: -0.015em;
        line-height: 1.25;
        margin: 8px 0 4px;
      }
      .lede {
        color: var(--muted);
        font-size: 14px;
        margin: 0 0 12px;
      }
      .feed-link {
        color: var(--muted);
        font-size: 13px;
        text-decoration: underline;
        text-underline-offset: 3px;
      }
      .entry {
        border-top: 1px solid var(--line);
        padding: 32px 0 8px;
        margin-top: 24px;
      }
      .entry time {
        display: block;
        color: var(--muted);
        font: 12px var(--mono);
        letter-spacing: 0.02em;
        text-transform: uppercase;
        margin-bottom: 6px;
      }
      .entry h2 {
        font-size: 20px;
        font-weight: 600;
        letter-spacing: -0.01em;
        margin: 0 0 12px;
      }
      .entry h2 a {
        color: inherit;
        text-decoration: none;
      }
      .entry h2 a:hover {
        text-decoration: underline;
        text-underline-offset: 3px;
      }
      .entry--cli h2 {
        font-size: 16px;
        color: var(--body);
      }
      .entry--cli .body {
        color: var(--muted);
      }
      .lead-image {
        max-width: 100%;
        border: 1px solid var(--line);
        border-radius: 8px;
        margin: 0 0 14px;
      }
      .body :global(p),
      .body :global(li) {
        color: var(--body);
      }
      .body :global(img) {
        max-width: 100%;
        border: 1px solid var(--line);
        border-radius: 8px;
      }
      .body :global(h3) {
        font-size: 13px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--muted);
        margin: 18px 0 6px;
      }
      .body :global(a) {
        color: var(--fg);
        text-decoration: underline;
        text-decoration-color: color-mix(in srgb, var(--accent) 55%, transparent);
        text-underline-offset: 3px;
      }
      .body :global(code) {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 5px;
        padding: 1px 6px;
        font: 0.88em var(--mono);
        font-variant-ligatures: none;
      }
      .body :global(pre) {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 12px 14px;
        overflow-x: auto;
      }
      .body :global(pre code) {
        background: none;
        border: none;
        padding: 0;
      }
    </style>
  </head>
  <body>
    <SiteHeader authOrigin={authOrigin} />
    <main>
      <h1>Changelog</h1>
      <p class="lede">{pageDescription}</p>
      <a class="feed-link" href="/changelog.xml">Atom feed</a>
      {
        entries.map((entry) => (
          <article class:list={["entry", { "entry--cli": entry.kind === "cli" }]} id={entry.id}>
            <time datetime={entry.date}>{formatDate(entry.date)}</time>
            <h2>
              <a href={`#${entry.id}`}>{entry.title}</a>
            </h2>
            {entry.image && (
              <img
                class="lead-image"
                src={entry.image.url}
                alt={entry.image.alt}
                loading="lazy"
                decoding="async"
              />
            )}
            <div class="body" set:html={entry.html} />
          </article>
        ))
      }
    </main>
    <Footer />
  </body>
</html>
```

- [ ] **Step 4: Add the footer link**

In `apps/web/src/components/Footer.astro`, in the `COLUMNS` constant's Product column, add one line after the Docs link:

```ts
{ label: "Changelog", href: "/changelog" },
```

- [ ] **Step 5: Verify — tests and build**

Run: `pnpm --filter @uploads/web exec vitest run src/pages-reachability.test.ts`
Expected: PASS.

Run: `pnpm --filter @uploads/web build`
Expected: build succeeds; `apps/web/dist/changelog.html` exists and contains `id="cli-` anchors and the first platform entry's title. (The build performs the real npm fetch — network is required.)

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/changelog.astro apps/web/src/components/Footer.astro apps/web/src/pages-reachability.test.ts
git commit -m "feat(web): /changelog page — merged platform + CLI release stream"
```

---

### Task 4: `/changelog.xml` Atom feed

**Files:**

- Create: `apps/web/src/pages/changelog.xml.ts`
- Create: `apps/web/src/lib/changelog-feed.ts`
- Test: `apps/web/src/lib/changelog-feed.test.ts`
- Modify: `apps/web/public/_headers` (content-type + cache for `/changelog.xml`)

**Interfaces:**

- Consumes: `ChangelogEntry`, `loadChangelogEntries()` from `./changelog` (Task 1).
- Produces: `renderAtomFeed(entries: ChangelogEntry[]): string` in `changelog-feed.ts`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/changelog-feed.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { ChangelogEntry } from "./changelog";
import { renderAtomFeed } from "./changelog-feed";

const entries: ChangelogEntry[] = [
  {
    kind: "platform",
    id: "screenshots-page",
    title: "A home for <your> screenshots",
    date: "2026-08-11T00:00:00.000Z",
    html: '<p>Now with <img src="https://storage.uploads.sh/changelog/x.png" alt="x"></p>',
    tags: ["platform"],
  },
  {
    kind: "cli",
    id: "cli-0-41-1",
    title: "CLI 0.41.1",
    date: "2026-08-09T18:00:00.000Z",
    html: "<p>Fixes</p>",
    tags: ["cli"],
  },
];

describe("renderAtomFeed", () => {
  const xml = renderAtomFeed(entries);

  it("is an atom feed with feed-level metadata", () => {
    expect(xml).toContain('<?xml version="1.0" encoding="utf-8"?>');
    expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    expect(xml).toContain("<id>https://uploads.sh/changelog</id>");
    // Feed updated = newest entry date.
    expect(xml).toContain("<updated>2026-08-11T00:00:00.000Z</updated>");
    expect(xml).toContain('href="https://uploads.sh/changelog.xml" rel="self"');
  });

  it("emits one entry per item with anchored ids and escaped titles", () => {
    expect(xml).toContain("<id>https://uploads.sh/changelog#screenshots-page</id>");
    expect(xml).toContain("<id>https://uploads.sh/changelog#cli-0-41-1</id>");
    expect(xml).toContain("A home for &lt;your&gt; screenshots");
    expect(xml).not.toContain("A home for <your>");
  });

  it("carries full HTML content with absolute image URLs, escaped", () => {
    expect(xml).toContain('<content type="html">');
    expect(xml).toContain("https://storage.uploads.sh/changelog/x.png");
    expect(xml).toContain("&lt;img src=");
  });

  it("throws on an empty entry list rather than publishing an empty feed", () => {
    expect(() => renderAtomFeed([])).toThrow(/empty/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @uploads/web exec vitest run src/lib/changelog-feed.test.ts`
Expected: FAIL — module `./changelog-feed` not found.

- [ ] **Step 3: Implement `apps/web/src/lib/changelog-feed.ts`**

```ts
/**
 * Atom serializer for /changelog.xml. Entries carry full HTML content with
 * absolute image URLs so releases.sh mirrors the media at ingest.
 */
import type { ChangelogEntry } from "./changelog";

const SITE = "https://uploads.sh";
const PAGE = `${SITE}/changelog`;
const FEED = `${SITE}/changelog.xml`;

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function renderAtomFeed(entries: ChangelogEntry[]): string {
  if (entries.length === 0) {
    throw new Error("renderAtomFeed: refusing to publish an empty feed");
  }
  const updated = entries
    .map((e) => e.date)
    .sort()
    .at(-1)!;

  const items = entries
    .map(
      (entry) => `  <entry>
    <id>${PAGE}#${entry.id}</id>
    <title>${escapeXml(entry.title)}</title>
    <link href="${PAGE}#${entry.id}"/>
    <updated>${entry.date}</updated>
${entry.tags.map((tag) => `    <category term="${escapeXml(tag)}"/>`).join("\n")}
    <content type="html">${escapeXml(entry.html)}</content>
  </entry>`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>${PAGE}</id>
  <title>uploads.sh changelog</title>
  <subtitle>Platform updates and CLI releases</subtitle>
  <link href="${PAGE}"/>
  <link href="${FEED}" rel="self"/>
  <updated>${updated}</updated>
  <author><name>uploads.sh</name></author>
${items}
</feed>
`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @uploads/web exec vitest run src/lib/changelog-feed.test.ts`
Expected: PASS.

- [ ] **Step 5: Create the endpoint `apps/web/src/pages/changelog.xml.ts`**

```ts
/**
 * /changelog.xml — Atom twin of /changelog. Prerendered at build time and
 * served off the ASSETS binding; headers come from public/_headers. This is
 * the Tier-1 machine locator declared in .well-known/releases.json.
 */
import type { APIRoute } from "astro";
import { loadChangelogEntries } from "../lib/changelog";
import { renderAtomFeed } from "../lib/changelog-feed";

export const prerender = true;

export const GET: APIRoute = async () => {
  const entries = await loadChangelogEntries();
  return new Response(renderAtomFeed(entries), {
    headers: { "content-type": "application/atom+xml; charset=utf-8" },
  });
};
```

- [ ] **Step 6: Add headers for the feed**

In `apps/web/public/_headers`, following the existing per-path block style (see the `/.well-known/releases.json` block there), add:

```
# Atom feed for /changelog — the machine locator declared in releases.json.
/changelog.xml
  Content-Type: application/atom+xml; charset=utf-8
  Cache-Control: public, max-age=300
  Access-Control-Allow-Origin: *
```

- [ ] **Step 7: Verify with a build**

Run: `pnpm --filter @uploads/web build`
Expected: succeeds; `apps/web/dist/changelog.xml` exists, starts with `<?xml`, and contains `<entry>` elements for both streams.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/pages/changelog.xml.ts apps/web/src/lib/changelog-feed.ts apps/web/src/lib/changelog-feed.test.ts apps/web/public/_headers
git commit -m "feat(web): /changelog.xml Atom feed for releases.sh ingestion"
```

---

### Task 5: Manifest, sitemap, llms.txt, crawl policy

**Files:**

- Modify: `apps/web/public/.well-known/releases.json`
- Modify: `apps/web/public/sitemap.xml`
- Modify: `apps/web/public/llms.txt`
- Modify: `apps/web/public/llms-full.txt`
- Modify: `apps/web/README.md`

**Interfaces:**

- Consumes: the live URLs `/changelog` and `/changelog.xml` (Tasks 3–4).

- [ ] **Step 1: Update the domain manifest**

Replace the `releases` array in `apps/web/public/.well-known/releases.json` with (everything else unchanged):

```json
"releases": [
  {
    "title": "Changelog",
    "url": "https://uploads.sh/changelog",
    "feed": "https://uploads.sh/changelog.xml",
    "canonical": true
  },
  {
    "title": "@buildinternet/uploads",
    "github": "buildinternet/uploads"
  }
]
```

The repo-root `releases.json` is intentionally unchanged (repo scope, own canonical).

- [ ] **Step 2: Validate the manifest**

Run:

```bash
node "/Users/zachdunn/Library/Application Support/Claude/local-agent-mode-sessions/skills-plugin/a305a85e-806a-4eb0-ac31-8c5f1d63838d/96fb1803-793e-4756-8aff-2ea947c9df92/skills/creating-releases-json/scripts/validate.mjs" apps/web/public/.well-known/releases.json
```

Expected: `✓` exit 0. (Fallback if that path has moved: `node /Users/zachdunn/Code/releases/skills/creating-releases-json/scripts/validate.mjs …` — same script.)

- [ ] **Step 3: Sitemap**

In `apps/web/public/sitemap.xml`, add after the `/docs` entry:

```xml
  <url>
    <loc>https://uploads.sh/changelog</loc>
    <changefreq>weekly</changefreq>
    <priority>0.6</priority>
  </url>
```

(The feed is a machine endpoint — deliberately not in the sitemap.)

- [ ] **Step 4: llms.txt + llms-full.txt**

In `apps/web/public/llms.txt`, in the "Start here" list after the Docs line, add:

```
- [Changelog](https://uploads.sh/changelog): platform updates and CLI releases, newest first (Atom feed at https://uploads.sh/changelog.xml)
```

In `apps/web/public/llms-full.txt`, add the same link wherever the site's page inventory is listed (match the file's existing style — read it first).

- [ ] **Step 5: README crawl-policy table**

In `apps/web/README.md`, add a row to the crawl-policy table after `/github-screenshots`:

```md
| `/changelog` | yes | Product updates + CLI releases; in `sitemap.xml`; Atom at `/changelog.xml` |
```

Also add `src/pages/changelog.astro` / `changelog.xml.ts` to the README's file map if other pages are listed there (match existing style).

- [ ] **Step 6: Full verification sweep**

```bash
pnpm --filter @uploads/web test
pnpm --filter @uploads/web typecheck
pnpm --filter @uploads/web build
```

Expected: all pass. Then confirm `apps/web/dist/.well-known/releases.json` carries the new entries.

- [ ] **Step 7: Commit**

```bash
git add apps/web/public/.well-known/releases.json apps/web/public/sitemap.xml apps/web/public/llms.txt apps/web/public/llms-full.txt apps/web/README.md
git commit -m "feat(web): declare changelog url+feed canonical in releases.json; discovery plumbing"
```

---

### Task 6 (integration, main session — not delegated): first-entry screenshot + browser verification + PR

This task runs in the main session because it needs the browser panel, the uploads MCP, and PR credentials.

- [ ] **Step 1:** Capture a screenshot of the Screenshots page (signed-in surface — use the local stack-raw recipe or an existing capture) and upload it: `uploads put screenshots-page.png` to the buildinternet workspace at key `changelog/screenshots-page.png`.
- [ ] **Step 2:** Add the `image:` block (url + alt) to `apps/web/src/content/changelog/screenshots-page.md` frontmatter; rebuild; confirm the image renders on `/changelog` and appears escaped in `/changelog.xml`.
- [ ] **Step 3:** Verify in the browser panel: `/changelog` renders the merged stream (platform post first by date, CLI entries quieter), anchors work, footer link present, feed link resolves.
- [ ] **Step 4:** `git push` and open a PR to `main` titled `feat(web): changelog page + Atom feed (#…)`, description covering the page, feed, manifest change, and publishing workflow; embed the page screenshot via the github-screenshots skill.
- [ ] **Step 5:** After merge/deploy, confirm `https://uploads.sh/changelog.xml` serves Atom with the right content type, re-validate the live manifest (`POST https://api.releases.sh/v1/listing/validate` with `{"domain":"uploads.sh"}`), and optionally trigger `POST /v1/orgs/uploads/sync-well-known` so releases.sh picks up the feed without waiting for the daily sweep.
