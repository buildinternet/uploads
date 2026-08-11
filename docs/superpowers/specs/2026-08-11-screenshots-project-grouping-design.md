# Screenshots page: project-aware grouping

Date: 2026-08-11
Status: approved (brainstormed with Zach)
Builds on: 2026-08-10-screenshots-by-path-design.md

## Problem

The Screenshots page groups purely by the `path` metadata key. Paths from
different repos/sites interleave (`/admin/inventory` from one project next to
`/admin/oauth` from uploads), and same-named paths from different projects
merge into a single group. There is also no record of which git repo a
screenshot was captured from — a gap independent of this page.

## Design

### 1. Project label (server-side only)

Each file resolves to a **project label** by coalescing, in order:

1. `repo` metadata (new derived key, below)
2. `gh.repo` metadata (already present on attached/branch-staged files)
3. the origin (host) parsed from the `url` metadata
4. otherwise the literal bucket `"Other"`

The label is computed **only where grouping happens** (the by-path
aggregation) plus one small mirrored client helper for drill-in filtering
(see §4). It is a display/grouping label, not stored metadata. No aliasing,
no localhost→repo inference, no backfill: the same project may appear as an
origin label for old files and a repo label for new ones; recency resolves
this over time.

### 2. CLI: derived `repo` key

- Add `repo` to `CANONICAL_META_KEYS` in `packages/uploads/src/metadata-vocab.ts`.
- Derived at upload time by `uploads screenshot` and `uploads put` from the
  git remote slug of the cwd: `owner/name`, lowercase — same convention as
  `gh.repo`.
- Suppressed by `--no-git` (it is git-derived).
- Hand-supplied `--meta repo=` wins, per the existing replace-vs-preserve
  contract. Value validated with the same shape check as `gh.repo`
  (`isValidRepo`).

### 3. API: project-aware `files/by-path`

Extend the existing `GET /:workspace/files/by-path` aggregation
(`groupObjectsByPath`) to group by **(project label, path)** instead of path
alone. Additive response shape:

- each group gains a `project` field (the label);
- top-level `projects` array: `{ label, count, lastUpdated }`, ordered by
  recency, so the client can render section headers and the overview's
  "recently active" ordering without re-deriving.

No new endpoint. Files with no `path` metadata but with GitHub context keep
surfacing (the current "From GitHub" query) — but the section folds into its
project by label rather than staying a separate catch-all; the GitHub search
results are bucketed client-side with the mirrored helper.

### 4. Web UI: overview + project view

Single fetch (the extended by-path payload) drives both views:

- **Overview** (default): one nested section per recently active project,
  ordered by project recency. Each section previews its top 2–3 path groups
  (by recency) with a "view project →" link. Same-named paths from different
  projects no longer merge.
- **Project view** (`?project=<label>`, URL-synced like `?path=` today):
  the overview filtered to one project's sections — all of that project's
  path groups. No new search capability; it is a client-side filter over the
  same payload.
- **Path drill-in** (`?project=<label>&path=<path>`): reuses
  `files/search?meta.path=…`, then filters items to the project label
  client-side using a small mirrored label helper (coalesce over each item's
  `repo`/`gh.repo`/`url` metadata, which search already returns). The helper
  is ~5 lines, duplicated per the page's existing "reimplement rather than
  export" convention, with tests on both sides pinned to the same cases.
- Bare `?path=` (old shared links) still works: drill without a project
  filter.

### Out of scope (deliberate)

- Project renaming/aliasing or merging origin-labeled and repo-labeled
  buckets for the same project.
- URL-prefix search affordances on `files/search`.
- Backfilling `repo` metadata onto existing files.
- Filter chips beyond the project view itself.

## Error handling

Unchanged from the current page: by-path failure → error callout with retry;
GitHub search failure renders nothing; drill failure → per-view callout.
Unknown `?project=` label renders the project view's empty state.

## Testing

- CLI: derived `repo` present/absent (no remote, `--no-git`, hand-supplied
  override) in the capture-facts/sidecar tests.
- API: by-path grouping splits same path across projects; precedence
  (repo > gh.repo > origin > Other); `projects` ordering; origin parsing of
  bad/missing `url`.
- Web: label helper parity cases; overview section rendering; project view
  filtering; URL sync for `?project=` / `?project=&path=`; legacy `?path=`.
