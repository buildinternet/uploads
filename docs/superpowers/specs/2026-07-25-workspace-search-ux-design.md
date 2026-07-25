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

Filename matching carries a fourth, structural piece — an object index in D1 —
because R2 cannot answer the question and scanning it per query would put a
permanent ceiling on the feature. That index is cheaper than it sounds: the
write path and the repair walk both already exist.

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

### 2. Filename matching, on an object index

`file_metadata` holds rows only for files that have metadata, so a name search
run against it would silently miss every untagged file. R2 itself cannot help:
`list()` offers lexicographic prefix pagination and nothing else. Object stores
have no search, and every system that searches one maintains a separate index —
S3 with Event Notifications into DynamoDB, GCS with Pub/Sub, R2 with
[Event Notifications into Queues](https://developers.cloudflare.com/r2/buckets/event-notifications/).

Scanning R2 per query was considered and rejected. It would have meant a
5,000-object ceiling, partial results on large workspaces, and a `scanCapped`
flag in the UI — a permanent cap accepted to avoid building an index that this
codebase is already 90% set up for.

#### The `file_objects` table

A new D1 table, modelled directly on `file_content_hash`
(`apps/api/migrations/20260724140000_file_content_hash.sql`) — the existing
`(workspace, object_key)`-keyed index maintained on the upload path:

```sql
CREATE TABLE file_objects (
  workspace     TEXT NOT NULL,
  object_key    TEXT NOT NULL,
  leaf_name     TEXT NOT NULL,  -- lowercased basename, for matching
  size          INTEGER NOT NULL,
  content_type  TEXT,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (workspace, object_key)
);

CREATE INDEX file_objects_name_idx ON file_objects (workspace, leaf_name);
```

`leaf_name` is stored lowercased so matching needs no `LOWER()` on the column
and stays index-eligible for prefix queries. Substring queries
(`leaf_name LIKE '%hero%'`) scan the workspace's rows — bounded by one
workspace's object count, not the account's, and cheap at any plausible size.
FTS5 is available in D1 if ranking is ever wanted, but it is not needed here and
is not specced.

#### Keeping it in sync

Three layers, in descending order of how much work they do:

**Write-through** is the primary path. Every write already touches D1:
`putObject` writes `file_metadata` and `file_content_hash`
(`apps/api/src/files-core.ts:517`, `:531`), and `deleteObject` deletes
`file_metadata` (`apps/api/src/files-core.ts:813`). The index row is written
and deleted in exactly those two places, plus
`deleteFileMetadataForWorkspace`'s sibling in `workspace-teardown.ts:71`.

Writes are best-effort and wrapped, exactly as `recordContentHash` is: a failed
index write must degrade to a stale index, never to a failed upload. Unlike the
content-hash index, staleness here is visible to users — which is what the next
layer is for.

**Repair** reuses `reconcileWorkspaceUsage`
(`apps/api/src/reconcile.ts:29`). It already walks every object under a
workspace prefix with `listAll()` and rewrites a D1 ledger from
storage-as-source-of-truth. The same walk rewrites the index: rows for keys
seen, deletion of rows for keys absent. This is both the backfill for existing
workspaces and the ongoing drift repair, and it is already wired into retention
and exposed as a tool. No new walk is written.

**Drift detection** — R2 Event Notifications into a Queue with an idempotent
consumer — is **deliberately deferred**. It earns its place only when writes can
bypass the API: BYO-storage, or direct S3 credentials. Neither exists today, so
a consumer would be infrastructure with no drift to catch. Recorded here so the
deferral is a decision rather than an oversight.

#### Why not `files-sdk` `search()`

[`files-sdk` ships a `search()`](https://files-sdk.dev/docs/api/search) that
matches object keys by glob, regex, substring, or exact pattern, and this repo
already depends on it (`packages/storage`, pinned at `2.1.0` with a local
patch). It is built on `listAll` with client-side matching, so it works on every
adapter and needs no index.

It is not used for the search hot path, for the same reason the R2 scan was
rejected: it walks every object per query. The pattern syntax is nicer than a
hand-rolled scan, but the cost profile is identical to the design this spec
replaces.

It is, however, the correct **fallback for storage this index cannot see**. When
BYO-storage lands, objects can arrive in a user's bucket without passing through
this API, so `file_objects` would be structurally incomplete rather than merely
stale — and no amount of write-through fixes that. `search()` is the answer
there, already in the dependency tree, already adapter-agnostic. That is what
makes deferring event notifications safe: the fallback exists before the
scenario does.

#### The query

`GET /me/workspaces/:name/files/search` accepts a new `name` parameter,
alongside or instead of `meta.*`:

```
GET /me/workspaces/:name/files/search?name=hero
GET /me/workspaces/:name/files/search?name=hero&meta.app=web
```

Matching is case-insensitive substring against `leaf_name`.

**Composition.** With both `name` and `meta.*`, the two are joined in one
statement — `file_metadata` INTERSECT legs joined to `file_objects` on
`(workspace, object_key)` — rather than filtered in application code. One query,
one round trip.

There is no scan ceiling and no `scanCapped` flag. Results cap at 100 with the
existing `truncated` flag, as metadata search already does.

The existing rule that at least one filter is required stays, with `name` now
satisfying it. A request with neither `name` nor `meta.*` still 400s.

**Index freshness.** A best-effort write means a file can occasionally be
missing from name results while present in folder browse. Folder browse reads
R2 directly and is unaffected, so the file is never invisible — only
occasionally unsearchable until the next reconcile. This is the accepted
trade for never failing an upload on index maintenance.

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

**Name search.** Case-insensitivity, substring rather than prefix, composition
with `meta.*` in one statement, the unchanged 400 when no filter is given at
all.

**Index maintenance.** A put inserts a row and an overwrite updates it in place
rather than accumulating a second; a delete removes it; workspace teardown
removes all of a workspace's rows; a failing index write does not fail the
upload; `reconcileWorkspaceUsage` both backfills rows for objects it finds and
deletes rows for keys no longer in storage. The reconcile test is the one that
matters most — it is the whole drift story.

**Client.** `searchWorkspaceFiles` with `name`, alone and combined; facets
fetch and its malformed-body and outage paths.

**Component.** Menu opens on focus and lists keys; key selection drills to
values; bare text offers name search first; `key=value` still commits without
touching the menu; empty-facets state renders the docs line; facets failure
degrades without breaking the input; keyboard navigation commits and dismisses.

**Manual.** Browser verification of the bar against the `default` workspace,
before and after, including a workspace with no metadata.

## Out of scope

- OR / negation / range filters — the API is AND-of-equality and stays that way
- Ranking or relevance ordering; D1 supports FTS5 if that changes
- Facets on the token-authed `/v1` route; this is a web-UI affordance
- Saved searches
- R2 Event Notifications → Queue consumer (see "Keeping it in sync")

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

**Tenancy would become procedural.** Uploads share one bucket with
per-workspace prefixes, so a single AI Search instance spans every tenant, and
isolation would rest on every query carrying a correct filter — over a corpus
that includes private files. Today's search is workspace-scoped in SQL behind a
member gate, and fails closed. Per-workspace instances would restore that
property and are the shape any future exploration should start from.

**Cost scales with uploads.** Two Workers AI invocations per indexed image,
against a free tier permitting 10,000 uploads a month.

**Coverage and freshness.** A 4 MB file cap excludes video and large captures,
and indexing latency is undocumented — awkward for a loop where a file is
uploaded and referenced seconds later.

None of this rules it out as a _separate_ feature: semantic screenshot search,
likely paid-tier, on per-workspace instances, with tenant isolation reviewed
before any code. It is orthogonal to facets, filename search, and the typeahead,
and solves none of the three problems this spec addresses.
