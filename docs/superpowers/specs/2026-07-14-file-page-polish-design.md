# Public file page polish — design spec

**Date:** 2026-07-14
**Scope:** the public file page `apps/web/src/pages/f/[workspace]/[...key].astro`
(the `ok`/file-found branch) **and the per-item gallery page**
`apps/web/src/pages/g/[id]/[item].astro`, plus small, clearly-scoped additions
to `apps/api`'s public files and public galleries routes (download controls +
surfacing an already-computed `embedUrl` per gallery item). No React, no new
dependencies beyond what's already in the monorepo.
**Status:** design approved (2026-07-14). Open decisions (a)–(d) resolved to
their recommended defaults — see §4. Gallery-item scope added — see §4.5.
Nothing in this doc has been implemented yet.

## 1. Current state

The page (`apps/web/src/pages/f/[workspace]/[...key].astro`) is a single Astro
SSR route with plain inline `<style>` and, for the `ok` branch, **no
`<script>` at all**. The only script on the page today is the progressive
auth-check probe in the `auth_required` branch (lines 179–208).

Relevant structure in the `ok` (file found) branch:

- **Attached to / GitHub row** (lines 125–133): a plain `<a>` reading
  `{repo}#{number}` next to a `.gh-kind` badge (`PR` / `Issue`, styled at line
  87). No GitHub glyph, no visual grouping — it reads as one more metadata
  row, not a linked-object reference.
- **Actions row** (lines 148–154, styles 90–95): `Open original ↗` (an `<a>`
  to `file.url`, opens the raw file/object in a new context) sits next to a
  `.linkfield` — a `<label>` + **readonly `<input>`** holding the canonical
  page URL. There is no copy button and no way to download the raw file
  except "open, then save-as" from the browser's own UI.
- **Metadata list** (`dl.meta`, lines 121–134) and the generic **Metadata**
  section (lines 135–147) render `Type`, `Size`, `Uploaded`, and non-`gh.*`
  metadata pairs. This structure is unaffected by this work and must be
  preserved as-is (see Non-goals).

**The load-bearing constraint for every feature below:** the `ok` branch's
CSP (`PUBLIC_FILE_CSP`, built by `buildFileCsp()` in
`apps/web/src/lib/public-file.ts` lines 77–97) sets
`script-src https://static.cloudflareinsights.com` — no `'self'`, no
`'unsafe-inline'`. This is a deliberate, tested posture
(`apps/web/src/lib/public-file.test.ts` lines 24–33: "locks down like the
public gallery... script-free"). The page is script-free today specifically
on this branch — the `auth_required` branch already accepts a widened CSP
(`authRequiredFileCsp`, lines 107–112) because it needs to probe the API, but
that widening has never been applied to the branch every public file view
actually hits. Any feature here that needs JS (click-to-copy, "copy as"
controls) means widening `script-src` on the highest-traffic branch of this
route. This is flagged as Open Decision (d) below — it's real enough to
deserve an explicit yes, not an assumption buried in the diff.

`file.url` (`PublicFile.url` in `apps/web/src/lib/public-file.ts` line 20) is
always `https:` (validated by `httpsUrl()`, lines 142–149) and always
cross-origin from the page — it points at the storage host (R2 custom domain
/ `publicBaseUrl`), never at `uploads.sh`. Confirmed via
`apps/api/src/routes/public-files.ts` line 78 (`publicUrl(...)`) and
`apps/api/src/storage.ts`: object bytes are served directly off that host,
never proxied through the API Worker. That host is a bare R2 custom domain
(see `apps/api/src/files-core.ts`'s `UPLOAD_CACHE_CONTROL` comment: "R2's
custom-domain default") — it has no Worker in front of it, so today there is
no code path that can attach a per-request `Content-Disposition` header to
those bytes.

`apps/api/src/routes/public-files.ts` (the `GET /public/files/:workspace/:key`
endpoint this page calls) returns `workspace, key, url, size, contentType,
uploaded?, metadata?, github?` — **no `embedUrl`**. `embedUrl` exists only on
the _authenticated_ endpoints (`apps/api/src/routes/files.ts`,
`apps/api/src/gallery-service.ts`, both via `objectPublicUrls`/
`publicAndEmbedUrls` in `apps/api/src/storage.ts` and
`packages/storage/src/index.ts` lines 107–148). The task brief's premise that
"the API also exposes an `embedUrl`" is true for those endpoints but **not**
for the one this page actually calls — see Open Decision (c) and §3.3.

## 2. Goals & non-goals

**Goals**

- Make the GitHub attachment read as a recognizable, glyph-bearing chip
  (Notion-style), reusing the existing `GitHubMark.astro` component.
- Replace the plain readonly `<input>` with a real click-to-copy control that
  gives feedback, reusing the established `data-copy` pattern.
- Offer the URL forms people actually paste (raw file, page URL, Markdown,
  HTML `<img>`) in one coherent, low-chrome control — not four competing
  inputs.
- Give the file a working one-click "Download" that doesn't silently open a
  new tab instead of saving.
- Keep every existing security/behavior guarantee intact (see Non-goals).

**Non-goals**

- No live GitHub API calls, no PR/issue titles, no open/closed/merged state,
  no avatars. Only `GithubContext` (`repo`, `kind`, `number`, `url`) is
  available without a live fetch, and a live fetch has real costs (rate
  limits with no token, added latency on every public file view, a new
  outbound dependency on a page whose CSP is currently locked to
  `default-src 'none'`). See Open Decision (a).
- No change to the `auth_required` / `unavailable` / `not_found` branches,
  their status codes, or their copy.
- No change to the `noindex`/CSP/`Cache-Control: no-store` header posture
  beyond what's explicitly decided in Open Decision (d).
- No change to the generic metadata list or the `gh.*` filtering
  (`metadataEntries`, lines 45–49).
- No redesign of the media stage (`.media`, `img`/`video`/fallback rendering).
- No new frameworks/components; this stays plain Astro + inline `<style>` +
  (if approved) inline `<script>`, matching every other page in `apps/web`
  that isn't built on `@uploads/ui`.
- No thumbnail/OG-image changes.

## 3. Design per feature

### 3.1 GitHub chip / unfurl

**Recommended approach — static chip, not a live unfurl.** Replace the plain
`<a>` + `.gh-kind` badge (lines 125–133) with a single chip-shaped `<a>`:
`GitHubMark.astro` icon + `{repo}#{number}` + a small kind label, all inside
one bordered, rounded, padded anchor — Notion's "linked page" chip shape,
built from tokens already in this file (`var(--line)`, `var(--panel)`,
`var(--radius-md)`, `var(--mono)`), same visual language as `.actions
a.original` (lines 91–92) so it doesn't introduce a new component style.

```html
<a class="gh-chip" href="{file.github.url}" rel="noopener noreferrer">
  <GitHubMark size="{14}" />
  <span class="gh-chip-name">{file.github.repo}#{file.github.number}</span>
  <span class="gh-chip-kind">{file.github.kind === "pull" ? "PR" : "Issue"}</span>
</a>
```

Move this out of `dl.meta` into its own row (it stops being a `dt`/`dd` pair
and becomes a standalone chip), directly under the filename or directly above
the Metadata section — placement is a minor open call, default: directly
under the filename, above `dl.meta`, since it's the most identity-bearing
piece of context for the file (mirrors how `GalleryReferences.astro`'s
"Connected work items" list, lines 11–23, already sits as its own block
rather than inside a metadata table).

**Rationale:** zero new network calls, zero new latency, works within the
existing `default-src 'none'` CSP (a static chip needs no script — just the
existing `GitHubMark.astro` SVG import, which Astro inlines at build time).
Matches `GalleryReferences.astro`'s existing "linked work item" visual
vocabulary (`.refs .provider` + link) rather than inventing a third pattern.

**Alternative considered — live unfurl** (fetch title + open/closed/merged
state from `api.github.com` server-side during SSR): rejected as the
default. It would need: an unauthenticated GitHub API call per page render
(60 req/hr per IP, shared across every visitor hitting the API's outbound
IP — trivially exhausted), a timeout/fallback path when the call fails, and
either a new outbound `connect-src` in the CSP or moving the fetch
server-side (SSR-side fetch avoids the CSP concern, but not the rate limit or
latency — every file page load would block on a third-party round trip).
See Open Decision (a).

**Smaller alternative** — keep the two-piece layout but add the glyph:
`<GitHubMark /> {repo}#{number}` with the `.gh-kind` badge unchanged. Simpler
diff, but doesn't deliver "Notion-style chip" — worth calling out as a
fallback if the chip's visual weight feels wrong in review, not as the
primary recommendation.

### 3.2 Click-to-copy link cleanup

**Recommended approach:** reuse the exact pattern from
`apps/web/src/pages/account/index.astro` (lines 26–34, 58–79) and
`apps/web/src/pages/account/workspaces.astro` (lines 215, 305+): a
`data-copy="<value>"` attribute on a `<button>`, one delegated `click`
listener on a container (`await navigator.clipboard.writeText(...)`, swap the
button's `textContent` to `copied ✓` for 1500ms, silently no-op in the
`catch` since clipboard access can be blocked). Replace the current
`<label>` + readonly `<input>` (lines 150–153) with:

```html
<div class="linkfield">
  <label for="page-link">Page link</label>
  <div class="copyrow">
    <input id="page-link" type="text" readonly value="{canonical}" aria-label="Page link" />
    <button type="button" data-copy="{canonical}" aria-live="polite">Copy</button>
  </div>
</div>
```

Keep the `<input>` — it's still useful for people who want to select/edit
manually or for password-manager-style drag, and it degrades gracefully to
"select and Ctrl/Cmd+C" if JS is blocked or disabled (progressive
enhancement, same posture as the `auth_required` branch's script). The button
is the primary affordance; the input is the fallback, not vice versa.

**Rationale:** don't invent a third copy pattern when two pages already
established one. Consistency here also means any future account-page ↔
file-page shared component extraction (not proposed now, but plausible) has
one pattern to lift, not three.

**Requires:** widening `script-src` on the `ok` branch — see Open Decision
(d). This is the one feature in this doc that cannot ship script-free.

**Alternative considered** — `<input readonly>` with `onclick="this.select()"`
inline handler: rejected, `onclick=` attributes need `'unsafe-inline'`

- _event-handler_ allowance which is a bigger CSP hole than a `<script>`
  block, and it's a worse UX (select, then the user still has to know to hit
  Ctrl/Cmd+C — no "copied ✓" feedback).

### 3.3 Organize embed link types

**Recommended approach:** a single "Copy as" control — one `<select>` (or a
small segmented row of buttons for ≤4 options, cheaper to style than a
custom select) next to _one_ copy button, rather than N stacked readonly
inputs. Selecting a format updates a hidden value the copy button's
`data-copy` reads (or the click handler re-derives the string per selected
format from the same delegated listener as §3.2 — no extra script wiring). A
plain `<details>`/segmented-row shape (matching this page's existing
no-JS-required collapsible-free posture) is simpler to implement correctly
than a JS-driven tab panel and doesn't need any new CSS beyond what's already
token-based here.

Formats, gated by `kind(file.contentType)` (already computed via `fileKind()`
in `apps/web/src/lib/public-file.ts` lines 44–49):

| Format          | Value                                       | Shown when         |
| --------------- | ------------------------------------------- | ------------------ |
| Page link       | `canonical`                                 | always             |
| Direct file URL | `file.url`                                  | always             |
| Markdown image  | `![​](${embedSrc})`                         | `kind === "image"` |
| Markdown link   | `[${filename}](${canonical})`               | always             |
| HTML `<img>`    | `<img src="${embedSrc}" alt="${filename}">` | `kind === "image"` |

`embedSrc` = `file.embedUrl ?? file.url` — see the `embedUrl` gap below.
Video (`kind === "video"`) gets Page link / Direct URL / Markdown link only;
Markdown/HTML image forms don't apply. Non-previewable `file`/`unsupported`
kinds get the same three.

**The `embedUrl` gap.** `apps/api/src/routes/public-files.ts` does not
return `embedUrl` today (§1). Two ways to close it, in order of preference:

1. **Extend the API response** (preferred): add `embedUrl` to
   `public-files.ts`'s JSON, computed the same way `files-core.ts` /
   `routes/files.ts` already do it — `objectPublicUrls()` /
   `publicAndEmbedUrls()` in `apps/api/src/storage.ts` — instead of just
   `publicUrl()` (line 78). This is a small, additive, backward-compatible
   API change (new optional field), keeps `PublicFile`'s Zod-adjacent
   validator (`isPublicFile` in `apps/web/src/lib/public-file.ts`)
   symmetric with the authenticated DTOs, and keeps embed-host config
   (`EMBED_PUBLIC_BASE_URL`) where it already lives — server-side, in the
   API's env — rather than duplicating that env var into `apps/web`.
2. **Derive client-side in `apps/web`**: add `@uploads/storage` as a
   dependency of `apps/web` and call the pure `embedUrlFromPublic(file.url)`
   (`packages/storage/src/index.ts` lines 107–132) at render time. Rejected
   as the default — `apps/web` has "no storage bindings" by design (comment,
   `public-file.ts` line 4), and this would reintroduce exactly the kind of
   storage-layer coupling that design note exists to avoid, purely to save
   one API field.

Default: (1). See Open Decision (c) for the exact format list/layout, which
is the part that most needs a human call.

**Rationale for "one control, not four inputs":** four stacked readonly
inputs (the literal reading of "surface the different URL forms") is a wall
of near-identical text most visitors don't need — most file-page visitors
either grab the page link or the raw file URL, and Markdown/HTML forms are a
power-user path (mirrors how `packages/uploads/src/commands.ts` already
treats Markdown as an _opt-in_ output format, not the default `uploads put`
output). A single selector keeps the "actions" row's visual weight roughly
where it is today instead of tripling it.

**Alternative considered** — tabs (one visible field, format tabs above it):
functionally similar to the select/segmented-row option, more DOM/CSS for
the same outcome; only worth it if the format list grows past ~5, which
isn't the case here (YAGNI).

### 3.4 Download the file easily

**Investigation summary.** The `download` HTML attribute is a _client-side_
hint the browser is free to ignore, and both Chrome and Firefox ignore it for
cross-origin targets — which `file.url` always is (§1). A plain
`<a download href={file.url}>` today would just open the file, exactly as
"Open original ↗" already does. Confirmed no existing code path sets
`Content-Disposition` for public file bytes: they're served straight off the
R2 custom domain (`publicBaseUrl`), which has no Worker in front of it and no
per-request header override available on that domain. The one existing
`Content-Disposition: attachment` mechanism in this codebase
(`signedDownloadUrl()`, `packages/storage/src/index.ts` lines 170–180, used
by `apps/api/src/routes/me.ts`'s `/me/workspaces/:name/file-url`) only fires
when a workspace has **no** `publicBaseUrl` and falls back to provider
signing — i.e. it's the private/no-public-domain path, and it's
authenticated. It doesn't reach this page's case (a workspace with
`publicBaseUrl`, unauthenticated).

**Recommended approach — a new, small public API route that sets
`Content-Disposition` server-side, linked with a plain `<a>` (no JS).**
`Content-Disposition: attachment` is a _response header_ the browser honors
on navigation regardless of the origin serving it or whether the linking
page used the `download` attribute — unlike the HTML attribute, it isn't
subject to the cross-origin restriction. That means this needs no
`fetch`/blob/object-URL dance, no CORS configuration on the storage host, and
no CSP `connect-src` widening: `<a href={downloadUrl} rel="noopener noreferrer">Download</a>`
just works.

Concretely: add a `?download=1` query flag to the existing
`GET /public/files/:workspace/:key{.+}` handler in
`apps/api/src/routes/public-files.ts`, reusing the exact same
lookup/visibility gate as the existing handler (workspace record → `publicUrl`
existence check → `store.exists`/`head` → `objectVisibility` 401 gate), then
stream the bytes. A query flag rather than a `/download` suffix route, because
a static suffix after the greedy `:key{.+}` param is ambiguous — e.g.
`.../screenshots/download` could mean the suffix OR an object literally named
`screenshots/download` (the #158 lesson). `files-sdk` 2.1.0's `StoredFile`
(what `store.download(key)` resolves to) exposes `.stream()` — a
`ReadableStream<Uint8Array>` — so the route can pass that straight into a
`Response` without buffering the whole object in Worker memory:

```ts
new Response(stream, {
  headers: {
    "Content-Disposition": `attachment; filename="${encodeRfc5987(filename)}"`,
    "Content-Type": meta.type,
    // ...
  },
});
```

This mirrors `setObjectVisibility`'s existing use of `store.download()`
(`apps/api/src/files-core.ts` lines 261–265) but reads the stream instead of
`arrayBuffer()`.

**Tradeoff to name explicitly:** this moves file bytes from "served directly
off the R2 custom domain, zero Worker involvement" to "proxied through the
API Worker" for the download path specifically (not the inline-preview path,
which keeps using `file.url` unchanged). That's a real cost/latency
difference for large files and a new code path to keep correct (range
requests aren't needed here since it's a full-file download, but very large
files could bump into Worker response/CPU limits — worth a size gut-check
before this ships, not blocking the design). It only affects the _download_
action, which is opt-in and lower-traffic than inline preview, so the
tradeoff is contained.

**Why not client-side fetch → blob → object URL?** It would need
`Access-Control-Allow-Origin` on the storage host (not configured anywhere
in this repo — R2 custom domains don't send CORS by default and nothing here
sets it) _and_ widening the CSP's `connect-src` on the `ok` branch to include
the storage origin _and_ JS (same CSP cost as §3.2, but layered with an
additional cross-origin-fetch dependency the server-side option doesn't
need). Strictly more moving parts for the same result — rejected.

**Why not a dashboard-level Cloudflare Transform Rule** (force
`Content-Disposition` for a path pattern on the R2 custom domain)?
Rejected: disposition would be static per path, not per-request, so the same
URL couldn't serve both "inline preview" (`<img src>`, `<video src>`) and
"force download" — this page needs both from the same object. Out of code
review entirely (dashboard config, not this repo), and less discoverable /
harder to test than an API route.

See Open Decision (b).

## 4. RESOLVED DECISIONS

All four decisions below were **resolved to their recommended defaults** on
2026-07-14 (design approval). They are retained here with their rationale so
nobody re-litigates them. Summary: (a) **static chip**, (b) **build the
server-side download route**, (c) **five embed formats via a new `embedUrl`
API field**, (d) **accept the CSP `script-src` widening**.

**(a) GitHub chip: static vs. live unfurl.** → **RESOLVED: static.**
Static chip built from `GithubContext` (`repo`/`kind`/`number`/`url`) only —
no title, no open/closed/merged state, no live fetch.
_Recommended default: static._ Reasons: no rate-limit exposure (unauthenticated
GitHub API calls are 60/hr per source IP — shared across every visitor
hitting the API's egress IP, easily exhausted), no added latency on every
public file view, no new outbound dependency inside a CSP that's currently
`default-src 'none'`. Revisit only if product wants title/state badly enough
to justify a GitHub App token + caching layer — that's a materially bigger
project, not a polish pass.

**(b) Download mechanism.**
A `?download=1` query flag on the existing `GET /public/files/:workspace/:key{.+}`
API route (not a `/download` suffix — ambiguous after the greedy `:key{.+}`
param, the #158 trap) that streams bytes with `Content-Disposition: attachment`,
linked via a plain `<a>` (no client JS, no CSP change for this feature
specifically).
_Recommended default: yes, build this route._ Alternative (client-side
fetch→blob) needs CORS on the storage host plus a CSP `connect-src` widen and
is strictly worse on every axis investigated (§3.4). Flag if there's a
reason to avoid proxying bytes through the API Worker (cost/quota) that
outweighs the UX gain — in that case the fallback is "Open original ↗" stays
the only download affordance and this feature is dropped for now.

**(c) Embed format set and layout.**
Five formats — Page link, Direct file URL, Markdown image (image kind only),
Markdown link, HTML `<img>` (image kind only) — in a single "Copy as"
select/segmented-row control (§3.3), backed by adding `embedUrl` to
`apps/api/src/routes/public-files.ts`'s response.
_Recommended default: as listed._ Open sub-questions for the human:

- Include HTML `<img>` at all, or is Markdown-only enough for v1? (Markdown
  covers GitHub/most chat tools; HTML mainly matters for people embedding
  in raw HTML/CMS content — narrower audience.)
- Should "Direct file URL" prefer `embedUrl` (freshness-oriented Camo host)
  or the stable `url`? `packages/uploads/src/commands.ts` line 93 already
  documents "MARKDOWN prefers embedUrl for GitHub" as the CLI's convention
  — recommend mirroring that here: embed formats use `embedUrl ?? url`,
  but "Direct file URL" (the plain-URL option, not an embed snippet) stays
  the stable `url` since that's the one meant for long-lived linking.
- Confirm going with API route change (§3.3 option 1) over the
  `apps/web`-side derivation (option 2) — recommended default is option 1.

**(d) CSP `script-src` widening on the `ok` branch.**
Widen `PUBLIC_FILE_CSP`'s `script-src` for the file-found branch from
`https://static.cloudflareinsights.com` only, to
`'self' 'unsafe-inline' https://static.cloudflareinsights.com` — the same
posture `authRequiredFileCsp` already uses (lines 107–112) — scoped strictly
to enabling the click-to-copy button (§3.2) and the "Copy as" control (§3.3).
No `connect-src` widening needed (clipboard writes don't touch the network,
and the download control in §3.4 deliberately needs no script at all).
_Recommended default: accept the widening._ It's the same posture already
shipped and tested on the `auth_required` branch, it's inline-script-only
(no third-party script host added), and copy-to-clipboard is not
implementable without it. If this is rejected, §3.2/§3.3 degrade to
"readonly input, select-to-copy" (no button, no feedback, no format
switcher) — worth stating plainly as the fallback rather than silently
shipping a broken button.

## 4.5 Gallery items (per-item gallery page)

The same polish applies to the per-item gallery page
`apps/web/src/pages/g/[id]/[item].astro`, which is structurally a twin of the
file page: same media stage, a `.details` figcaption with filename/caption,
and today only an "Open original" link (line 104) — no copy, no embed, no
download. **Decision (2026-07-14): apply copy-link, embed formats, and
download to gallery items; keep GitHub attribution at the gallery level (the
existing `GalleryReferences` "Connected work items" block already rendered on
the item page, line 112). No per-item GitHub chip** — gallery items carry no
per-item GitHub context in the data model (`PublicGalleryItem` has
`filename`/`url`/`contentType`/`caption`; the projection in
`apps/api/src/gallery-service.ts` lines 251–263 has no `github`/`metadata`
per item), and associating it per item is a separate data-modeling project,
explicitly out of scope here.

What maps over, and the one API gap each needs:

- **Copy-link cleanup (§3.2):** applies directly. The item page already has a
  `canonical` page URL (line 39). Reuse the same `data-copy` button + delegated
  listener. Needs the gallery CSP widened (see below).
- **Embed formats (§3.3):** applies. **The API already returns `embedUrl` per
  gallery item** — `gallery-service.ts`'s public DTO includes it (line ~336,
  asserted in `apps/api/test/routes-galleries.test.ts` ~line 464). Only the
  **web** side drops it: add `embedUrl` to the `PublicGalleryItem` type +
  `isPublicGallery` validator in `apps/web/src/lib/public-gallery.ts`. So the
  gallery half of Decision (c) is **web-type-only** — no gallery API change
  (unlike the file page, whose public route genuinely lacks `embedUrl` and
  must be extended). Format list is gated by the item's
  `mediaKind` exactly as the file page gates on `fileKind`.
- **Download (§3.4):** applies. Add a gallery-item download route that streams
  bytes with `Content-Disposition: attachment`, reusing the **same shared
  streaming helper** as the file-page download route (§3.4). The gallery
  route resolves the item's `object_key` (known server-side —
  `gallery-service.ts` line 256 `objectKey`) within the gallery's workspace
  and applies the gallery's existing public-visibility gate, rather than
  taking a raw workspace+key from the URL. Route shape:
  `GET /public/galleries/:id/items/:item/download`.
- **GitHub chip (§3.1):** **not applied per item.** The gallery-level
  `GalleryReferences` block stays as-is. No change.

**CSP.** The gallery pages use `PUBLIC_GALLERY_CSP`
(`apps/web/src/lib/public-gallery.ts` lines 67–74), which is the same
`default-src 'none'` + `script-src <CF RUM only>` script-free posture as the
file page. Copy-link and "Copy as" on the item page need the **same
`script-src` widening decided in (d)**, applied to `PUBLIC_GALLERY_CSP` (or
just the per-item page's response) the same way. The download link needs no
script and no CSP change (same as §3.4).

**Shared code.** To avoid two divergent copies, extract the pure
embed-format-string builder (Decision (c)'s format table) into a testable
helper shared by both pages — natural home is alongside the existing
`fileKind`/`mediaKind` helpers, or a small shared `embed-formats.ts` both
`public-file.ts` and `public-gallery.ts` import. The two download routes share
one streaming helper (in `apps/api/src/files-core.ts`, next to the existing
`store.download()` usage). The `data-copy` copy-button inline-script pattern is
identical on both pages; keep it as the same small inline `<script>` on each
(no shared component — consistent with the "no `@uploads/ui` extraction"
non-goal), or lift it to a tiny shared client module if the duplication is
judged worth removing during implementation.

## 5. Accessibility & responsive notes

- GitHub chip: keep it a real `<a>` (not a `<button>` faking a link) so it's
  keyboard-reachable and shows up correctly in the accessibility tree as a
  link to an external site; `GitHubMark`'s `aria-hidden="true"` (already set
  in the component) means the chip's accessible name comes entirely from its
  text content (`{repo}#{number}` + kind) — don't add a redundant `alt`/`aria-label`
  on the icon.
  - `PR`/`Issue` text stays in the DOM as visible text (not `::before`
    content), so it's announced and stays copy-pasteable/selectable.
- Copy buttons: `aria-live="polite"` on the button (matching the existing
  pattern) so "copied ✓" is announced without stealing focus; keep the label
  swap on `textContent`, not a separate visually-hidden node, to match the
  existing pattern exactly (`account/index.astro` lines 69–73).
- "Copy as" selector: if built as a native `<select>`, it's free
  keyboard/screen-reader support; if built as a segmented button row, each
  button needs `aria-pressed`, and the group needs a `role="radiogroup"` or
  equivalent — this pushes towards the native `<select>` as the lower-risk
  default unless the visual design specifically wants a segmented look.
- Download link: plain `<a>`, no `aria-label` override needed beyond the
  existing "Download" text; keep it visually distinct from "Open original ↗"
  (different verb, different icon or none — don't reuse the ↗ external-link
  glyph, since download isn't "leaving the page" in the same sense).
- Responsive: the `.actions` row is already `flex-wrap:wrap` (line 90) with
  `.linkfield { flex:1; min-width:220px }` (line 93) — the chip, copy
  control, and download link should all fit into that same wrapping flex
  row without new breakpoints; verify at the existing `@media (max-width:760px)`
  cut (line 102) that the "Copy as" control doesn't force horizontal scroll
  on narrow viewports (the shell has no horizontal scroll anywhere today —
  don't introduce the first instance).

## 6. Testing approach

- **Unit (vitest):** extend `apps/web/src/lib/public-file.test.ts` for any
  new pure helpers (e.g. an embed-format-string builder, if extracted out of
  the `.astro` file into `public-file.ts` for testability — recommended,
  since `.astro` template logic is awkward to unit test directly). Extend
  `apps/api`'s route tests (pattern: `apps/api/test/routes-files.test.ts`,
  which already asserts `embedUrl` shape, e.g. line 158) with a test for the
  new download route: 200 with correct `Content-Disposition`/`Content-Type`
  for a public object, 401 `auth_required` for a private one (same gate as
  the existing metadata route), 404 for a missing key.
- **The #158 lesson — verify routing on a real preview worker, not just
  vitest.** #158 was a prod router mismatch (key-at-tail routes) that vitest
  didn't catch because the test harness didn't exercise the actual Wrangler
  router the way a real request path does. Before calling the download route
  done, hit it through a live `wrangler dev`/preview worker (not just the
  Hono app under vitest) with a real `key` containing a `/` and an extension,
  and confirm the browser actually saves the file (not just that the
  response object looks right in a test assertion).
- **Manual/visual check (recommended, not required):** load the file page in
  a real browser for one image object with a GitHub attachment and one
  without, confirm: chip renders and links out correctly; copy button copies
  the right string and shows feedback; "Copy as" switches formats correctly
  for an image vs. a non-image file; Download actually triggers a save
  dialog / lands in Downloads, not a new tab.
- No new CSP regression tests are optional — extend
  `public-file.test.ts`'s existing CSP assertions (lines 24–53) to cover
  whatever `script-src` ships per Open Decision (d), the same way
  `authRequiredFileCsp` is already tested.

## 7. Out of scope

- Live GitHub unfurl (title, state, avatar) — Open Decision (a) default is no.
- Any change to `apps/api`'s _authenticated_ file/gallery routes or their
  `embedUrl` computation — this only adds a matching field to the public
  route.
- Thumbnail/OG-image work, video poster frames, or any change to the media
  stage.
- A shared/extracted "copy button" or "chip" component in `@uploads/ui` —
  this stays plain Astro/inline-script, matching the rest of `apps/web`'s
  non-React surfaces; extraction is a follow-up if the pattern gets reused a
  third time, not a prerequisite here.
- Signed/expiring download links, download analytics/counting, or any
  rate-limiting on the new download route beyond what the existing public
  file lookup already has.
- Range-request support on the download route (full-file download only).
- **Per-item GitHub context on gallery items** (a per-item chip on the gallery
  page). Gallery items have no per-item GitHub association in the data model;
  adding one is a separate data-modeling project (§4.5). The gallery-level
  "Connected work items" block is unchanged.
- Any change to the gallery _index_ page (`g/[id].astro`) or its tiles — this
  touches only the per-item page (`g/[id]/[item].astro`).
