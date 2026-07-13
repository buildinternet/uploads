# Accounts layout & file-tree UX pass

**Date:** 2026-07-13
**Scope:** `apps/web` account/admin chrome + `@uploads/ui` FileBrowser. No routes, no API, no data-flow changes.

## Problem

The signed-in `/account/workspaces` view reads as clutter, and the signed-in
shell is missing chrome:

1. **Too many boxes.** The Workspaces page nests bordered cards three deep:
   outer `.card` → bordered workspace `<li>` → bordered sub-panels for
   Galleries / Files / the invite command → bordered file rows. Boxes-in-boxes.
2. **No footer** on `/account/*` or `/admin/*`. The canonical `<Footer />`
   ([apps/web/src/components/Footer.astro](../../../apps/web/src/components/Footer.astro))
   ships on docs/legal/auth pages but neither signed-in layout includes it.
3. **File-tree layout shift.** `FileBrowser.navigate()` clears
   `folders`/`items` to `[]` synchronously before fetching, so the container
   collapses to breadcrumb + spinner, then re-expands when data lands — a
   shrink-then-grow on every level change and on the initial lazy mount.

## Design-system guardrail

These pages are Astro/HTML and consume the DS through its **tokens**
(`--line`, `--panel`, `--muted`, `--radius-*`, `--space-*`) and shared shell
styles — not React components. The one React DS surface is `FileBrowser`.
Every change here either reuses an existing token/pattern or **updates the DS
in place** (`packages/ui/src/styles.css`). No divergent one-off styling.

## Changes

### 1. Footer as app-wide chrome

Add `<Footer />` to `AccountLayout.astro` and `AdminLayout.astro`, placed
after the `.layout` grid but inside the gated `#app` / `#dashboard` container,
so it spans full width at page bottom and only appears once a session
resolves (no flash under "Checking your session…"). Reuse the canonical
component — no new markup. `.shell` already reserves bottom padding; the
footer's own `margin-top` provides separation.

### 2. Flatten the Workspaces surfaces (`account-content.css`)

The outer `.card` stays the only "box." Inside it:

- Remove `border` / `background` / `border-radius` from `ul.plain li`
  (the workspace block) and from `.command` (the invite row). They become
  hairline/whitespace-separated regions, not nested cards.
- Keep the header row (name + role badge) and the usage line beneath it.
- Galleries / Files / Invite keep the existing borderless `.ws-section` +
  uppercase `.ws-section-head` label pattern, separated by a top hairline
  (`border-top: 1px solid var(--line)`) and `--space-*` rhythm.
- The invite command keeps mono + copy button but loses the heavy panel:
  a lighter inline code row.
- Multiple workspaces are separated from each other by a hairline rather than
  each sitting in its own chip.

### 3. File rows + stability (`packages/ui/src/styles.css`, `FileBrowser.tsx`)

DS update (benefits every future consumer, currently only this page):

- **Soften rows:** file/folder rows go from full bordered buttons to
  hairline-separated list rows (bottom border on `li`, no per-row box), so
  Files reads as one list.
- **Reserve height:** give the list a `min-height` (a few rows tall) so the
  container never collapses between navigations; loading/empty states render
  within that reserved space.
- **Don't blank on navigate:** stop clearing `folders`/`items` to `[]`
  synchronously in `navigate()`. Keep the current listing visible (dimmed,
  with the existing spinner affordance) until the new level resolves, then
  swap. The `requestGeneration` guard already discards stale writes, so only
  the visual clear is deferred. Removes both the shrink-then-grow and the
  flash-of-empty; the reserved height also stops the initial lazy-mount pop.

## Non-goals

- No new routes or pages; Overview / Profile / Developers keep their single
  clean card and simply gain the footer via the shared layout.
- No API, endpoint, or data-fetching changes.
- No new DS component; `FileBrowser` restyle is a token-based update to the
  existing component.

## Verification

Drive the running dev server: sign-in shell renders footer on
`/account/*` and `/admin/*`; Workspaces shows one outer card with flat
interior; navigating folders in the file tree holds a stable height with no
shrink-then-grow. Check light/dark + narrow viewport.
