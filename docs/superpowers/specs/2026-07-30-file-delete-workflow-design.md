# Web file-delete workflow — design

Date: 2026-07-30
Status: approved (brainstormed with Zach)

## Goal

Let workspace members delete a file from the web UI — the one administrative
action worth doing in the browser (e.g. someone uploaded something they want
gone). Deletion is member-gated, double-confirmed, and presented as a popover.

Surfaces in this pass:

1. The public `/f/` file page (`apps/web/src/pages/f/[workspace]/[...key].astro`)
2. The workspace file table (`apps/web/src/components/WorkspaceFileTable.tsx`)

The galleries page has no per-item action UI today and is out of scope.

## Decisions

- **Permissions:** any workspace member may delete (parity with the CLI's
  `uploads delete`, which any member token can already do). No role or
  uploader checks.
- **Confirmation:** two-step button inside a popover. First click shows the
  warning + "Delete file" button; clicking it arms a red "Confirm delete"
  button that auto-disarms after ~5 seconds if not clicked.
- **Popover, not modal:** a positioned panel anchored to the trigger, closed by
  Escape or outside click — same interaction family as the existing
  `.wft-menu__popover` in the file table. No `window.confirm`.

## API

New session-authed endpoint in `apps/api/src/routes/me.ts`:

```http
DELETE /me/workspaces/:name/files?key=<key>
```

Cloned from the visibility-toggle pattern
(`PATCH /me/workspaces/:name/files/visibility`, `me.ts:750`):

1. `sessionAuth` + `requireSessionUser` (already applied to `/me/*`)
2. `memberWorkspaceOr404(env, userId, name)` — uniform 404 for non-members,
   never 403 (no existence probing)
3. `allowWrite(c.env, name)` rate limit, applied after the membership gate
4. Key validation (same rules as the visibility route)
5. Delegate to the existing `deleteObject()` in `apps/api/src/files-core.ts`
   — R2/S3 delete, D1 metadata cleanup, usage/adoption accounting, and
   best-effort derived-poster deletion all come for free
6. Respond `{ key, deleted: true }`. A missing or invalid `key` value 404s
   (matching the `file-url`/visibility convention); a valid key whose object
   is already absent still returns `{ key, deleted: true }` — deletion is
   idempotent, same as the token-authed `/v1` sibling

No new deletion logic is written anywhere. The token-authed
`DELETE /v1/:workspace/files/:key` is untouched.

## /f/ file page

The page stays public, framework-JS-free, and unchanged for anonymous
visitors.

- **Member detection:** a small inline script (same style as the existing
  unlisted-file probe at the bottom of the page) calls the existing
  `GET {apiOrigin}/me/workspaces/:name/file-url?key=…` with
  `credentials: "include"`. On 200, it reveals a hidden "Delete file…"
  control. On anything else, the control stays hidden and the page is
  byte-identical in behavior to today.
- **Placement:** a quiet destructive text button at the bottom of the Details
  rail, near the footnote / ReportAbuse area.
- **Popover:** anchored `<div>` opened by the button; shows the filename, the
  warning "This permanently deletes the file for everyone. Links and embeds
  will break.", and the two-step button. Escape / outside click closes and
  disarms.
- **GitHub-managed keys:** if the file's metadata includes `gh.*` tags (the
  page already parses metadata and filters `gh.*` out of the Details list),
  the popover adds a line warning that the managed PR/issue comment will keep
  a now-broken link until its next sync.
- **On success:** replace the page content with a simple "File deleted" state
  linking to the workspace files view (`/account/workspaces/:name`).
- **On error:** show the API error message inline in the popover; the button
  disarms.

## Workspace file table

- Add a "Delete…" item with destructive styling to the existing
  `FileActionsMenu` (`WorkspaceFileTable.tsx:246`).
- Selecting it swaps the menu contents for the same warning + two-step
  confirm panel (menu → confirm panel in place; Escape / outside click
  closes, existing `openMenuKey` state machinery reused).
- On success: optimistically remove the row and update counts; on error,
  surface via the existing `setActionError` path.

## Shared bits

The arm/disarm confirm logic is ~30 lines. It is implemented twice — once
vanilla for the Astro page (public pages ship no framework JS) and once in
React for the table. No new shared primitive, no `@uploads/ui` addition.

## Known limitations (accepted)

- Web deletion of a GitHub-managed screenshot does not re-sync the managed
  attachments comment (that sync lives in the CLI/bot); the comment's image
  link 404s until the next sync. Mitigated by the extra popover warning.
- Deletion is immediate and permanent — no soft delete / undo. (Workspace
  soft delete from PR #248 is a different, workspace-level mechanism.)

## Testing

- **API (vitest):** member deletes → 200 + object gone from fake store +
  metadata row removed; non-member → 404 `workspace_not_found`; signed-out →
  401; missing/invalid key → 404; rate-limit path exercised.
- **Web:** manual verification of both surfaces via the local signed-in
  browser recipe (stack-raw on 127.0.0.1), including: control hidden when
  signed out, popover open/arm/disarm/Escape, successful delete end-state,
  and table row removal.
