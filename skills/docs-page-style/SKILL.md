---
name: docs-page-style
description: >-
  House style and structure for uploads.sh documentation pages — the Astro
  pages under apps/web/src/pages/docs/ (and docs.astro) built on DocsLayout.
  Use this whenever you write, restructure, trim, or review a docs page:
  requests like "clean up the galleries docs", "this docs page has too much
  prose", "rework the agents page", "the flow on /docs/comment-config feels
  complicated", "make the reference page scannable", or any edit to a file
  under apps/web/src/pages/docs/. Encodes the page structure (understand →
  set up → do), the Stripe-style intro voice, the copy-affordance and
  inline-code rules, the prose diet, and the DocsLayout component vocabulary,
  so every docs page reads like one deliberate, scannable system rather than a
  wall of prose. Reach for it even mid-task when you notice a docs page drifting
  toward heavy paragraphs, fabricated terminal output, or a copy button on
  every line.
---

# uploads.sh docs page style

These pages teach a developer (or their agent) to do one thing with the `uploads`
CLI and then get out of the way. They are Astro pages built on `DocsLayout`, not
Markdown — so you work in HTML using a small, fixed component vocabulary. The
goal is a page that reads like reputable dev-tool docs (Stripe, Vercel, Wrangler):
one short orientation, then commands you can actually run, with prose used only as
connective tissue.

The failure mode to fight is the opposite: heavy paragraphs, an example for every
variation, a copy button on every line, and setup buried below usage. That reads
as "complicated" even when every sentence is individually fine — because the
_structure_ makes the reader work.

## How to approach a page

1. **Read the page and identify the ONE thing it's for.** Everything else is
   secondary and should be demoted or linked out, not given equal weight.
2. **Decide the page's job.** A hub/landing page (`docs.astro`) _triages and
   links_ — it should not re-teach what a subject page already covers. A subject
   page _walks through one workflow_. Don't duplicate a worked example that lives
   on another page; link to it instead.
3. **Order it: understand → set up → do.** A short "what/why", then install or
   prerequisites, then the golden-path command. A reader should be able to run the
   first real command without scrolling back up to find setup.
4. **Pick one golden path.** If there are two ways to do the thing, show the more
   universal one as the worked example and demote the other to a one-line pointer
   (see the pattern below). Never present two competing commands as parallel
   entry points — that fork is the single most common source of "this feels
   complicated."
5. **Apply the prose, copy, and inline-code rules** below to what's left.
6. **Verify it renders.** Reuse only the existing component classes, keep every
   command/flag/link real (never invent one — check a sibling page or the CLI),
   and confirm the page still compiles.

## Structure & voice

### Intro: one sentence, then a capability list — not paragraphs

Lead with what the tool/feature _does for the reader_, verb-first, then (if scope
needs conveying) a short bulleted capability list where each bullet links to the
relevant page. This is the Stripe pattern: the copy reads like a spec sheet, not a
pitch. No scene-setting ("In this guide…", "uploads.sh is a service that…"), no
adjectives, no wind-up.

**Prefer:**

```html
<p>Galleries collect related media behind one public link. With a gallery you can:</p>
<ul>
  <li><a href="/docs/…">Group screenshots</a> into an ordered set.</li>
  <li>Share the whole set with one URL.</li>
  <li>Link the gallery to a PR or issue.</li>
</ul>
```

**Avoid:** a two-sentence throat-clear before the reader learns what the page is
for, or a second explanatory paragraph _after_ the first command (the reader
wants to act, not read more).

### One golden path; demote the rest to a pointer

Show the single most universal command as the worked example. A secondary command
becomes a one-line pointer directly beneath it, linking to where it's covered in
full:

```html
<p class="pointer">
  Already have a PR open? Use <code>uploads attach</code> instead —
  <a href="/docs/attach-pull-request-images">see the walkthrough <span class="go">→</span></a
  >.
</p>
```

Note the pointer names only the _verb_ (`uploads attach`), not the full
multi-argument invocation — that lives on the linked page.

### Prose diet

- Cut throat-clearing lead-ins. Every sentence should state a fact or give an
  instruction.
- One idea per sentence; split compound sentences glued with a comma or dash.
- **Never fabricate terminal output.** Reputable docs don't show scripted output.
  Either show _real, verifiable_ output (a `.block` the reader can reproduce) or
  describe the effect in one sentence ("That uploads the file and prints a public
  URL."). Prefer the sentence.
- Push troubleshooting and edge cases to the end, a `.note`, or a linked page —
  not into the main reading path.

## Copy-affordance rule

A copy box (`.cmd`) signals "paste this verbatim." Putting one on every line
trains the eye to see many equally-weighted "do this" boxes when usually only one
command matters. So:

- **Use `.cmd`** for commands the reader genuinely pastes: the install line, the
  golden-path command, a long `npx …` one-off.
- **Use inline `<code>`** for short, memorable, or illustrative commands —
  `uploads login`, `uploads doctor`, a bare `npx`, a flag, a filename. These are
  steps you _read_, not snippets you paste.

Rule of thumb: **one copy target per action, not per line.** A typical page has
one to three copy boxes, not one per command mentioned.

## Inline-code rule

Inline `<code>` is for **short identifiers and single tokens** — a command verb,
a flag, a package name, a path like `/g/<id>`. This is near-universal in good docs.

**Never set a full, multi-argument command inline** (e.g.
`uploads attach ./before.png ./after.png` mid-sentence). It forces the reader to
switch between prose cadence and monospace in one breath, wraps awkwardly across
lines, and makes a runnable command look like a passing mention. Instead:

- Put the full command in a `.cmd` block, **or**
- Reference only the verb inline (`uploads attach`) and let the full form live in
  a block or on the linked page.

Watch inline-code _density_ too: three or more inline-code spans crammed into one
paragraph reads as busy. Split them across sentences, or move asides (like an
`npx` alternative or a `doctor` check) into a `.note`.

## Component vocabulary (DocsLayout)

Reuse these classes — don't invent new ones without a strong reason (note any new
class you add and why). Headings and their `#` anchors, the copy-button behavior,
the table of contents, and section dividers are all handled by `DocsLayout`
automatically; you don't wire them up per page.

| Element                                                                   | Use for                                                                                                                                                                                           |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<section class="lead" id="…">`                                           | The first section (no top divider under the page title).                                                                                                                                          |
| `<section id="…">`                                                        | Every subsequent section; gets a top divider automatically.                                                                                                                                       |
| `<h2>` with an `<a class="anchor" href="#id">#</a>` inside                | Section heading. The anchor sits in the left gutter and appears on hover; the whole heading is click-to-anchor. Keep the markup pattern; the layout styles it.                                    |
| `<h3>`                                                                    | Sub-heading within a section (e.g. a card title, a labelled step).                                                                                                                                |
| `<div class="cmd">` with `<span class="text">` + a `data-copy` `<button>` | A single, copyable command line. `$ ` prompt is auto-prepended; add `class="slash"` for slash-commands typed into an agent (no `$`).                                                              |
| `<span class="cm">` inside `.text`                                        | A trailing `# comment` on a command (muted).                                                                                                                                                      |
| `<div class="block">` with `<pre>`                                        | Multi-line, **non-copyable** output. Only for real, reproducible output; `.ok` marks a success line, `.v` a value.                                                                                |
| `<div class="cards">` + `<a class="card">`                                | The "explore" grid of links to subject pages. Each card: `<h3>Title <span class="go">→</span></h3>` + one-sentence `<p>`. Trim to the highest-intent destinations rather than listing everything. |
| `<div class="note">`                                                      | A muted aside — the place for asides, "more:" link lists, and edge cases pulled out of the main flow.                                                                                             |
| `<p class="pointer">`                                                     | A demoted secondary-command line under the golden path (styled quieter than body text). Name only the verb inline; link to where it's covered in full.                                            |
| `<div class="callout">`                                                   | An accent-tinted contextual banner near the top of a page (e.g. "landed here from a bot comment?"). Use sparingly, for orientation the reader needs before the content.                           |
| `<div class="installed">`                                                 | A green post-install success banner, revealed by a `?setup_action=…` query param (used on the GitHub App page). Don't add new ones without the matching reveal logic.                             |
| `<table>`                                                                 | Reference/comparison data (e.g. plans, limits). The natural form for a reference page — prefer it over prose for anything grid-shaped.                                                            |
| `<nav class="page-nav">` with a `.next`                                   | The prev/next footer link row at the bottom of a subject page. Keep it; update the targets if you re-order pages.                                                                                 |
| `<div class="ghc">`                                                       | A styled mock GitHub comment (avatar + bubble), for showing what a posted comment looks like. Specialised — only where a page illustrates GitHub output.                                          |
| `<code>`                                                                  | Short inline identifiers (see the inline-code rule).                                                                                                                                              |
| `<span class="go">→</span>`                                               | The trailing arrow on card titles and pointers.                                                                                                                                                   |

The canonical example of all of this working together is `apps/web/src/pages/docs.astro`
(the hub page). Read it before reworking a subject page — it shows the intro +
capability list, install-first ordering, the golden-path-plus-pointer pattern, the
copy-affordance rule, and a trimmed card grid in practice.

## Hard constraints

- **Don't invent facts.** Every command, flag, URL, and capability must already
  exist on the page, a sibling docs page, or the CLI. When unsure, check a sibling
  page under `apps/web/src/pages/docs/` rather than guessing.
- **Reuse the vocabulary above.** These are shared styles in `DocsLayout`; a new
  class means new CSS and drift. Flag it explicitly if you truly need one.
- **Keep the page valid Astro/HTML** so it compiles, and verify it renders in the
  browser preview (the `web` dev server) when you can — check the resting state is
  calm and scannable, not just that it builds.
