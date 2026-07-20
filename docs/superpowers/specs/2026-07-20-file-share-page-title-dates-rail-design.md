# Public file share page — title, dual dates, large-screen rail

**Date:** 2026-07-20  
**Branch / worktree:** `feat/file-share-page-title-dates-rail`  
**Scope:** public file page `apps/web/src/pages/f/[workspace]/[...key].astro` (ok / file-found branch), the public JSON it consumes (`GET /public/files/:workspace/:key`), and the put/visibility write paths that must stamp and preserve first-upload time.  
**Status:** design approved (2026-07-20).

## 1. Problem

The public file share page (`/f/<workspace>/<key>`) is the durable link people paste for a single upload. Three gaps relative to recent product work:

1. **GitHub title.** CLI attach paths now stamp `gh.title`, and the signed-in connected-work rail also live-resolves titles via the GitHub App + KV cache (#267 / #270 / #282). The share page still shows only `owner/repo#N` on the chip.
2. **Revision dates.** Overwriting the same key is a first-class workflow (stable URL hot-swap). The page exposes a single “Uploaded” field that is really object `lastModified`, so a revision erases the original upload time in the UI.
3. **Large-screen layout.** Metadata and download/copy controls sit under the media stage in a full-width caption. On wide viewports that wastes horizontal space and pushes actions below the fold.

## 2. Goals & non-goals

**Goals**

- Show the PR/issue **title** on the share-page GitHub chip, matching the rail’s stamp-then-live-resolve preference order.
- Track **first upload** vs **last modified** through Files SDK object metadata so revisions can show both when they differ.
- On large screens, place metadata + download/copy controls in a **right rail** beside the media; keep today’s stacked layout on narrow screens.
- Keep the public page script-light on the happy path (no client GitHub fetches); enrichment stays server-side.

**Non-goals**

- Gallery item page (`/g/:id/:item`) layout/title/date parity (follow-up unless free).
- A new public batch `github-titles` endpoint (resolution is only for this single-object public route).
- Client-side live unfurl or open/closed/merged state badges.
- Backfilling `uploaded-at` for objects never re-put after this ships.
- Auto-requesting CodeRabbit on the PR.

## 3. Approach (approved)

**Enrich the public-file API + page layout**, using the existing Files SDK surface through `@uploads/storage` / `createStorage()` — not raw R2 bindings.

| Concern | Where | Mechanism |
| --- | --- | --- |
| First-upload stamp | `putObject` (+ visibility rewrite) | Files SDK `upload({ metadata })` key `uploaded-at`; preserve from prior `head().metadata` on overwrite |
| Modified time | public-files route | Files SDK `head().lastModified` (already used, today labeled `uploaded`) |
| Title | public-files route | `gh.title` from D1 file_metadata → overlay `resolveTitles` (App + `GITHUB_CACHE`) |
| Layout | file page Astro + CSS | media \| rail grid ≥ ~1080px; stack below |

## 4. Data model

### 4.1 `uploaded-at` (R2 / Files SDK custom metadata)

- **Key:** `uploaded-at` (lowercase, hyphenated — same style as provenance keys in `provenance.ts`).
- **Value:** ISO-8601 UTC string (printable ASCII, short enough for provenance-style caps; treat as server-only).
- **Write rules:**
  - **Create** (`putObject` when key did not exist): set `uploaded-at` to now (request time is fine; need not match provider mtime exactly).
  - **Overwrite** (key existed): `head` first (already done for size/ledger), copy prior `uploaded-at` if present and valid; if missing (legacy object), set `uploaded-at` to the prior object’s `lastModified` when available, else now. Never accept `uploaded-at` from client headers / provenance allowlist.
  - **Visibility rewrite** (`toggleVisibility` / equivalent full rewrite): must carry `uploaded-at` forward with the rest of preserved metadata so a private/public flip does not reset first-upload time.
- **Not** stored in D1 `file_metadata` (queryable tags stay for `gh.*` and user tags). First-upload is object provenance, co-located with the bytes.

### 4.2 Public JSON DTO (`GET /public/files/:workspace/:key`)

Extend the existing response (no breaking renames of required fields beyond clarifying semantics):

```ts
{
  workspace: string;
  key: string;
  url: string;
  embedUrl: string | null;
  size: number;
  contentType: string;
  /** First-upload time when known; else falls back to lastModified (legacy). ISO. */
  uploaded?: string;
  /**
   * Object last-modified from Files SDK head(). Included when present and
   * meaningfully different from `uploaded` (see §5). Omitted when equal /
   * missing so old clients keep a single-field mental model.
   */
  modified?: string;
  metadata?: Record<string, string>;
  github?: {
    repo: string;
    kind: "pull" | "issue";
    number: number;
    url: string;
    /** Prefer live resolve; fall back to stamped gh.title. Omitted when neither. */
    title?: string;
  };
}
```

**Field derivation**

- `modified` = ISO from `meta.lastModified` when defined.
- `uploaded` = ISO from object metadata `uploaded-at` when valid; else same as today’s fallback (`lastModified`).
- `modified` **omitted from JSON** when absent, or when equal to `uploaded` within a small tolerance (same second is enough for storage noise) so single-date objects stay one field.
- `github.title` = live `resolveTitles` title if non-null; else stamped `metadata["gh.title"]` if non-empty; else omit.

`apps/web` `PublicFile` / `GithubContext` validators in `public-file.ts` gain optional `modified` and `github.title` with the same bounded-string rules as other fields.

## 5. Dates UI rules

On the share page `dl.meta`:

| Condition | UI |
| --- | --- |
| only `uploaded` | `Uploaded` → formatted date (unchanged label) |
| `uploaded` + `modified` and they differ by calendar day **or** by more than 60 seconds | show both rows: `Uploaded`, `Modified` |
| both present but within 60s / same instant | show only `Uploaded` |

Formatting stays `toLocaleDateString("en-US", { year, month: "short", day: "numeric" })` unless both are same calendar day but still differ by >60s — then include time on both rows so the distinction is readable (optional polish; default can keep date-only if product prefers less noise).

**Recommended default:** date-only labels; if same calendar day but dual-date condition trips on the 60s rule, append short time (`hour`/`minute`) to both.

## 6. GitHub title (public path)

### 6.1 Server

In `apps/api/src/routes/public-files.ts` after visibility gate + `getFileMetadata`:

1. `deriveGithubContext(metadata)` — extend to pass through optional `title` from `gh.title` when it passes the same printable/length checks used elsewhere (≤512).
2. If a github context exists, build `ref` = `${repo}#${number}` (lowercase repo already stored) and call `resolveTitles(env, [ref])` once.
3. If the map entry has a non-empty `title`, set `github.title` to that (live wins over stamp).
4. Any resolve failure / timeout / missing App config → keep stamped title or omit; **never** fail the public JSON response.

Reuse `resolveTitles` from `apps/api/src/github-titles.ts` as-is (8s abort, KV cache, App token ladder). Do not open a new unauthenticated public titles API.

### 6.2 Chip UI

Replace chip text so that when `file.github.title` is present:

```
[kind icon]  {title}
             {repo}#{number}   ← muted secondary line or same-row secondary
```

When title is absent: keep today’s `repo#number` single line.

`aria-label`: include kind, title (if any), and `repo#number`.

No client script for titles.

## 7. Large-screen layout

**Breakpoint:** ~1080px (align with documented `--bp-rail` in `signed-in-shell.css`; file page uses a local media query with that pixel value + comment referencing the scale — media queries cannot read custom properties).

**Wide (≥1080px)**

- `.stage` → CSS grid: `1fr` media column + fixed rail (~300px, clamp 280–320px).
- `.media` stays visual focus (`min-height`, `max-height: 78vh`, contain).
- `.details` becomes the right rail: filename, gh-chip, meta dl, optional Metadata section, `CopyAsControls` (+ Open original).
- Rail may scroll if content exceeds media height (`overflow: auto; max-height: ~78vh` or match media column).
- Shell width: widen slightly so media is not crushed, e.g. `min(var(--width-viewer, 1200px), calc(100% - 48px))` on this page only (or bump viewer token if already shared with gallery — prefer page-local override if gallery stays stacked).

**Narrow (&lt;1080px)**

- Keep current single-column stack: media full width, details under media (matches screenshot baseline).

No React island; plain Astro + inline styles as today. Footer remains below the stage.

## 8. Files SDK usage (explicit)

All object I/O continues through `createStorage()` → Files `Files` instance:

| Operation | SDK | Notes |
| --- | --- | --- |
| Pre-put existence / prior mtime / prior metadata | `store.head(key)` or existing `existingSize` + head | Use `lastModified` + `metadata` from `StoredFile` |
| Write with stamp | `store.upload(key, bytes, { contentType, cacheControl, metadata })` | Merge provenance + visibility + `uploaded-at` |
| Public read meta | `store.head(key)` already in `resolvePublicObject` | Map fields in JSON builder |

Do **not** call R2 `customMetadata` APIs via `files.raw` for this feature. If a future adapter lacks metadata round-trip, dual dates degrade to lastModified-only (single field) without breaking uploads.

## 9. Write-path changes (API)

### 9.1 `putObject` (`files-core.ts`)

Today: pre-put `existingSize` only. Extend to capture prior `lastModified` + `metadata["uploaded-at"]` when the object exists (one head is enough — reuse if `existingSize` already heads).

```ts
// pseudocode
const prior = await store.head(finalKey).catch(() => null);
const replaced = prior != null;
const uploadedAt =
  prior?.metadata?.["uploaded-at"] && isValidIso(prior.metadata["uploaded-at"])
    ? prior.metadata["uploaded-at"]
    : prior?.lastModified != null
      ? new Date(prior.lastModified).toISOString()
      : new Date().toISOString();
// first create: always now
const uploadedAtFinal = replaced ? uploadedAt : new Date().toISOString();

storageMetadata = {
  ...provenance,
  ...(visibility ? { visibility } : {}),
  "uploaded-at": uploadedAtFinal,
};
```

Ensure `uploaded-at` is **not** stripped by `sanitizeProvenance` (it is not a client provenance key — set only in the server `storageMetadata` bag after sanitize).

### 9.2 Visibility rewrite

When rewriting object metadata for visibility, merge existing `uploaded-at` from the pre-rewrite head into the new metadata map.

## 10. Web page structure (sketch)

```html
<figure class="stage">
  <div class="media">…</div>
  <figcaption class="details">
    <div class="filename">…</div>
    <!-- gh-chip with title + optional secondary ref -->
    <dl class="meta">Type / Size / Uploaded [/ Modified]</dl>
    <!-- optional Metadata section -->
    <CopyAsControls>…</CopyAsControls>
  </figcaption>
</figure>
```

CSS (wide):

```css
@media (min-width: 1080px) {
  .shell { width: min(1200px, calc(100% - 48px)); }
  .stage {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(280px, 320px);
    align-items: stretch;
  }
  .details {
    border-top: none;
    border-left: 1px solid var(--line);
    max-height: 78vh;
    overflow: auto;
  }
  .media { max-height: 78vh; }
}
```

## 11. Error handling

| Failure | Behavior |
| --- | --- |
| `resolveTitles` slow/fail | omit live title; keep stamp or ref-only chip |
| Invalid / missing `uploaded-at` | `uploaded` falls back to `lastModified` |
| Adapter without metadata | single date field; puts still succeed |
| Private file | unchanged `auth_required` branch; no title resolve after 401 |

Public CSP / noindex / no-store headers unchanged from the file-page polish posture.

## 12. Testing

**API**

- `putObject` first put sets `uploaded-at`.
- Overwrite preserves prior `uploaded-at` (and does not advance it).
- Legacy overwrite (no prior stamp): seeds `uploaded-at` from prior `lastModified`.
- Visibility rewrite preserves `uploaded-at`.
- Public files JSON: `uploaded` / `modified` / `github.title` shape; `modified` omitted when equal; title prefers mocked live resolve over stamp; resolve throw does not 500.

**Web**

- `public-file.ts` accepts optional `modified` + `github.title`; rejects oversized/control chars.
- Pure helpers if extracted (e.g. `shouldShowModified(uploaded, modified)`, chip label) unit-tested.
- Optional light markup test only if already patterned in repo; otherwise manual / Playwright not required for this PR.

## 13. Implementation order (for the plan)

1. Stamp/preserve `uploaded-at` in `putObject` + visibility rewrite + tests.
2. Public-files DTO: `uploaded` / `modified` + `github.title` (stamp + `resolveTitles`) + tests.
3. Web DTO validation + page: chip title, dual dates, rail layout + tests.
4. Docs touch if `docs/api.md` documents the public files response (only if already listed).

## 14. Open follow-ups (explicitly deferred)

- Gallery item page same rail + title + dates.
- Optional one-shot backfill job for `uploaded-at` on popular keys (not required).
- Showing full timestamp tooltips on hover for power users.

## 15. Decisions log

| # | Decision | Choice |
| --- | --- | --- |
| Title source | Stamped + live resolve (like rail) | approved |
| First-upload storage | Files SDK metadata `uploaded-at`, preserve on overwrite | approved |
| Layout | Media left, meta+actions right ≥1080px | approved |
| Architecture | Enrich public-file API + page layout | approved |
| Gallery parity | Out of scope this PR | approved |
| Dual-date display | Both when day differs or \|Δ\| > 60s | approved |
