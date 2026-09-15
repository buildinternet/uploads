# Publishing a changelog entry

One markdown file per platform update. CLI releases are merged in
automatically from `packages/uploads/CHANGELOG.md` — never write those here.

## What belongs here

A platform entry is a user-visible product story: a new capability, a new
workflow, or a new surface people can use. The page is a product changelog,
not a commit log.

Skip the platform `.md` when the change is only:

- An internal refactor
- A route rename, redirect, or "we moved the URL"
- A copy tweak
- A build, deploy, or CI change
- A CLI or npm release note that already lives in a changeset

If it only matters as a CLI release note, leave it in changesets /
`packages/uploads/CHANGELOG.md`. Do not also write a platform entry that
restates the same ship.

Prefer one entry per story. Do not stack same-day micro-posts that restate
the same change. When you are unsure, skip the platform entry.

The `/changelog` filter is visual only. The Atom and JSON twins always
include every published entry.

## Tags

Usual tags: `platform`, `web`, `cli`, `mcp`. The page shows them as chips
and uses them in the filter.

Hand-written posts are always `kind: platform`, even when they are tagged
`cli`. Auto-imported CLI releases are `kind: cli` and already carry a `cli`
tag — do not duplicate them here.

## How to publish

1. Capture the screenshot (if any).
2. Upload it — never commit images to the repo:

   ```bash
   uploads put shot.png --key screenshots/changelog/<slug>.png
   ```

   (The workspace key policy only allows the `f/`, `gh/`, and `screenshots/`
   prefixes, so changelog images live under `screenshots/changelog/`.)

   Copy the public `storage.uploads.sh` URL from the output.

3. Create `<slug>.md` in this directory (slug becomes the page anchor):

   ```md
   ---
   title: "Human-readable title"
   date: 2026-08-12
   tags: [platform]
   image:
     url: https://storage.uploads.sh/default/screenshots/changelog/<slug>.png
     alt: "What the screenshot shows"
   ---

   Body in plain markdown. Inline images work too, absolute https URLs only.
   ```

4. Open a PR. Merge deploys /changelog, /changelog.xml, and /changelog.json;
   releases.sh picks up the new entry on its normal feed sweep. The CLI
   (`uploads changelog`) reads the JSON twin.

Image rules: absolute `https://` URLs, 1 KB–8 MB, png/jpeg/gif/webp/avif —
that's what releases.sh mirrors into its own storage. `date` supports full
ISO timestamps (`2026-08-12T15:00:00Z`) when same-day ordering matters.
