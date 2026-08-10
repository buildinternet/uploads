# Screenshots-by-path browsing

**Date:** 2026-08-10
**Status:** Approved design, pre-implementation
**Related:** #361 (metadata vocabulary), #365/#370 (path/state in the managed comment), #613 (API surface consolidation — deliberately out of scope here)

## Purpose

Members want to browse what screenshots exist for a given part of the app: "show me recent screenshots grouped by the page they capture." The `path` metadata key (from #361, set automatically by `uploads screenshot`) already records this; the facets and search APIs can already query it. What's missing is a discovery surface — today you can type `path:/settings` into the file table's search only if you already know the path exists.

## What ships

A **Screenshots page** in the workspace shell (`/account/workspaces/:name/screenshots`), plus **one new session API route** that answers "which paths have files, ordered by recent activity, with each path's most recent keys."

### API

`GET /me/workspaces/:name/files/by-path` in `apps/api/src/routes/me.ts`, same member auth as the sibling `files/search` route. Ships at the current session-route convention on purpose; it migrates with everything else under #613.

Backed by a new function in `apps/api/src/file-metadata.ts` running a single windowed D1 query over `file_metadata WHERE workspace = ? AND meta_key = 'path'`:

- `ROW_NUMBER() OVER (PARTITION BY meta_value ORDER BY updated_at DESC)` filtered to `rn <= 6` (recent keys per group)
- `COUNT(*) OVER (PARTITION BY meta_value)` (group size)
- `MAX(updated_at) OVER (PARTITION BY meta_value)` (group recency; groups ordered by it, descending)
- capped at 50 groups, `truncated: true` when the cap hits

The query rides the existing `(workspace, meta_key, meta_value)` index and reads only `path` rows, so rows-read scales with path-tagged files, not the whole metadata table. For `path` rows, `updated_at` is effectively upload time (the key is written at upload), which is what "recent" should mean here.

A second bulk read via the existing `getMetadataForKeys` on the surfaced keys (≤ 300) supplies `state` for badges.

Response shape:

```json
{
  "groups": [
    {
      "path": "/settings",
      "count": 14,
      "lastUpdated": "2026-08-09T21:14:03Z",
      "recent": [{ "key": "shots/settings-a3f9.webp", "state": "after" }]
    }
  ],
  "truncated": false
}
```

`state` is present only when set. No other metadata keys are returned.

### Web

New page `apps/web/src/pages/account/workspaces/[name]/screenshots.astro` in `WorkspaceLayout`, with a "Screenshots" entry in the workspace rail. It mounts a React island, `ScreenshotsByPath.tsx`, the same lazy way the files page mounts `WorkspaceFileTable` (account pages are the one place framework JS is allowed).

**Grouped feed (default view).** One scrollable page. Each group renders a header row — path, count, relative last-updated, "view all" — over a strip of its recent thumbnails. Groups appear in the API's order (most recent activity first).

**Thumbnails** reuse the machinery already in `WorkspaceFileTable`: `pickThumbnail`, public file URLs when the workspace `hasPublicUrl`, the signed `/me/workspaces/:name/file-url` endpoint otherwise, generic tile for non-image files. Thumbnails carry a small `before`/`after` badge when `state` is set. **No pairing layout** — recency order stays honest; before/after pairing already exists on `/f/` pages and in the managed comment.

**Drill-in.** Clicking "view all" (or the group header) stays on the page with `?path=…` and renders a full grid for that path, fetched from the **existing** `/files/search?meta.path=…` route — no second new endpoint. Clicking a thumbnail opens the file page (public `/f/` route or signed URL, matching the file table's behavior).

### Scope and degradation

- **Only files with a `path` metadata value appear.** Files without it (including every pre-#361 upload) are simply absent; the page is honestly metadata-driven. No "ungrouped" bucket.
- **Empty state** for workspaces with zero path-tagged files explains that `uploads screenshot` sets `path` automatically and any upload can pass `--meta path=/x`.
- Non-image files with a `path` value do appear (generic tile) — the grouping is by path, not by content type.

## Explicitly out of scope

- Before/after pairing layout on this page.
- Any token-route or hosted-MCP equivalent of `by-path` (add later if agents want it; the CLI already has `meta find`).
- The API path consolidation (#613).
- Auto-galleries per path (previously rejected; this page is a query view, not stored collections).

## Testing

- Query-shape tests for the new `file-metadata.ts` function beside the existing facet tests (fake-D1 pattern): grouping, ordering by group recency, per-group cap, group cap + `truncated`, empty workspace.
- Route test in `me.test.ts`: auth required, membership required, response shape, `state` enrichment present/absent.
- Web: component tests only where existing table tests give precedent; otherwise verify in the browser (stack-raw signed-in recipe).
