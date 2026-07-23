# GitHub App discoverability — design

**Date:** 2026-07-23
**Status:** approved, ready to plan

## Problem

The `uploads-sh` GitHub App is the recommended way to run uploads.sh — with it, the
attachments comment posts as the bot rather than under a contributor's own GitHub
account, and screenshots staged on a branch promote themselves the moment the PR
opens with no CLI call. Today nothing surfaces it. It has one docs page
(`/docs/github-app`), reachable only from the docs hub, where it is explicitly
framed as **optional**. The footer, the homepage agent prompt, and the workspace
rail never mention it.

## Scope

Copy, markup, and one new constant module. No new API, no logic changes, no
schema changes.

## 1. Shared URL constant

New `apps/web/src/lib/github-app.ts`:

```ts
export const GITHUB_APP_URL = "https://github.com/apps/uploads-sh";
export const GITHUB_APP_INSTALL_URL = `${GITHUB_APP_URL}/installations/new`;
```

Two URLs because the links mean two different things:

- `GITHUB_APP_INSTALL_URL` (`/installations/new`) lands on GitHub's repo picker.
  Use it wherever the label is an imperative — the rail CTA, the docs install
  section.
- `GITHUB_APP_URL` is the App's public page, which carries the purpose-first
  pitch. Use it where the link means "learn what this is" — the agent prompt, and
  the existing "the App" prose links in the docs page.

`apps/web/src/pages/docs/github-app.astro:7` currently hardcodes the app URL; it
imports the constant instead. The footer consumes neither — it links to the
internal docs page (§2).

## 2. Footer

`apps/web/src/components/Footer.astro` — add to the `Product` column, between
Docs and Agent guide:

```ts
{ label: "GitHub App", href: "/docs/github-app" }
```

Points at the docs page, not github.com, so the footer teaches before it asks for
an install. That page is also the App's configured Setup URL, so a user who
installs from there returns to it and sees the post-install banner.

The adjacent `Project` column already has a link labeled **"GitHub"** (the source
repo). "GitHub" and "GitHub App" side by side in a 12px mono footer read as the
same destination, so the repo link is renamed **"Source"** — which is already what
the compact footer variant calls it.

## 3. Homepage agent prompt

`apps/web/src/pages/index.astro` — the `agentPrompt` string.

An agent cannot install a GitHub App: it needs a browser session and repo-owner
(often org-admin) permission. So this is not a setup step the agent performs, it
is a hand-off — the same shape as the existing `uploads login` line ("wait for me
to approve it").

Appended after the staged-loop block, before the AGENTS.md line:

> Last: tell me to install the GitHub App at https://github.com/apps/uploads-sh —
> you can't, it needs my browser and repo-owner permission. With it, comments post
> as the `uploads-sh` bot and staged screenshots promote themselves when the PR
> opens.

## 4. Workspace rail CTA

`apps/web/src/layouts/WorkspaceLayout.astro` — the `quick actions` section, which
today holds exactly one muted link (`invite teammate`), becomes:

```
[ install github app → ]     CTA: bordered, --accent, opens GITHUB_APP_INSTALL_URL
invite teammate              unchanged muted link
```

Server-rendered static markup. No `plan` read, no fetch, no client JS. External
link, so `target="_blank" rel="noopener noreferrer"` — matching the connected-work
rows above it. Styled in the component's existing scoped `<style>` block against
`--accent` / `--line`.

Weight: clearly above the invite link, but not a banner. It shows to every
workspace including ones that already installed, so it must not nag.

### Accepted trade-off: no install detection

There is no session-authenticated way to know whether a workspace has the App
installed. `GET /v1/:workspace/github/health` is workspace-token auth
(`workspaceAuth` + `files:read`), and the repo-links listing is admin-only — the
web app holds a Better Auth session, not a workspace token.

Detection is therefore **out of scope**. The CTA shows unconditionally. A
follow-up issue covers a session-auth `GET /me/workspaces/:name/github-status`
(App JWT installation lookup, KV-cached, degrade-to-shown) that would hide it once
installed.

## 5. Docs reframe: optional → recommended

The honest fallback stays; it just stops being the opening frame.

| Location                                 | Now                                                                                        | After                                                                                                                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pages/docs.astro:101` hub card          | "Optional install: comments post as uploads-sh[bot] and private-repo titles show up."      | "Recommended. Comments post as the `uploads-sh` bot and staged screenshots promote themselves when the PR opens."                                                        |
| `pages/docs/github-app.astro:41` callout | "…covers the optional GitHub App that posts it."                                           | "…covers the GitHub App that posts it."                                                                                                                                  |
| `pages/docs/github-app.astro:47` lede    | "Everything in these docs works without the App. Installing the App upgrades four things:" | Opens with "Installing the App is the recommended setup." The four-item list is unchanged; "everything still works without it" becomes a one-line note _under_ the list. |
| `public/llms.txt:12`                     | "optional install for…"                                                                    | "recommended install for…"                                                                                                                                               |

The llms.txt line matters as much as the page — it is the machine-readable index,
and it must not contradict the prose an agent also reads.

Card order on the `/docs` hub is deliberately **unchanged**.

`README.md` needs no change: it never framed the App as optional (its only
mention, at line 101, is a neutral conditional about promotion timing).

## 6. Bot-name copy rule

GitHub renders a bot's name as `uploads-sh` with a separate **bot** chip beside
it. Writing `uploads-sh[bot]` in prose duplicates that chip.

**Rule:** prose says the `uploads-sh` bot.

Two shipped wireframes already double-label — they render `uploads-sh[bot]` _and_
a sibling `.bot-chip` reading "bot":

- `pages/index.astro:553`
- `pages/docs/attach-pull-request-images.astro:59`

Both `.user` spans drop to `uploads-sh`. The chip beside them is left alone.

**Unchanged** — these are literal strings, not prose:

- `pages/docs/github-app.astro:84` — a sample of actual CLI stdout.
- `packages/uploads/CHANGELOG.md`, `skills/uploads-cli/SKILL.md`.
- The comment renderers, their golden fixtures, and anything comparing against
  the real GitHub author name.

## Testing & verification

No new unit tests: this is copy, markup, and one constant with no branching.

1. `pnpm typecheck`, `pnpm lint`, `pnpm build` (web).
2. Existing golden-fixture tests must still pass — proof that the bot-name copy
   rule did not leak into the renderers.
3. Browser: workspace rail CTA (target, styling, weight against the invite link);
   footer at desktop and at the 560px breakpoint where `.cols` reflows.
4. Screenshot the rail and footer for the PR.

## Follow-ups (filed, not built)

- Session-auth workspace GitHub install status, so the rail CTA can hide once the
  App is installed.
