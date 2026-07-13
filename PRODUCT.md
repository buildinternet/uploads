# Product

## Register

product

<!-- Split surface: the landing page, docs, and guides are brand register;
     console/account/admin and packages/ui are product register. Product is the default. -->

## Users

Developers and the coding agents that work alongside them. The core workflow is
CLI- and agent-first: one command takes a local file — a PR screenshot, an agent
artifact, a quick share — and returns a stable, embeddable URL, usually landing in
a GitHub PR or issue. Agents are first-class users, not an afterthought: they reach
the product through the CLI, the agent skill, and the MCP server, and they can't
drag-and-drop into GitHub the way a human can.

The web surfaces serve two moments: deciding (a landing page and docs that explain
the product) and managing (signed-in console, account, and admin pages for
workspaces, keys, files, and galleries).

## Product Purpose

uploads.sh is purpose-built file hosting for development workflows — not generic
"store anything" file hosting. It exists so that getting a file from a local machine
into a PR, issue, or agent pipeline is one command instead of a drag-and-drop a
robot can't perform. It is open source and runs as a hosted service; workspaces
keep teams' files, limits, and tokens isolated from each other.

Success looks like: the tool a developer installs once and stops thinking about,
and the default way coding agents attach visual evidence to their work.

## Brand Personality

Terminal-native, precise, quietly playful. A developer's tool that takes craft
seriously — mono-first typography, dark by construction, with one genuinely
distinctive asset: Geist Pixel and its variable ELSH (element-shape) axis, used as
the brand's signature rather than a wordmark-only garnish. Personality shows up in
small, exact moments (pixel morphs, the chevron/upload motif), never in loudness.

## Anti-references

- The generic "dark + purple dev tool" (Linear/Vercel-adjacent) rendered entirely
  in stock defaults. The palette family is allowed; the tell is default-ness —
  distinctiveness must come from owned assets and usage, not template chrome.
- SaaS landing-page grammar: hero-metric blocks, identical icon-card grids, tiny
  uppercase tracked eyebrows above every section, gradient text, glassmorphism.
- Generic file-hosting framing (Dropbox-alike "store your files" pitches). The
  pitch is purpose-first: screenshots on PRs, artifacts from agents.

## Design Principles

1. **The CLI is the hero.** Web surfaces demonstrate and manage what the CLI does;
   show real commands, real output, real hosted files — not marketing abstractions.
2. **One brand, one source of truth.** The design system (`@uploads/ui`) defines
   the visual language; the site consumes it. The two never drift.
3. **Signature over decoration.** Distinctiveness comes from owned assets (Geist
   Pixel's ELSH axis, the pixel chevron mark) used systematically — not added ornament.
4. **Deliberate, not default.** Every visual value is either chosen or explicitly
   kept with a recorded reason. No silent defaults.
5. **Agent-legible craft.** Pages work without JavaScript where possible, degrade
   cleanly, and stay fast at the edge — the audience includes headless agents and
   curl, not just browsers.

## Accessibility & Inclusion

WCAG 2.1 AA. The dark-only palette must hold ≥4.5:1 contrast for all text,
including muted metadata at small sizes. Full keyboard operability on the signed-in
surfaces (file browser, forms, navigation). Every animation ships a
`prefers-reduced-motion` alternative. Touch targets sized for mobile use on the
management surfaces.
