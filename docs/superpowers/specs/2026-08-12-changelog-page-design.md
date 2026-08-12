# Changelog page for uploads.sh — design

Date: 2026-08-12
Status: approved (brainstorm 2026-08-12)

## Goal

A public `/changelog` page on uploads.sh that tells the product story in one
merged stream: hand-written platform updates (e.g. "Screenshots page") plus CLI
releases from changesets. The page must be ingest-friendly for releases.sh,
which means shipping a real Atom feed (Tier 1 ingestion) and updating the
`.well-known/releases.json` manifest to declare it. Screenshots in updates are
hosted on R2 via the uploads platform itself, never committed to the repo.

## Background facts (verified 2026-08-12)

- `releases.json` (v2) is a pointer manifest — it declares _where_ release
  notes live, not the entries themselves. uploads.sh already serves a valid
  domain-scope manifest at `apps/web/public/.well-known/releases.json`
  (canonical: `github: buildinternet/uploads`) and a repo-scope `releases.json`
  at the repo root (`github: "self"`, canonical).
- releases.sh ingestion tiers: `feed`/`github`/`appstore` locators are Tier 1
  (deterministic, auto-created, self-serve). A bare `url` is Tier 2 — billable
  AI scrape, curator-gated. So the feed is what makes the page ingest-friendly.
- releases.sh mirrors entry images into its own R2 when they are absolute
  `https://` URLs between 1 KB and 8 MB (png/jpeg/gif/webp/avif; GIF→MP4).
  Relative paths and auth-walled URLs are not mirrored.
- Non-versioned entries are first-class in releases.sh (`version` is nullable;
  only `title` + `content` are required). Platform notes need no semver.
- The uploads org exists in the releases.sh registry as a stub (source
  auto-created from the declared GitHub locator, zero releases indexed yet).
- `packages/uploads/CHANGELOG.md` is the changesets output for
  `@buildinternet/uploads`: `## <version>` sections with prose bodies. It
  carries **no dates**. GitHub releases are tagged `uploads-v<version>`.
- apps/web is Astro 7 on Cloudflare Workers; pages are prerendered by default;
  public pages ship no framework JS; sitemap.xml and llms.txt are
  hand-maintained; the web worker has no R2 binding.

## Decisions (made with Zach, 2026-08-12)

1. **Publishing model:** git-committed markdown. One file per platform update
   in an Astro content collection. Publish = PR + merge (Workers Builds
   deploys). No admin UI, no D1, no scaffold script.
2. **Page scope:** merged stream — platform updates interleaved with CLI
   releases parsed from `packages/uploads/CHANGELOG.md` at build time.
3. **Screenshot hosting:** dogfood the product. Upload via the uploads CLI to
   the buildinternet workspace under a `changelog/` prefix; reference the
   absolute `storage.uploads.sh` URL from the markdown. Accepted risk:
   workspace files are deletable like any other file.
4. **Canonical source:** the changelog `url`+`feed` pair becomes the canonical
   entry in the domain manifest; the GitHub locator stays as a secondary
   source. The repo-scope manifest is unchanged.

## Components

### 1. Content collection — `apps/web/src/content/changelog/`

- One `.md` file per platform update, slug = filename.
- Frontmatter schema (zod, via Astro content config):
  - `title: string` (required)
  - `date: ISO date` (required)
  - `tags?: string[]` (e.g. `platform`, `web`, `cli`)
  - `image?: { url: https URL, alt: string }` — lead image; more images may
    appear inline in the body as standard markdown.
- Body: plain markdown. Image URLs must be absolute `https://`.

### 2. CLI release parser — build-time module

- Parses `packages/uploads/CHANGELOG.md` into `{ version, body }[]` from
  `## <version>` sections.
- Dates come from one build-time fetch of
  `https://registry.npmjs.org/@buildinternet/uploads` — its `time` map has an
  exact publish timestamp per version. If the fetch fails, the build fails
  loudly (no undated entries). Versions absent from npm (e.g. the known-skipped
  0.20.0) are dropped.
- Trade-off accepted: a network dependency in the site build. Fallback option
  if it flakes: commit a version→date JSON maintained by the release workflow.

### 3. Page — `/changelog`

- Prerendered Astro page, zero client JS. SiteHeader + Footer + BaseHead (not
  DocsLayout — it is a top-level page like the homepage).
- Newest-first merged stream. Each entry gets a stable anchor id: platform
  entries use their slug (`#screenshots-page`), CLI entries use
  `#cli-<version-with-dashes>` (`#cli-0-41-0`).
- Platform entries render prominently (title, date, lead image, body). CLI
  entries render the full changeset body but visually quieter.
- `<link rel="alternate" type="application/atom+xml" href="/changelog.xml">`
  in the head.

### 4. Feed — `/changelog.xml`

- Prerendered Astro endpoint emitting Atom. Same merged entries as the page.
- Each entry: `id` (page URL + anchor), `title`, `updated` (entry date),
  `link` to the anchor, `content type="html"` with the rendered body including
  absolute image URLs (so releases.sh mirrors media).
- Feed-level `updated` = newest entry date. Not listed in sitemap.xml
  (machine endpoint convention).

### 5. Manifest + discovery updates

- `apps/web/public/.well-known/releases.json`: add top-level entry
  `{ "title": "Changelog", "url": "https://uploads.sh/changelog",
"feed": "https://uploads.sh/changelog.xml", "canonical": true }`; remove
  `canonical` from the GitHub entry (keep the entry itself).
- Validate with the creating-releases-json skill's `validate.mjs` before
  shipping.
- Repo-root `releases.json`: unchanged.

### 6. Site plumbing

- `public/sitemap.xml`: add `/changelog`.
- `public/llms.txt` and `public/llms-full.txt`: add the changelog link.
- `apps/web/README.md` crawl-policy table: `/changelog` is indexable.
- No `_headers` change needed for the feed (served prerendered via ASSETS with
  the correct content type by extension); confirm during implementation.

### 7. Publishing workflow doc

- `apps/web/src/content/changelog/README.md` (or a docs page section):
  1. Capture the screenshot.
  2. `uploads put shot.png` to the buildinternet workspace with key prefix
     `changelog/` → copy the public URL.
  3. Create `apps/web/src/content/changelog/<slug>.md` with frontmatter + body.
  4. Open a PR; merge deploys the site and the feed; releases.sh picks the new
     entry up on its normal sweep.
- Image constraints to note in the doc: absolute https URLs, 1 KB–8 MB, so
  releases.sh mirrors them.

## Error handling

- Build fails if: npm `time` fetch fails, CHANGELOG.md parse yields zero
  versions, a content entry fails frontmatter validation, or an entry `image.url`
  is not `https://`.
- Feed omits nothing silently — every merged entry appears on both the page and
  the feed.

## Testing

- Unit tests: CHANGELOG.md parser (section splitting, version extraction,
  skipped-version handling), merge/sort ordering, anchor id generation.
- Feed test: output is well-formed XML with required Atom elements
  (`id`, `title`, `updated`, `entry` fields) and absolute URLs.
- Existing web build in CI validates the Astro pages end-to-end.

## Out of scope (YAGNI)

- Pagination (single page until it hurts).
- Admin UI / DB-backed entries.
- Scaffold/helper command for authoring.
- Per-entry pages (`/changelog/<slug>`) — anchors suffice for now.
- RSS in addition to Atom.

## First entry

Seed the collection with a post about the Screenshots page (shipped 2026-08-11,
PR #614/#629), including a screenshot uploaded to the buildinternet workspace —
this exercises the whole pipeline end to end.
