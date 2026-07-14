# Metadata Search UI — Design

**Date:** 2026-07-14
**Status:** Approved design, pre-implementation
**Tracking:** [#159](https://github.com/buildinternet/uploads/issues/159) — "Web search UI" follow-up to per-file metadata (#157/#158)

## Summary

Per-file metadata shipped in #157 with a proven filter path over the CLI and MCP,
but it is only reachable from the terminal today. This adds a **metadata search
surface to the web**, folded into the existing per-workspace file browser on
`/account/workspaces`. A user adds `key=value` filter chips; matching files render
in a flat results list. It requires one thin **session-authed API endpoint** plus
two new front-end components; the existing folder browser is left untouched.

## Goals

- Let a signed-in member find files in a workspace by their `gh.*`/custom metadata,
  using the same AND-of-equality semantics the CLI/MCP already expose.
- Reuse the proven `validateMetadataFilters` / `findObjectsByMetadata` helpers — no
  new query engine, no new validation rules.
- Keep the change additive: no regression to folder browse, visibility toggles, or
  deep-link restore.

## Non-goals (explicitly deferred)

- **Cross-workspace search.** The metadata index and its API are per-workspace;
  search stays per-workspace.
- **Value/key autocomplete.** There is no "distinct metadata values" endpoint, and
  adding one is out of scope. The filter UI is manual key/value entry.
- **Visibility toggle in results.** Metadata-filtered listings carry no `visibility`
  annotation (it lives in R2 custom metadata; hydrating costs a HEAD per result —
  documented caveat in #159). Results are read-only; the toggle stays in browse mode.

## Current state

- `/account/workspaces` ([`workspaces.astro`](../../../apps/web/src/pages/account/workspaces.astro))
  is a vanilla-JS page that renders a `<li>` per workspace and, for each
  non-communal workspace, mounts a **React island** `AccountFileBrowser` into the
  `[data-files]` slot.
- [`AccountFileBrowser.tsx`](../../../apps/web/src/components/AccountFileBrowser.tsx)
  is folder-aware, backed by `files-sdk`'s `useFiles` hook against
  `/me/workspaces/:name/file-browser`. It also owns the per-row public/private
  visibility toggle.
- The `meta.<key>=<value>` filter lives on the **token-authed**
  `/v1/:workspace/files` route ([`files.ts`](../../../apps/api/src/routes/files.ts),
  `requireScope("files:read")`) — a browser cookie session cannot reach it.
- The `/me/*` routes ([`me.ts`](../../../apps/api/src/routes/me.ts)) are
  session-cookie-authenticated (`sessionAuth`, `requireSessionUser`).
- Deep-link restore for `?ws=&path=` is handled by
  [`workspace-browse-url.ts`](../../../apps/web/src/lib/workspace-browse-url.ts).

## Architecture

### Component structure

| Component                         | Responsibility                                                                                                                                                                                                  |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WorkspaceFiles.tsx` (new)        | Wrapper mounted per workspace. Owns `mode: "browse" \| "search"`. Always renders the filter bar; renders `<AccountFileBrowser>` when no filters are active, `<MetadataSearchResults>` when filters are present. |
| `MetadataSearchResults.tsx` (new) | Filter-chip state, fetch against the new search endpoint, and the flat results list with its loading/empty/error/truncated states.                                                                              |
| `AccountFileBrowser.tsx`          | **Unchanged** — remains the sole owner of folder browse + visibility.                                                                                                                                           |

`workspaces.astro` changes by one line: mount `WorkspaceFiles` instead of
`AccountFileBrowser`, passing the same props (`apiOrigin`, `workspace`,
`hasPublicUrl`, `initialPrefix`, `onPrefixChange`) plus the initial filter state
parsed from the URL.

Rationale: keeping `AccountFileBrowser` single-purpose (per the isolation
principle) means search cannot regress folder browse, and each piece is testable
alone. The wrapper holds only the mode decision.

### Backend — new session endpoint

Add to [`me.ts`](../../../apps/api/src/routes/me.ts):

```
GET /me/workspaces/:name/files/search?meta.<key>=<value>&...
  → 200 { items: [{ key, url, embedUrl, metadata }], truncated: boolean }
```

- **Auth/gating:** inherits `sessionAuth` + `requireSessionUser` from the `/me/*`
  mount; resolves the workspace via the existing `memberWorkspaceOr404`. Communal
  workspace → `{ items: [], truncated: false }` (consistent with the existing
  `/files` communal short-circuit).
- **Filter parsing/validation:** collect `meta.*` params exactly as the token route
  does (`files.ts` lines ~146–162): reject a repeated same-key param with
  `ValidationError` code `file_metadata_duplicate_filter`, then call the shared
  `validateMetadataFilters(filters)` (key format, filter count cap). No new
  validation rules.
- **Query:** `findObjectsByMetadata(DB, workspaceName, filters, { prefix, limit })`,
  the same helper the token route calls. `prefix` optional (reserved; not surfaced
  in the UI initially).
- **Limit/truncation:** cap `limit` at **100**. Request `limit + 1` internally (or
  compare returned length to the cap) to set `truncated: true` when more matches
  exist, so the UI can prompt the user to narrow.
- **Response shape:** `{ key, url, embedUrl, metadata }` per item — mirrors the
  token route's projection (`objectPublicUrls` → `url`/`embedUrl`). No `visibility`
  (accepted caveat).

**Routing safety:** `:name` is a single-segment param (`[a-z0-9-]`), so the
`files/search` static suffix does **not** hit the #158 `{.+}`-param-then-static-suffix
trap. Still verify on a preview worker per that lesson.

New endpoint (dedicated `files/search`) rather than overloading the existing
`GET /me/workspaces/:name/files` return contract — clearer shape, no risk to any
existing `/files` caller.

## Filter UX — key/value chips

- A **"Filter by metadata"** bar above the file area: a `key` input, a `value`
  input, and an **Add** button. Each added pair becomes a removable chip rendered
  as `key=value ×`. Multiple chips **AND** together (matches the API).
- **Client-side validation before firing:** mirror the shared key regex
  (`^[a-z][a-z0-9._-]{0,63}$`, per `META_KEY_RE`) and value bounds (1–512 printable
  ASCII) so malformed input is rejected inline instead of round-tripping a 400.
  Enforce the same filter-count cap the API does.
- **Empty-state hints:** since `gh.*` dominates real usage, the empty search state
  suggests example keys (`gh.repo`, `app`, `page`) as click-to-fill chips — cheap
  discoverability without an autocomplete endpoint.
- Removing the last chip returns the island to `browse` mode (re-shows
  `AccountFileBrowser`).

## Results list

Flat list (no folder navigation):

- **Per row:** a thumbnail for image keys (kind inferred from the key's extension,
  since the result shape carries no `contentType`) via
  `<img loading="lazy" src={url}>`; otherwise a neutral file glyph. Then the
  filename (last key segment), the matched metadata as small chips, and actions:
  - **Open ↗** → `url` (`rel="noopener noreferrer"`, new tab)
  - **Copy link** → reuses the copy-with-feedback pattern already in this page
    (`navigator.clipboard.writeText` + transient "copied ✓" label).
- **States:**
  - _Loading:_ spinner / "Searching…".
  - _Empty:_ "No files match these filters." + the example-key hints.
  - _Error:_ message + retry (mirrors the workspace-list retry affordance).
  - _Truncated:_ "Showing the first 100 matches — add filters to narrow." when the
    endpoint returns `truncated: true`.

## URL sync & state

- Extend [`workspace-browse-url.ts`](../../../apps/web/src/lib/workspace-browse-url.ts)
  (or add a sibling `readSearchLocation`/`replaceSearchLocation`) so active filters
  encode into the query string, e.g. `?ws=acme&meta.app=web&meta.page=settings`.
  On load, presence of any `meta.*` param mounts the deep-linked workspace directly
  into `search` mode with those chips restored — reusing the existing eager-mount
  path that `?path=` already triggers.
- Filters are per-workspace island state; switching workspaces does not carry
  filters across (matches the per-workspace API).

## Error handling

- Endpoint uses the standard `AppError`/`ValidationError` typed-error path already
  in `me.ts`; a bad filter surfaces as a typed 400, not an untyped 500.
- Front-end `credentialedFetch` (same 8s-timeout wrapper `AccountFileBrowser`
  already uses) guards network hiccups; failures land in the results _error_ state.

## Testing

- **API** (`apps/api/src/routes/me.test.ts`): new-route cases — filter AND
  semantics, duplicate-key → 400 `file_metadata_duplicate_filter`, key-format
  rejection, communal → empty, truncation flag, member gating (non-member → 404).
- **Web:** component test for `MetadataSearchResults` — chip add/remove →
  constructed query string; `WorkspaceFiles` browse↔search mode switch on
  first-chip-added / last-chip-removed.
- **Manual:** verify `GET /me/workspaces/:name/files/search` resolves on a **preview
  worker** (not just vitest), per the #158 routing lesson.

## Rollout

Additive and behind the existing signed-in `/account/workspaces` surface. No
migration. The endpoint reuses shipped D1 index data (backfill already run in prod
per #159), so search returns real results on deploy.
