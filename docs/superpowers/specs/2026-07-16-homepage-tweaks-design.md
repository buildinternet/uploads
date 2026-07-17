# Homepage tweaks: headline balance, lede width, feature examples, columned footer

Approved design, 2026-07-16. Four small changes to `apps/web` — three on
`src/pages/index.astro`, one to the shared `src/components/Footer.astro`.

## 1. Headline text balance

Add `text-wrap: balance` to the `h1` rule. Keep the `.nb` nowrap span around
"pull requests, too." unless it visibly fights the balancer at narrow widths,
in which case drop the nowrap and let `balance` own the line breaks.

## 2. Lede wraps too early

`.lede` caps at `max-width: 58ch`, which at 15px sans is ~490px inside the
720px content column — the visible "early wrap". Remove the `max-width` so the
paragraph fills the column like every other block.

## 3. "What else it does" — concrete examples

Two changes to the features section:

**New grid cells (6 → 8, grid stays even):**

- `queryable metadata` — tag uploads with `--meta path=/settings`, find them
  later with `uploads find`; `attach` auto-stamps `gh.repo`/`gh.pr` so every
  file knows where it's attached.
- `screenshot command` — `uploads screenshot <url>` captures and hosts in one
  step; local browser if one is installed, remote render if not.

**Two full-width example blocks below the grid**, styled as slim versions of
the hero terminal (no titlebar; small caption line above each). Output lines
mirror what the CLI actually prints:

Example A — tag it when you attach it:

```
$ uploads attach ./settings.png --meta path=/settings --meta app=web
>> uploading ./settings.png
>> optimized 402.3 KB → 91.7 KB (settings.webp)
>> attachments comment updated
>> find these later: uploads find gh.ref=pull/123
```

Example B — find it later, and see where it landed:

```
$ uploads find path=/settings
gh/you/app/pull/123/settings.webp  app=web gh.number=123 gh.repo=you/app path=/settings
```

The `find these later` line in A is real `attach` output (commands.ts) and
bridges into B. B's line shape matches `runFindFiles` human output
(`key  meta-pairs`, sorted), with the URL column omitted for width.

## 4. Columned footer (shared, all pages)

Rework the non-compact variant of `Footer.astro` into the releases.sh footer
shape, sized for lighter content. The `compact` variant (auth/error cards)
keeps today's one-liner.

- **Brand column:** "uploads.sh" + one-liner: "Screenshots & recordings for
  agent PRs."
- **Product column:** Docs (`/docs`), Agent guide (`/github-screenshots`),
  Console (`/console`), Sign in (`/login`)
- **Project column:** GitHub (repo), Terms, Privacy
- **Family bar** below a divider: left, "Maintained by Zach Dunn / Build
  Internet" (links to zachdunn.com / buildinternet.com); right, "Release notes
  registry for agents — releases.sh →" with `rel="noopener"` only (no
  `noreferrer`), mirroring how releases.sh links back to uploads.sh.

Styling stays in-system: mono 12px, `var(--line)` borders, muted links with
accent hover, uppercase 11px column titles echoing `.sect-head`. Grid
`1.4fr 1fr 1fr`, stacking on mobile (~560px). Links defined as a data array so
future links are one-line edits (mirrors releases' footer.tsx).

## Verification

Astro dev server; check desktop + mobile widths; confirm headline balance,
full-width lede, example blocks, and footer on `/` plus one non-compact page
(`/docs`) and one compact page (`/login`); screenshot.
