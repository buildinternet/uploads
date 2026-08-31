# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primary: the coding agent.** Agents execute the loop — capture a visual the
moment a change is visible, `uploads put` it, and let it land on the pull
request. They reach the product through the CLI, the agent skills, the local
stdio MCP server, and the hosted MCP at `agents.uploads.sh`. They are the
primary actor because they are the ones structurally blocked without it: GitHub's
native image hosting only works through a browser session, so an agent that just
captured a before/after has nowhere to put it.

**Owner: the developer.** The developer installs the CLI once, signs in, owns
the workspace, sets its limits and keys, and reads the result on the PR. They
also use the product directly for one-off shares and screenshot capture. Every
surface an agent cannot see — account, admin, billing, the `/f/` share
page — exists for them.

The web surfaces serve two moments: **deciding** (landing page, docs, changelog,
guides that explain the product) and **managing** (signed-in account,
workspace, and admin pages for workspaces, keys, files, screenshots, galleries,
people, storage, and billing).

## Product Purpose

uploads.sh is purpose-built file hosting for development workflows — not generic
"store anything" file hosting. It exists so that getting a file from a local
machine into a PR, issue, or agent pipeline is one command instead of a
drag-and-drop a robot cannot perform.

The mechanism is the **staged loop**: on a branch, a bare `put` stages the file
against that branch — no PR required, no flag to remember. Capture at every
milestone and there is nothing to reassemble at the end; when the pull request
opens, everything staged is promoted into one managed attachments comment that
rewrites itself in place on every revision.

It is open source (Apache 2.0), runs as a hosted service at uploads.sh, and
workspaces keep teams' files, budgets, and tokens isolated from each other.

Success looks like: the tool a developer installs once and stops thinking about,
and the default way coding agents attach visual evidence to their work.

## Positioning

Three things a neighboring product could not truthfully copy:

1. **Staged-before-the-PR.** Files attach to a branch that has no pull request
   yet and promote themselves when one opens. Competing tools require a target
   that already exists.
2. **One comment, rewritten in place.** Not a growing thread of attachments —
   a single managed comment per PR/issue, deduped, that updates on each sync and
   empties itself when the last attachment is removed. `--state before`/`after`
   files pair into a side-by-side table.
3. **Hash-free stable keys.** Re-uploading the same filename overwrites in place
   and the URL never changes, so every existing embed updates at once.

## Operating Context

- The work happens in a terminal on a feature branch, mid-task, usually inside
  an agent session rather than a browser tab.
- GitHub is the destination for most files: PR descriptions, issue bodies,
  PR/issue comments. `gh` (or the `uploads-sh` GitHub App) is how the product
  reaches them; the App makes promotion instant, the local `gh` path is
  first-class parity, not a fallback.
- Agent runtimes are an install target of their own: `uploads install` wires in
  the skills and MCP server; `npx skills add buildinternet/uploads` installs the
  three skills (`github-screenshots`, `uploads-cli`, `annotate-screenshots`)
  into any runtime without a checkout.
- Everything hosted is a public URL. Private-repo attachments get non-guessable
  capability links, but anyone holding a URL can view the file. The product
  states this plainly rather than implying access control it does not have.
- The project is under active development and says so; APIs including auth can
  still change.

## Capabilities and Constraints

**Shipped surfaces:** REST API worker (`api.uploads.sh`), auth worker, remote
MCP server (`agents.uploads.sh`), the Astro site at uploads.sh, and the
`@buildinternet/uploads` CLI on npm. Each deploys separately on Cloudflare
Workers. All storage goes through `createStorage()` in `packages/storage`, built
on files-sdk, so the storage layer is provider-agnostic (R2 and any
S3-compatible bucket today).

**Web routes in production:** marketing home, `/docs` hub with eight guides,
`/changelog` (plus Atom feed), `/f/<workspace>/<key>` file share pages, `/g/<id>`
public galleries, `/account` (profile, developers, workspaces),
per-workspace files / screenshots / galleries / people / invite / settings /
storage / billing, `/admin` (users, oauth, email, metrics), and the auth flows
(login, device, invite, accept-invitation, oauth consent).

**Plans (both live).**

|           | Free         | Pro                                       |
| --------- | ------------ | ----------------------------------------- |
| Storage   | 250 MB       | 10 GB                                     |
| Max file  | 25 MB        | 100 MB                                    |
| Max video | 8 MB         | 100 MB (same as file cap)                 |
| Members   | 3 (marketed) | seatless; 25 is an unmarketed abuse guard |

Free is available in perpetuity; Pro is purchased through Stripe Checkout. Seats
and roles are deliberately not sold — they are reserved for a future Team tier.
Self-serve signup is live (GitHub-gated, 3 free workspaces per user, paid users
exempt); the invitation-only story is retired.

**Bring your own bucket.** A workspace can point at its own bucket instead of
the shared `storage.uploads.sh` bucket — a Cloudflare R2 bucket, or any
S3-compatible bucket (AWS S3, Backblaze B2, MinIO, and the rest). Available on
both plans, gated per workspace by a `byoBucketEnabled` record flag, with its
own docs page and a settings/storage connect wizard.

**Terminology that must stay stable:** _staged_ (attached to a branch, not yet
promoted), _promote_ (staged → the PR comment), _attach_ (upload + sync the
managed comment), _managed comment_ (the single rewritten comment), _workspace_
(the isolation boundary for files, limits, and tokens), _key_ (the hash-free
path a file lives at), _state_ (`before`/`after` for pairing).

**Constraints:** dark-only palette by construction (`color-scheme: dark`); the
site ships no framework JavaScript on public pages (React only behind sign-in);
Node ≥24 and pnpm ≥11 for local development.

## Brand Commitments

Name is **uploads** / **uploads.sh**; the bot and GitHub App are referred to in
prose as the "`uploads-sh` bot".

Terminal-native, precise, quietly playful. A developer's tool that takes craft
seriously — dark by construction, with one genuinely distinctive asset: Geist
Pixel and its variable ELSH (element-shape) axis, used as the brand's signature
rather than a wordmark-only garnish. Personality shows up in small, exact
moments (pixel morphs, the chevron/upload motif), never in loudness.

Three faces, defined once in `packages/ui/src/tokens.css`: Geist (sans — the
interface voice: prose, headings, buttons, labels, navigation), Geist Mono
(reserved for what it measures — commands, code, file keys, URLs, hashes, and
tabular figures), Geist Pixel (display and brand moments).

**The mono rule, decided 2026-08-21:** reach for mono when the characters are
something a reader transcribes or compares column-to-column, never to make a
word look technical. The terminal character comes from Geist Pixel, the chevron
motif, and the density — not from setting every label in a typewriter. This
replaces the earlier "mono-first typography" framing, under which Geist Mono was
the base face for all product UI.

Voice: purpose-first and concrete. Legal and marketing copy never overpromises —
no access-control claims about public URLs, no durability or uptime guarantees
the service does not make.

## Anti-references

- The generic "dark + purple dev tool" (Linear/Vercel-adjacent) rendered
  entirely in stock defaults. The palette family is allowed; the tell is
  default-ness — distinctiveness must come from owned assets and usage, not
  template chrome.
- SaaS landing-page grammar: hero-metric blocks, identical icon-card grids, tiny
  uppercase tracked eyebrows above every section, gradient text, glassmorphism.
- Generic file-hosting framing (Dropbox-alike "store your files" pitches). The
  pitch is purpose-first: screenshots on PRs, artifacts from agents.

## Evidence on Hand

Real, usable, and already shipped — future work should reach for these rather
than invent equivalents:

- `docs/assets/readme-home.png`, `readme-comment.png`, `readme-screenshots.png`,
  `readme-file-page.png` — real product captures.
- A real managed comment on PR #436, linked from the README, that can be cited
  as a live demonstration.
- `VISION.md` — the open-source-first pledge and roadmap; marketing copy must
  stay consistent with it.
- Remotion social loops at `scripts/demos`.
- OG cards under `apps/web/public/og/`, regenerated by `scripts/og/render-og.mjs`.
- `/changelog` and its Atom feed are a live, self-updating proof surface.

**Absences that must not be fabricated:** there are no customer testimonials,
no named logos, no benchmark numbers, no uptime or durability SLA, and no
usage/adoption figures cleared for public use. `/admin/metrics` is internal.

## Product Principles

1. **The CLI is the hero.** Web surfaces demonstrate and manage what the CLI
   does; show real commands, real output, real hosted files — not marketing
   abstractions.
2. **One brand, one source of truth.** The design system (`@uploads/ui`) defines
   the visual language; the site consumes it. The two never drift.
3. **Signature over decoration.** Distinctiveness comes from owned assets (Geist
   Pixel's ELSH axis, the pixel chevron mark) used systematically — not added
   ornament.
4. **Deliberate, not default.** Every visual value is either chosen or
   explicitly kept with a recorded reason. No silent defaults.
5. **Agent-legible craft.** Pages work without JavaScript where possible,
   degrade cleanly, and stay fast at the edge — the audience includes headless
   agents and curl, not just browsers.

## Accessibility & Inclusion

WCAG 2.1 AA. The dark-only palette must hold ≥4.5:1 contrast for all text,
including muted metadata at small sizes. Full keyboard operability on the
signed-in surfaces (file browser, forms, navigation). Every animation ships a
`prefers-reduced-motion` alternative. Touch targets sized for mobile use on the
management surfaces.
