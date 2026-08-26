---
name: docs-page-style
description: >-
  House style and structure for uploads.sh documentation pages — the MDX
  subject pages under apps/web/src/content/docs/ (and the docs.astro hub) built
  on DocsLayout.
  Use this whenever you write, restructure, trim, or review a docs page:
  requests like "clean up the galleries docs", "this docs page has too much
  prose", "rework the agents page", "the flow on /docs/comment-config feels
  complicated", "make the reference page scannable", or any edit to a file
  under apps/web/src/content/docs/. Encodes the page structure (understand →
  set up → do), the Stripe-style intro voice, the copy-affordance and
  inline-code rules, the prose diet, and the DocsLayout component vocabulary,
  so every docs page reads like one deliberate, scannable system rather than a
  wall of prose. Reach for it even mid-task when you notice a docs page drifting
  toward heavy paragraphs, fabricated terminal output, or a copy button on
  every line.
---

# uploads.sh docs page style

These pages teach a developer (or their agent) to do one thing with the `uploads`
CLI and then get out of the way. Each subject page is one `.mdx` file in the
`docs` content collection (`apps/web/src/content/docs/`), rendered through
`DocsLayout` by the `apps/web/src/pages/docs/[...slug].astro` route: you write
Markdown prose, fenced code blocks, and a small, fixed vocabulary of HTML
wrappers and components. The hub page (`apps/web/src/pages/docs.astro`) is still
a plain Astro page — it is a card index, not prose. The goal is a page that reads like reputable dev-tool docs (Stripe, Vercel, Wrangler):
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
   and confirm the page still compiles (`pnpm build` in `apps/web`).

## Adding or editing a page

A new subject page is a new `.mdx` file in `apps/web/src/content/docs/`. The
filename is the URL slug (`galleries.mdx` → `/docs/galleries`); the left nav,
the prev/next chain, and the static path all derive from its frontmatter, so
there is no route, nav, or pagination edit to make.

```yaml
---
title: Galleries # <title> and og/twitter title
description: … # meta description
heading: Galleries # the <h1>
tagline: … # one line under the <h1>
navLabel: Galleries # sidebar label (often shorter than heading)
navSlug: galleries # active-state key
navOrder: 2 # sidebar order AND the prev/next chain
toc: # optional "on this page" rail; omit it and no rail renders
  - { id: what, label: What a gallery is }
---
```

`navOrder` is the whole ordering story: the sidebar lists entries in that order,
and the prev/next footer walks the same sequence, wrapping through the `/docs`
hub at both ends. Inserting a page means renumbering the ones after it.

MDX gotchas worth knowing before you write:

- Leave a blank line after an opening `<section …>` tag and before its `</section>`
  so the prose inside is parsed as Markdown.
- Use `<div class="note">`, not `<p class="note">`: MDX wraps multi-line children
  in their own `<p>`, and a `<p>` inside a `<p>` is invalid.
- Never let an inline component or `{expression}` start a line inside a
  paragraph — MDX reparses it as a block and splits the sentence around it. This
  is why `*.mdx` is excluded from `oxfmt` (see `.oxfmtrc.json`): a reflow would
  do exactly that. Wrap prose by hand.

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

The thing to cut is _throat-clearing_ ("In this guide…", "uploads.sh is a service
that…"), not substance. A concrete _why_ — a real constraint the tool exists to
solve, like "GitHub has no API for file uploads, so agents can't include
screenshots in pull requests" — earns its two or three sentences, because it
tells the reader what problem they're actually solving. Lead with that when the
page has one; keep it tight and get to the capability list.

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
  Either show _real, verifiable_ output (an ` ```ansi ` block the reader can reproduce) or
  describe the effect in one sentence ("That uploads the file and prints a public
  URL."). Prefer the sentence.
- Push troubleshooting and edge cases to the end, a `.note`, or a linked page —
  not into the main reading path.

## Code blocks

Fenced blocks are rendered by [Expressive Code](https://expressive-code.com/)
(configured in `apps/web/src/lib/expressive-code-options.mjs`). The language tag
is the affordance — three conventions carry what the old hand-rolled `.cmd` and
`.block` markup used to:

| Fence                     | Renders as                                                   | Copy button |
| ------------------------- | ------------------------------------------------------------ | ----------- |
| ` ```bash `               | A command, with a `$ ` prompt drawn in the gutter            | yes         |
| ` ```ansi `               | Terminal output in a **terminal frame** (titlebar chrome)    | no          |
| ` ```text `               | A plain block — slash commands typed into an agent, snippets | yes         |
| ` ```yaml ` / ` ```json ` | A syntax-highlighted config example                          | yes         |

Frames add hierarchy where a bare panel would read flat:

- `ansi` blocks get terminal chrome automatically (configured in
  `expressive-code-options.mjs`). Add `title="uploads staged"` to name the
  command that produced the output — use the command the surrounding prose
  already names, never an invented one. Untitled is fine for catalogs.
- Config/file examples opt into an editor frame per-fence with
  `title=".uploads.yml" frame="code"` — the title is the filename the reader
  will save. A paste-into-your-instructions snippet works the same way
  (` ```md title="AGENTS.md" frame="code" `) and keeps its copy button.
- Commands stay bare panels (`$ ` prompt is the affordance); don't wrap a
  one-liner in terminal chrome.

The `$ ` prompt is CSS, not source text, so the copy button still yields a clean
command. Never write the `$` yourself. Comments (`# …`) inside a `bash` block are
stripped from the copied text automatically.

Config-file examples get syntax highlighting: a real `.uploads.yml` or JSON
snippet goes in a ` ```yaml ` / ` ```json ` fence, not a plain block.
Highlighting makes the keys and values pop out from explanatory comments.

## Copy-affordance rule

A copyable block signals "paste this verbatim." Putting one on every line
trains the eye to see many equally-weighted "do this" boxes when usually only one
command matters. So:

- **Use a ` ```bash ` block** for commands the reader genuinely pastes: the
  install line, the golden-path command, a long `npx …` one-off.
- **Use inline `` `code` ``** for short, memorable, or illustrative commands —
  `uploads login`, `uploads doctor`, a bare `npx`, a flag, a filename. These are
  steps you _read_, not snippets you paste.

Rule of thumb: **one copy target per action, not per line.** A typical page has
one to three copyable command blocks, not one per command mentioned.

**A reference list of sibling commands is one block, not N copy rows.** When a
section just enumerates related commands (a "here's the command surface" menu,
e.g. `list` / `delete` / `usage` / `--help`), a stack of copyable command blocks
reads as a wall of buttons. Put them in a single non-copyable ` ```ansi `
block instead, with the `# comment` aligned:

````
```ansi
uploads list          # see your files
uploads delete <key>  # remove a file
uploads usage         # storage used by your workspace
```
````

Reserve ` ```bash ` for the one or two commands in that section a reader
actually runs in sequence (an install line, a golden path) — not the whole
catalog.

**Genuinely equivalent alternatives go in tabs, not stacked blocks.** When one
action has two interchangeable entry points (the two ways to bake annotations
onto a capture, say), wrap them in `<Tabs>` / `<TabItem>` from
`apps/web/src/components/docs/`:

````mdx
<Tabs syncKey="annotate-entry-point">
  <TabItem label="screenshot --annotate">

```bash
uploads screenshot … --annotate ./callouts.json
```
````

  </TabItem>
</Tabs>
```

Groups sharing a `syncKey` switch together across the page, and the choice is
remembered per browser. Tabs are for real alternatives only — never a sequence of
steps, and never an invented variant of a command.

## Inline-code rule

Inline `<code>` is for **short identifiers and single tokens** — a command verb,
a flag, a package name, a path like `/g/<id>`. This is near-universal in good docs.

**Never set a full, multi-argument command inline** (e.g.
`uploads attach ./before.png ./after.png` mid-sentence). It forces the reader to
switch between prose cadence and monospace in one breath, wraps awkwardly across
lines, and makes a runnable command look like a passing mention. Instead:

- Put the full command in a ` ```bash ` block, **or**
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

| Element                                                    | Use for                                                                                                                                                                                           |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<section class="lead" id="…">`                            | The first section (no top divider under the page title).                                                                                                                                          |
| `<section id="…">`                                         | Every subsequent section; gets a top divider automatically.                                                                                                                                       |
| `<h2>` with an `<a class="anchor" href="#id">#</a>` inside | Section heading. The anchor sits in the left gutter and appears on hover; the whole heading is click-to-anchor. Keep the markup pattern; the layout styles it.                                    |
| `<h3>`                                                     | Sub-heading within a section (e.g. a card title, a labelled step).                                                                                                                                |
| ` ```bash ` fence                                          | A copyable command. The `$ ` prompt is drawn by CSS — never type it. A trailing `# comment` is stripped from the copied text.                                                                     |
| ` ```ansi ` fence                                          | Multi-line, **non-copyable** output or a reference command listing. Only for real, reproducible output.                                                                                           |
| ` ```text ` fence                                          | A copyable non-shell line — a slash command typed into an agent, an instructions-file snippet.                                                                                                    |
| `<Tabs>` / `<TabItem label="…">`                           | Two or more genuinely equivalent commands. `syncKey` links groups across the page. Not for sequences of steps.                                                                                    |
| `<div class="cards">` + `<a class="card">`                 | The "explore" grid of links to subject pages. Each card: `<h3>Title <span class="go">→</span></h3>` + one-sentence `<p>`. Trim to the highest-intent destinations rather than listing everything. |
| `<div class="note">`                                       | A muted aside — the place for asides, "more:" link lists, and edge cases pulled out of the main flow.                                                                                             |
| `<div class="pointer">`                                    | A demoted secondary-command line under the golden path (styled quieter than body text). Name only the verb inline; link to where it's covered in full.                                            |
| `<div class="callout">`                                    | An accent-tinted contextual banner near the top of a page (e.g. "landed here from a bot comment?"). Use sparingly, for orientation the reader needs before the content.                           |
| `<GithubAppInstalledBanner />`                             | The green post-install success banner, revealed by a `?setup_action=…` query param (GitHub App page only). Don't add new ones without the matching reveal logic.                                  |
| `<table>`                                                  | Reference/comparison data (e.g. plans, limits). The natural form for a reference page — prefer it over prose for anything grid-shaped.                                                            |
| _(prev/next footer)_                                       | Generated from `navOrder` by the `[...slug].astro` route — don't hand-write one.                                                                                                                  |
| `<GhComment />`                                            | A styled mock GitHub comment (avatar + bubble), for showing what a posted comment looks like. Specialised — only where a page illustrates GitHub output.                                          |
| `` `code` ``                                               | Short inline identifiers (see the inline-code rule).                                                                                                                                              |
| `<span class="go">→</span>`                                | The trailing arrow on card titles and pointers.                                                                                                                                                   |

Page-specific markup that doesn't generalize (a mock wireframe, a data table fed
from code) belongs in a small `.astro` component under
`apps/web/src/components/docs/`, imported by the MDX — not inlined as a slab of
HTML in the prose.

The canonical example of all of this working together is
`apps/web/src/content/docs/attach-pull-request-images.mdx` (fenced-block
conventions, tabs, an imported wireframe component) alongside
`apps/web/src/pages/docs.astro` (the hub page: intro + capability list,
install-first ordering, the golden-path-plus-pointer pattern, and a trimmed card
grid). Read one of them before reworking a subject page.

## Hard constraints

- **Don't invent facts.** Every command, flag, URL, and capability must already
  exist on the page, a sibling docs page, or the CLI. When unsure, check a sibling
  page under `apps/web/src/content/docs/` rather than guessing.
- **Reuse the vocabulary above.** These are shared styles in `DocsLayout`; a new
  class means new CSS and drift. Flag it explicitly if you truly need one.
- **Keep the page valid MDX** so it compiles, and verify it renders in the
  browser preview (the `web` dev server) when you can — check the resting state is
  calm and scannable, not just that it builds.
