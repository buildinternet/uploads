# Workspace file search UX

**Date:** 2026-07-25
**Status:** Approved, not yet planned
**Surface:** `/account/workspaces/<name>` files tab

## Problem

The workspace files tab opens with a single input labelled
`filter key=value  (e.g. gh.repo=uploads)`. It is the only entry point to
metadata search, and it fails its users in three distinct ways.

It does not say which keys exist. Metadata keys are not a fixed schema —
`gh.repo`, `gh.kind`, `gh.number`, `gh.ref`, `gh.status` and `path` are
conventions stamped by `uploads attach` and `put --pr`, and everything else is
whatever a person or an agent chose to write. A user cannot discover that their
own workspace contains `app=web` by reading the placeholder, the docs, or the
source. The information exists only in D1, and nothing surfaces it.

It does not say which values exist. Even a user who knows `gh.repo` is a key
must guess whether the value is `uploads`, `buildinternet/uploads`, or
something else. The API stores lowercased `owner/name`; the placeholder shows
the bare repo. The example in the placeholder does not match the data.

It rejects the thing people actually type. Entering `hero.png` produces
`Use key=value (e.g. gh.repo=uploads).` The control looks like a search box,
sits where a search box sits, and answers a filename query with a syntax
lecture.

## What search is today

`findObjectsByMetadata` (`apps/api/src/file-metadata.ts:473`) performs
AND-of-equality matching over the `file_metadata` D1 table. Multiple filters
`INTERSECT`; a single filter takes an in-leg prefix. There is no substring
matching, no OR, and no ranking. Results cap at 100 in the session-authed
route.

Two routes expose it:

- `GET /v1/:workspace/files?meta.<key>=<value>` — token-authed
  (`apps/api/src/routes/files.ts:238`)
- `GET /me/workspaces/:name/files/search?meta.<key>=<value>` — session-authed,
  member-gated (`apps/api/src/routes/me.ts:400`)

The web UI uses the second, through `searchWorkspaceFiles`
(`apps/web/src/lib/api-client.ts:772`), with URL state in
`apps/web/src/lib/workspace-search-url.ts`.

One live component renders the bar: `WorkspaceFileTable`
(`apps/web/src/components/WorkspaceFileTable.tsx:657`). `MetadataSearchResults`
and `WorkspaceFiles` are dead code that duplicate the same filter logic.

Nothing today can report which keys or values a workspace contains.

## Design

Three changes: a facets API so the UI can name the fields that exist, filename
matching so bare text does something useful, and a typeahead that puts both in
front of the user without taking `key=value` away from anyone who already knows
it.

No new storage is introduced. Facets read the `file_metadata` table that already
exists; name matching goes through `files-sdk`'s `search()`, already a
dependency. An indexed object table was designed and deferred with an explicit
trigger — see "Why not an object index in D1".

### 1. Facets API

One session-authed route in `apps/api/src/routes/me.ts`, member-gated exactly
as the sibling search route is, in two shapes:

```text
GET /me/workspaces/:name/files/facets
  → { keys: [{ key: "gh.repo", count: 84, distinctValues: 6 }, …],
      truncated: false }

GET /me/workspaces/:name/files/facets?key=app
  → { key: "app", values: [{ value: "web", count: 40 }, …], truncated: false }
```

Stage one is

```sql
SELECT meta_key, COUNT(*) AS count, COUNT(DISTINCT meta_value) AS distinct_values
FROM file_metadata WHERE workspace = ? AND meta_key NOT LIKE 'video.%'
GROUP BY meta_key ORDER BY count DESC, meta_key ASC LIMIT 51
```

Stage two adds `meta_key = ?` and groups by `meta_value`. Both are served by the existing
`file_metadata_lookup_idx (workspace, meta_key, meta_value)`. Stage two is an
exact index-prefix seek, so its rows-read is proportional to the one key rather
than to the workspace. No migration is required.

Values are fetched lazily, only when a key is selected. A workspace with forty
keys costs one grouped query on open, not forty.

`distinctValues` tells the menu how useful a key is as a facet before anyone
clicks it: `app — 3 values` is worth drilling into, `path — 212 values` is
effectively unique per file and is better served by name matching. It comes
free from the same grouped scan, where a per-key top value would not — that
would need a nested group-by reading one row per file for exactly the
high-cardinality keys least worth showing.

**Caps.** 50 keys and 50 values per key, ordered by count descending then name
ascending. Each response carries `truncated`, and the menu renders it as
`50 of 340 values — type to narrow`. A cap that is hit is always stated.

**Reserved keys.** `video.*` rows are server-owned (`SERVER_META_PREFIXES`) and
are excluded from facets: they are not user-settable, so offering them as
filters would advertise a filter the user cannot reproduce on upload.

### 2. Filename matching

`file_metadata` holds rows only for files that have metadata, so a name search
run against it would silently miss every untagged file. R2 itself cannot help
directly: `list()` offers lexicographic prefix pagination and nothing else.

Name matching uses [`files-sdk`'s `search()`](https://files-sdk.dev/docs/api/search),
already a dependency of `packages/storage` (pinned `2.1.0` with a local patch)
and already the layer every storage call in this codebase goes through:

```ts
store.search(term, { match: "substring", caseInsensitive: true, maxResults: 101 });
```

It walks `listAll` and matches keys client-side, so it runs on every adapter
with no index and no per-provider capability check. The walk pages lazily and
`maxResults` stops it early, so a query with many matches costs a page or two
rather than a full traversal. The `Files` instance is already workspace-scoped
(`createStorage` applies the prefix), so the walk cannot cross a workspace
boundary.

**Name-only results are complete, not partial.** Unlike a hand-rolled bounded
scan, `store.search()` walks the full object list rather than sampling a
window, so a `name`-only query never returns a truncated view of the workspace
and needs no `scanCapped` flag: the only ceiling is the existing 100-result cap
with its `truncated` flag, which metadata search already has. What grows with
workspace size is latency, not correctness. Combining `name` with `meta.*`
changes this — see the completeness note under "The query" below.

#### Why not an object index in D1

An indexed `file_objects` table — write-through on the upload path, modelled on
the existing `file_content_hash` index — was designed and rejected for now.

The write-through half is genuinely cheap: roughly twenty lines mirroring
`recordContentHash`, at the two sites that already write `file_metadata`. The
repair half is not. Repair would lean on `reconcileWorkspaceUsage`
(`apps/api/src/reconcile.ts:29`), which walks every object and rewrites a D1
ledger — but nothing runs it for most workspaces. The daily cron runs
`runRetentionSweep`, which reaches reconcile only for workspaces with retention
configured (`apps/api/src/retention.ts:94`); everything else is reconciled only
when the usage route is called by hand. Making repair universal means walking
every object of every workspace daily, which costs more than the scan it would
replace.

So the index would add a second source of truth about which objects exist,
whose drift is repaired on no schedule. A scan's cost is bounded and visible —
a slow query. An index's cost is unbounded and invisible — a file missing from
search, reported weeks later. At current scale the insurance is not worth the
premium.

**When to revisit.** The trigger is latency, and it is observable: when the
largest workspace approaches ~10,000 objects, a full walk crosses roughly ten
sequential `list()` pages and name search starts to feel slow. At that point
build `file_objects` _and_ its scheduled repair together, costing both — not the
write-through alone.

Two things make that later change cheap rather than a rewrite. The route
contract does not change: `?name=` in, the same result shape out, so only the
resolver behind it is swapped. And `search()` remains the correct path for
BYO-storage whenever it lands — objects arriving in a user's own bucket never
touch this API, so an index would be structurally incomplete there rather than
merely stale, and no amount of write-through fixes that.

#### The query

`GET /me/workspaces/:name/files/search` accepts a new `name` parameter,
alongside or instead of `meta.*`:

```text
GET /me/workspaces/:name/files/search?name=hero
GET /me/workspaces/:name/files/search?name=hero&meta.app=web
```

Matching is a case-insensitive substring test against the object key.

**Composition.** Two short paths rather than one query shape, which is the price
of not having an index:

- `name` alone → `store.search(...)` with `maxResults` at the result cap + 1.
- `name` with `meta.*` → the existing `findObjectsByMetadata` runs first, and
  its results are substring-filtered in memory. The D1 filter is the selective
  one and caps at 100 rows, so this never walks storage at all.

Both paths return the same shape. The second is strictly cheaper than the
first, so adding a metadata filter always makes a name search faster — which is
also the advice the UI gives when results are truncated.

Results cap at 100 with the existing `truncated` flag, as metadata search
already does. There is no silent truncation on either path — a cap that is hit
is always reported — but the two paths differ in what that flag means. The
`name`-only path is genuinely complete up to its cap: `store.search()` walks
every object, so `truncated` only fires once results already exceed 100. The
combined path is not: `findObjectsByMetadata` caps its candidate window at
`SEARCH_LIMIT + 1` rows ordered by `object_key` _before_ the name filter runs,
so the name filter narrows a capped window rather than the full match set.
`truncated` correctly reports when that window is exceeded, so nothing is
silently dropped, but the combined path is a bounded view of the candidate
space, not a complete one — only the `name`-only path can claim that.

The existing rule that at least one filter is required stays, with `name` now
satisfying it. A request with neither `name` nor `meta.*` still 400s.

**Validation.** `name` is trimmed, capped at 128 characters, and rejected when
empty after trimming. It is passed to `search()` as a `substring` pattern, never
as `glob` or `regex` — a user-supplied regex would be a denial-of-service
vector, and glob would make `*` and `?` silently meaningful in a box where
people type filenames.

### 3. The typeahead

The input stays where it is and keeps its current behaviour. It gains a
suggestion menu.

**Empty input, on focus** — the workspace's own keys, with how many files carry
each and how many distinct values it has:

```text
gh.repo    84 files    6 values
path      212 files  212 values
app        40 files    3 values
```

A key whose `distinctValues` equals its `count` is unique per file; the menu
marks it as such rather than offering a 212-item value list.

This single view is what answers "which fields exist", and it answers it with
the user's data rather than with documentation.

**Bare text** — the first row is `name contains "hero"`, and below it any keys
or values matching the text. Typing `gh` surfaces `gh.repo`, `gh.number`,
`gh.status`.

**After selecting a key** — that key's real values with counts, narrowing as
the user types. Selecting a value commits the filter.

**Typing `key=value`** — unchanged. Enter commits directly, the menu stays out
of the way, and no existing muscle memory breaks.

The placeholder softens from `filter key=value  (e.g. gh.repo=uploads)` to
`Filter by name, or key=value…`. The menu footer carries the syntax hint
inline, so the format is taught by the control at the moment of use rather than
by a document the user has to go find.

**Keyboard and a11y.** Standard combobox: ↑/↓ to move, Enter to commit, Esc to
close, `role="combobox"` with `aria-expanded` and `aria-activedescendant`,
options as `role="option"`. The menu is reachable and dismissible without a
mouse.

**Fetch discipline.** Keys are fetched once per workspace on first focus and
cached for the session. Values are fetched per key on first selection and
cached the same way. Neither is refetched on keystroke — narrowing is
client-side over the cached list, which is why the caps and their truncation
notes matter.

### 4. States

**Workspace with no metadata.** New workspaces have no `file_metadata` rows at
all. The menu shows `name contains …` plus one line: metadata filters appear
once files are uploaded with tags, linking to the `attach` / `put --pr` docs.
This is the one place a docs link earns its keep — a permanent link on a bar
that already works would be noise.

**Facets request fails.** The menu degrades to the syntax hint alone. The input
keeps working and `key=value` still commits. A facets outage never blocks
filtering.

**No matches.** Unchanged from today's `No files match these filters.` With no
scan ceiling, an empty result now means the workspace genuinely has no match,
so the message needs no qualifier.

### 5. Dead code

`MetadataSearchResults` and `WorkspaceFiles` are removed. Both duplicate the
filter logic this change rewrites, and neither is mounted by any page. Leaving
them would produce a third copy of a filter bar to drift out of sync.

## Testing

Vitest with in-process fakes, per the repo's runner.

**Facets.** Grouping, ordering, counts, and `distinctValues` against fake-D1;
the 50-key and 50-value caps and their `truncated` flags; `video.*` exclusion;
workspace scoping (one workspace's facets never leak into another's).

**Name search.** Case-insensitivity; substring rather than prefix or glob
(`re*ort` matches nothing, `report` matches `weekly-report.png`); the
`maxResults` early stop yields the cap without exhausting the walk; the
`name`-plus-`meta.*` path filters D1 results without touching storage; the
unchanged 400 when no filter is given at all; `name` validation (trimmed,
length-capped, empty rejected).

**Client.** `searchWorkspaceFiles` with `name`, alone and combined; facets
fetch and its malformed-body and outage paths.

**Suggestion logic.** The repo's Vitest setup is node-only — no jsdom, no
`@testing-library/react` — so React components cannot be rendered in a test.
Every menu decision therefore lives in a pure `workspace-search-suggest.ts`
module, following the existing `workspace-file-row.ts` /
`workspace-search-url.ts` pattern, and is unit-tested there: which rows an
empty draft produces, bare text offering name search ahead of matching keys,
`key=` drilling to that key's values, already-filtered keys never offered
twice, the empty-facets row, and the degraded row set when facets fail to load.

The component keeps only focus, fetching, and keyboard wiring — thin enough
that browser verification covers it.

**Manual.** Browser verification of the bar against the `default` workspace,
before and after, including a workspace with no metadata.

## Out of scope

- OR / negation / range filters — the API is AND-of-equality and stays that way
- Ranking or relevance ordering; D1 supports FTS5 if that changes
- Facets on the token-authed `/v1` route; this is a web-UI affordance
- Saved searches
- A `file_objects` D1 index and its scheduled repair — designed, deferred, with
  a stated trigger (see "Why not an object index in D1")
- R2 Event Notifications → Queue consumer; it belongs with the index, and only
  once writes can bypass this API

### Cloudflare AI Search — evaluated, set aside

[AI Search](https://developers.cloudflare.com/ai-search/configuration/data-source/r2/)
indexes an R2 bucket for semantic retrieval, and it does handle images: two
Workers AI models perform object detection and summarization, converting each
image to markdown before embedding. For a product built around screenshots,
"find the shot of the checkout error" without anyone having tagged it is a real
and appealing capability.

It is not a fit for this work, on four counts:

**It cannot see the metadata in question.** AI Search filters on `x-amz-meta-*`
R2 custom metadata — this codebase's _provenance_ tier, which `file-metadata.ts`
keeps deliberately unqueryable and server-controlled. The user-facing tags
(`gh.repo`, `app`, `path`) live in D1 and are absent from R2 custom metadata.
Filtering on them would require mirroring the D1 tier into R2 on every upload,
inverting the separation #511 established.

**Workspace isolation would become procedural.** Uploads share one bucket with
per-workspace prefixes, so a single AI Search instance spans every workspace,
and isolation would rest on every query carrying a correct filter — over a
corpus that includes private files. Today's search is workspace-scoped in SQL
behind a member gate, and fails closed. Per-workspace instances would restore
that property and are the shape any future exploration should start from.

**Cost scales with uploads.** Two Workers AI invocations per indexed image,
against a free tier permitting 10,000 uploads a month.

**Coverage and freshness.** A 4 MB file cap excludes video and large captures,
and indexing latency is undocumented — awkward for a loop where a file is
uploaded and referenced seconds later.

None of this rules it out as a _separate_ feature: semantic screenshot search,
likely paid-tier, on per-workspace instances, with workspace isolation reviewed
before any code. It is orthogonal to facets, filename search, and the typeahead,
and solves none of the three problems this spec addresses.
