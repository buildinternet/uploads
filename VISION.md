# uploads — evidence is part of the work

An agent restyles a settings page and captures a before and an after with
`uploads put` — no PR exists yet, so the files stage against the branch. Three
commits later a PR opens, already furnished: one attachments comment, the pair
rendered side by side, every capture from the branch in its place. The reviewer
sees the change before reading a line of the diff.

That is the whole vision, played forward: **when agents do the work, the
evidence of the work should arrive with it — automatically, in the places
humans already review.**

## North star

Every change a coding agent ships arrives with proof attached. Not because a
human asked, not as a final assembly step, but because capturing evidence is
part of the loop itself — as unremarkable as committing.

uploads is deliberately infrastructure, not intelligence. It doesn't decide
what to screenshot or judge whether the change is good. It removes the one step
agents cannot perform — GitHub's image hosting only works through a browser
drag-and-drop — and makes the surrounding workflow disappear.

## Principles

- **Stage as you go, not assemble at the end.** Capture at every visual
  milestone. A bare `put` on a branch stages the file automatically; there is
  nothing to remember and nothing to reassemble when the PR opens.
- **One comment, rewritten in place.** A PR gets exactly one managed
  attachments comment, updated on every sync. Evidence accumulates without
  noise; the comment self-heals if duplicated.
- **URLs that never lie.** Keys are hash-free: re-uploading the same filename
  overwrites in place and the URL never changes, so every embed of it updates
  at once. An embed in a six-month-old comment shows the current file.
- **Meet reviewers where they are.** The destination is the GitHub PR, the
  issue, the shared link — not a dashboard you have to visit. uploads succeeds
  when nobody thinks about uploads.
- **Agents are the primary user.** The CLI, the MCP servers, the skills, and
  the error messages are designed for an agent operating unattended. Humans get
  the same tools; agents get them first.
- **Honest by default.** Hosted files are public. Docs say so plainly. Limits,
  plans, and deletion policies are documented and enforced, not implied.
- **Open source first.** The project is primarily open source (Apache 2.0) and
  stays that way. Broader team adoption may come with an optional subscription
  for the hosted cloud option — the workflow itself is never behind it.

## The loop

The core workflow, end to end:

1. **Capture** — the agent screenshots its work (its own tooling, or the
   built-in `uploads screenshot` renderer).
2. **Stage** — `uploads put ./after.png --state before|after` on a branch
   stages the file against that branch. No PR required, no flag to remember.
3. **Promote** — when the PR opens, staged files promote into the managed
   attachments comment: instantly via the GitHub App, or on the next
   `uploads attach`.
4. **Pair** — files tagged `before`/`after` render side by side, paired by
   `--meta path=…` or by filename convention.
5. **Sync** — every subsequent push re-runs the loop; the comment is rewritten
   in place, empties itself when attachments are removed, and repairs
   duplicates.

`uploads install` teaches an agent runtime this loop once — skills plus MCP —
so future sessions capture on their own instead of being asked.

## Surfaces

One storage layer, reached however the agent (or human) already works:

| Surface                        | What it is                                                                 |
| ------------------------------ | -------------------------------------------------------------------------- |
| CLI (`@buildinternet/uploads`) | The canonical interface: put, attach, staged, find, galleries, screenshot  |
| Local MCP (stdio)              | The CLI's capabilities inside any MCP-capable agent                        |
| Hosted MCP (agents.uploads.sh) | Remote server behind OAuth 2.1 — no local install at all                   |
| GitHub App                     | Webhook-driven promotion and comment sync the moment a PR opens            |
| REST API                       | Everything the CLI does, for anything that speaks HTTP                     |
| Web (uploads.sh)               | File pages, galleries, workspace settings, admin                           |
| Skills                         | `github-screenshots` and `uploads-cli`, installable into any agent runtime |

Discovery is machine-first too: `/.well-known/integrations.json`, OpenAPI,
OAuth protected-resource metadata. An agent that has never heard of uploads
should be able to find it, authenticate, and use it without a human in the
loop.

## Workspaces and trust

Workspaces keep tenants apart — budgets, key policies, membership, plan limits.
Self-serve registration is live; teams grow by invitation; billing is
org-scoped. Tokens are scoped tightly (file, workspace, operator tiers) and
fail closed. Deletion is soft with a grace period, because agents make
mistakes and humans change their minds.

The storage layer is provider-agnostic by construction (files-sdk; R2 today).
The service should never be the reason your files are stuck somewhere.

## Roadmap

Two beliefs drive where this goes. First, as agents ship more and more, being
able to quickly observe what they are actually doing improves how software
gets developed — and how fast teams can move. Second, evidence compounds:
when hundreds of pull requests stream in every day, teams that want to compile
release visuals or meaningful product release notes have nothing to draw from
unless artifacts were captured along the way. uploads should make both of
these normal.

- **More storage providers.** The storage layer is provider-agnostic by
  construction (files-sdk), but today it is strictly R2. We know that needs to
  change — especially for self-hosted deployments, where files-sdk already
  does most of the work.
- **Bring your own storage.** A world where a team points uploads at their
  existing storage and uses the product as a gateway — the workflow layer on
  top of infrastructure they already pay for, at minimal to no cost, in the
  spirit of Better Auth or OpenRouter. This also means avoiding user-seat
  limitations wherever possible: agents are the primary user, and agents
  support workspaces, not seats.
- **Release management.** From per-PR evidence to per-release narrative:
  assembling the captures from a stream of merged PRs into the raw material
  for release notes, changelogs, and launch visuals.
- **Richer evidence.** Video with poster frames is built and gated; recordings
  of interactions, visual diffs, and rendered artifacts (PDFs, diagrams) follow
  the same staging loop.
- **Deeper review integration.** Before/after pairing is the start. Evidence
  grouped by commit, linked to the lines it illustrates, queryable across a
  repo's history ("show me every screenshot of the checkout page").
- **Every agent runtime.** Claude Code is the first-class citizen today; the
  skills, MCP servers, and discovery metadata exist so the loop works
  identically from any agent, IDE, or CI job.
- **Evidence beyond GitHub.** GitHub is the first destination, not the
  boundary. The underlying idea — easily shareable, packaged bundles of assets
  tied to code or a deliverable — extends to whatever surface a team reviews
  or ships on. Galleries are the deliberate exploration of that: a curated,
  linkable bundle of evidence that stands on its own, no PR required.
- **Annotations.** Marking up the evidence itself — callouts, highlights, and
  notes on a capture — so a screenshot can carry the reviewer's (or the
  agent's) commentary with it.
- **Automatic redaction.** Detecting and redacting sensitive content in
  uploads — tokens, emails, personal data caught in a capture — before it
  ships to a public URL.
- **Private hosting.** Hosted files are public today, stated plainly. Scoped,
  private evidence — for teams whose UI can't be on the open web — is on the
  roadmap, not a quiet promise.

## Non-goals

- **Generic file hosting.** uploads is purpose-built for work-in-progress
  evidence. It is not a CDN, a Dropbox, or an image optimizer.
- **Judging the work.** No AI review, no screenshot analysis, no opinions. The
  evidence layer stays neutral so every reviewer — human or agent — can trust
  it.

## Status

Shipped and running in production: the staging loop, GitHub App promotion,
before/after pairing, managed-comment self-healing, hosted and local MCP,
OAuth 2.1, self-serve workspaces, plans and billing, galleries, the screenshot
renderer, and the agent skills. This repo furnishes its own PRs with the tool
it ships.

Under active development, in the open. APIs (including auth) can still change.
Feedback is welcome — open an issue.
