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

### 1. Facets API

One session-authed route in `apps/api/src/routes/me.ts`, member-gated exactly
as the sibling search route is, in two shapes:

```
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
run against D1 would silently miss every untagged file. Name matching therefore
runs against the object listing.

`GET /me/workspaces/:name/files/search` accepts a new `name` parameter,
alongside or instead of `meta.*`:

```
GET /me/workspaces/:name/files/search?name=hero
GET /me/workspaces/:name/files/search?name=hero&meta.app=web
```

Matching is a case-insensitive substring test against the object key.

**Composition.** When `name` and `meta.*` are both present, the D1 filter runs
first and the substring test narrows its results. This is cheaper than the
reverse and matches the semantics a user expects from stacked filters.

**Bounded scan.** With `name` alone, the route pages R2 through the existing
`listObjects` helper with a hard ceiling of 5,000 objects scanned, returning
the first 100 matches. Two flags come back:

- `truncated` — more than 100 matches were found
- `scanCapped` — the 5,000-object ceiling was reached before the workspace ended

`scanCapped` renders in the results footer as
`showing matches from the first 5,000 files — add a filter to narrow`. A
workspace above the ceiling gets partial results, labelled as partial. Exact
results at any scale would require an object index in D1; that is deliberately
out of scope here.

The existing rule that at least one filter is required stays, with `name` now
satisfying it. A request with neither `name` nor `meta.*` still 400s.

### 3. The typeahead

The input stays where it is and keeps its current behaviour. It gains a
suggestion menu.

**Empty input, on focus** — the workspace's own keys, with how many files carry
each and how many distinct values it has:

```
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

**No matches.** Unchanged from today's `No files match these filters.`, with
the `scanCapped` note appended when the ceiling was reached — so an empty
result never implies "nothing exists" when it might mean "not in the first
5,000".

### 5. Dead code

`MetadataSearchResults` and `WorkspaceFiles` are removed. Both duplicate the
filter logic this change rewrites, and neither is mounted by any page. Leaving
them would produce a third copy of a filter bar to drift out of sync.

## Testing

Vitest with in-process fakes, per the repo's runner.

**API.** Facet grouping, ordering, counts, and `distinctValues` against
fake-D1; the 50-key and
50-value caps and their `truncated` flags; `video.*` exclusion; workspace
scoping (one workspace's facets never leak into another's). Name matching:
case-insensitivity, substring rather than prefix, composition with `meta.*`,
the 5,000-object scan ceiling and its `scanCapped` flag, and the unchanged 400
when no filter is given at all.

**Client.** `searchWorkspaceFiles` with `name`, alone and combined; facets
fetch and its malformed-body and outage paths.

**Component.** Menu opens on focus and lists keys; key selection drills to
values; bare text offers name search first; `key=value` still commits without
touching the menu; empty-facets state renders the docs line; facets failure
degrades without breaking the input; keyboard navigation commits and dismisses.

**Manual.** Browser verification of the bar against the `default` workspace,
before and after, including a workspace with no metadata.

## Out of scope

- An object index in D1 for exact large-workspace name search
- OR / negation / range filters — the API is AND-of-equality and stays that way
- Ranking or relevance ordering
- Facets on the token-authed `/v1` route; this is a web-UI affordance
- Saved searches
