# Product

<!-- Synthesized 2026-07-13 from AGENTS.md, .context/2026-07-13-uploads-brand-distinctiveness-handoff.md,
     and project history during an autonomous /impeccable audit run. Review and correct — especially
     Brand Personality and Anti-references, which drive design decisions. -->

## Register

product

<!-- Split surface: apps/web/src/pages/index.astro (+ docs, github-screenshots) is brand register;
     console/account/admin/login and packages/ui are product register. Product is the default. -->

## Users

Developers and their coding agents. Primary user today: a single internal user (Zach) and
the agents he runs. The core workflow is CLI/agent-first: `uploads put shot.png --pr 123`
from a terminal or an agent skill, then the hosted URL lands in a GitHub PR or issue.
The web surfaces are secondary: a landing page that explains the product, and authenticated
console/account/admin pages for managing workspaces, keys, files, and galleries.

## Product Purpose

uploads.sh is purpose-built file hosting for putting screenshots into PRs, issues, and
agent workflows — not generic file hosting. It exists so agents (which can't drag-and-drop
into GitHub) and developers get a one-command path from local file to embeddable URL.
Success: the CLI/MCP is the product; the web app makes what you've hosted legible and
manageable; the brand makes a tiny infrastructure tool feel deliberately crafted.

## Brand Personality

Terminal-native, precise, quietly playful. A developer's tool that takes craft seriously —
mono-leaning typography, dark by construction, with one genuinely distinctive asset:
Geist Pixel and its variable ELSH (element-shape) axis, which should read as the brand's
signature rather than a wordmark-only garnish. Personality shows up in small, exact
moments (pixel morphs, the chevron/upload motif), never in loudness.

## Anti-references

- The generic "dark + purple dev tool" (Linear/Vercel-adjacent): #0a0a0b + violet accent
  - Geist-for-everything is the saturated default this brand must escape.
- SaaS landing-page grammar: hero-metric blocks, identical icon-card grids, tiny uppercase
  tracked eyebrows above every section, gradient text, glassmorphism.
- Generic file-hosting framing (Dropbox-alike "store anything" pitches) — the pitch is
  purpose-first: PR screenshots and agent workflows.

## Design Principles

1. **The CLI is the hero.** Web surfaces demonstrate and manage what the CLI does; show
   real commands, real output, real hosted files — not marketing abstractions.
2. **One brand, two registers.** The design system (`@uploads/ui`) is the single source of
   truth; the live site and the DS must stay visually identical.
3. **Signature over decoration.** Distinctiveness comes from owned assets (Geist Pixel's
   ELSH axis, the chevron/upload motif) used systematically — not from added ornament.
4. **Deliberate, not default.** Every value that survives an audit is either evolved or
   explicitly kept with a recorded reason (impeccable ignore + rationale). No silent defaults.
5. **Agent-legible craft.** Pages must work without JS where possible, degrade cleanly,
   and stay fast on Workers — the audience includes headless agents and curl.

## Accessibility & Inclusion

WCAG 2.1 AA. Dark-only palette must hold ≥4.5:1 body contrast (muted metadata text is the
known risk). Full keyboard operability on console/account/admin (file browser, forms).
`prefers-reduced-motion` alternatives for any pixel-morph/dissolve motion the brand work
adds. Touch targets ≥44px on mobile for the management surfaces.
