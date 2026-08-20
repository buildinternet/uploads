<div align="center">

<img src="docs/assets/readme-home.png" alt="uploads.sh — the missing upload command for coding agents" width="760">

<h1>uploads</h1>

**The missing upload command for coding agents.**

A lightweight file-hosting service on Cloudflare Workers. Agents capture
screenshots as they work. When the pull request opens, all screenshots appear
in one tidy comment that updates automatically on each revision. Built on
[files-sdk](https://files-sdk.dev) so the storage layer is provider-agnostic
(R2 today; any files-sdk adapter later).

<p>
  <a href="https://uploads.sh"><b>uploads.sh</b></a> &nbsp;·&nbsp;
  <a href="https://uploads.sh/docs"><b>Docs</b></a> &nbsp;·&nbsp;
  <a href="https://www.npmjs.com/package/@buildinternet/uploads"><b>npm →</b></a> &nbsp;·&nbsp;
  <a href="#use-it">Use it</a> &nbsp;·&nbsp;
  <a href="#what-it-looks-like">What it looks like</a> &nbsp;·&nbsp;
  <a href="#whats-in-this-repo">What's in this repo</a> &nbsp;·&nbsp;
  <a href="#local-development">Develop</a>
</p>

<p>
  <a href="https://skills.sh/buildinternet/uploads"><img alt="skills.sh" src="https://skills.sh/b/buildinternet/uploads"></a>
  <a href="https://github.com/buildinternet/uploads/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/buildinternet/uploads/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://www.npmjs.com/package/@buildinternet/uploads"><img alt="npm (CLI)" src="https://img.shields.io/npm/v/@buildinternet/uploads?color=cb3837&label=%40buildinternet%2Fuploads&logo=npm"></a>
  <a href="https://github.com/apps/uploads-sh"><img alt="GitHub App: uploads-sh" src="https://img.shields.io/badge/GitHub%20App-uploads--sh-181717?logo=github&logoColor=white"></a>
  <a href="https://deepwiki.com/buildinternet/uploads"><img alt="Ask DeepWiki" src="https://deepwiki.com/badge.svg"></a>
  <a href="LICENSE"><img alt="License: Apache 2.0" src="https://img.shields.io/badge/license-Apache%202.0-blue"></a>
</p>

<p><sub>
  <b>Under active development.</b> uploads.sh is being built in the open, so
  APIs (including auth) can still change. Feedback is welcome — open an issue.
</sub></p>

</div>

---

## What is this?

You add a screenshot to GitHub by dragging it into the comment box. Agents
can't — GitHub's native image hosting only works through a browser session, so
an agent that just captured a before/after has nowhere to put it.

**uploads** gives agents that missing step, and it works while the branch is
still in progress. An agent runs `uploads put ./after.png` the moment a change
is visible; on a branch that stages the file automatically — no PR required, no
flag to remember. Capture at every milestone and there is nothing to reassemble
at the end: when the pull request opens, everything staged is promoted into one
tidy comment that updates automatically on each revision.

Keys are hash-free, so re-uploading the same filename overwrites in place and
the URL never changes — every embed of it updates at once. Workspaces keep
tenants (and their budgets and key policies) apart.

This repo is the source of the canonical deployment at
[uploads.sh](https://uploads.sh): the API worker, auth worker, MCP server, the
Astro web app, and the `@buildinternet/uploads` CLI (published to npm from
[`packages/uploads`](packages/uploads)).

## What it looks like

One comment per PR, rewritten in place on every sync. Files tagged
`--state before` and `--state after` pair into a side-by-side table; anything
else lands below it.

<div align="center">
  <a href="https://github.com/buildinternet/uploads/pull/436#issuecomment-5052307515"><img src="docs/assets/readme-comment.png" alt="The managed attachments comment on a pull request, with a before/after pair rendered side by side under Before and After headings" width="760"></a>
</div>

<sub>The real comment on
[#436](https://github.com/buildinternet/uploads/pull/436#issuecomment-5052307515).</sub>

Pairing is by `--meta path=…` when several pairs share a comment (one `before`
and one `after` per path), and falls back to filenames that differ only by a
`before`/`after` token — `hero-before.webp` with `hero-after.webp`.

Everything you attach also lands in your workspace, grouped by where it came
from — pages by `path`, projects by `repo` or `app` — and browsable from one
place.

<div align="center">
  <img src="docs/assets/readme-screenshots.png" alt="The screenshots view in a workspace, with uploads grouped into collapsible sections by project and path" width="760">
</div>

<sub>The screenshots view groups uploads by project and path.</sub>

Open any file for a share page: copy-ready embeds (Markdown, HTML, and more),
the raw URL, and a delete button.

<div align="center">
  <img src="docs/assets/readme-file-page.png" alt="A file share page showing the media preview, a Copy-as embed menu, file details, and a Delete file action" width="760">
</div>

<sub>Each file's share page — copy-ready embeds, details, and delete.</sub>

## Use it

Install the CLI and sign in once:

```bash
npm install --global @buildinternet/uploads
uploads login
```

Then capture as you work. On a branch, a bare `put` stages the file against
that branch — no PR needed yet, and no flag to remember:

```bash
uploads put ./before.png --state before
uploads put ./after.png --state after
uploads staged                 # what's queued, and whether it will auto-attach
```

Open the PR however you normally would (`gh pr create`, the GitHub UI) and the
staged files promote themselves into one managed attachments comment —
instantly if the [GitHub App](https://uploads.sh/docs/github-app) is installed,
otherwise on your next `uploads attach` (or `uploads attach --promote`).

Already have a PR or issue open? Target it directly, no staging step:

```bash
uploads attach ./before.png ./after.png
```

`attach` detects the repository and current PR through `gh`, uploads all files,
and creates or updates that same one comment. Both commands run under `npx
@buildinternet/uploads …` without a global install.

Sign in with GitHub or a magic link, then create your own workspace or accept
an invite into one — see [enrollment](docs/enrollment.md). Hosted files are
public, including media attached to private repositories. Do not upload secrets
or sensitive UI.

**Teach your agent the loop.** `uploads install` wires in the agent skills and
the MCP server, so future sessions capture at each visual milestone on their
own instead of being asked. The skills also install standalone, into any agent
runtime, without checking anything out:

```bash
npx skills add buildinternet/uploads
```

That installs three skills: `github-screenshots` (visuals → PRs/issues),
`uploads-cli` (full CLI reference), and `annotate-screenshots` (callouts and
redaction on a capture).

Point at what changed before you attach — bake boxes, arrows, labels, or a
solid redaction into the image:

```bash
uploads screenshot http://localhost:4321/settings --via local --annotate ./callouts.json
uploads annotate ./shot.png --spec ./callouts.json --out ./shot.marked.png
```

Full CLI usage — key conventions, stable PR/issue attachments, annotations,
managed comments, and public galleries — lives in [docs/cli.md](docs/cli.md).
REST routes are in [docs/api.md](docs/api.md).

## What's in this repo

| Path                           | What                                                                                |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| `apps/api/`                    | Hono worker — REST API, deploys to `api.uploads.sh`                                 |
| `apps/auth/`                   | Better Auth worker — sessions, enrollment, device flow                              |
| `apps/mcp/`                    | Remote MCP server                                                                   |
| `apps/web/`                    | Astro site — uploads.sh, account and admin UI                                       |
| `packages/storage/`            | `@uploads/storage` — files-sdk adapter factory                                      |
| `packages/uploads/`            | `@buildinternet/uploads` — CLI + client, publishes to npm                           |
| `packages/ui/`                 | `@uploads/ui` — shared design system                                                |
| `packages/billing/`            | `@uploads/billing` — plans and limit resolution                                     |
| `packages/email/`              | `@uploads/email` — transactional email templates                                    |
| `packages/errors/`             | `@uploads/errors` — shared error codes and wire format                              |
| `skills/github-screenshots/`   | Workflow skill — visuals into PRs/issues/share links                                |
| `skills/annotate-screenshots/` | Callouts and redaction — `uploads annotate` / `screenshot --annotate`               |
| `skills/uploads-cli/`          | Agent skill for driving the CLI                                                     |
| `hooks/`                       | Shared pre-PR screenshot hook (`uploads hook pre-pr-screenshot`) for Claude + Codex |
| `plugins/claude/`              | Claude Code plugin config (skills path, MCP, commands)                              |
| `.claude-plugin/`              | Claude marketplace catalog + plugin manifest                                        |
| `.codex-plugin/`               | Codex plugin manifest — skills, hosted MCP, and shared hook                         |
| `.mcp.json`                    | Hosted MCP server for both plugins (`https://agents.uploads.sh/mcp`)                |
| `assets/logo.png`              | Pixel chevron mark for the Codex / OpenAI plugin listing                            |

The workers and web app are separate deployables. All storage access goes
through `createStorage()` in `packages/storage` — adding a provider is one new
case plus peer deps, no API changes.

## Docs

Product docs live at https://uploads.sh/docs. The map for this folder is [docs/README.md](docs/README.md).

| Doc                                                | Contents                                             |
| -------------------------------------------------- | ---------------------------------------------------- |
| [cli](docs/cli.md)                                 | CLI usage, GitHub embeds, keys, galleries            |
| [api](docs/api.md)                                 | REST routes                                          |
| [local-dev](docs/local-dev.md)                     | Manual setup, dev stack, smoke tests                 |
| [enrollment](docs/enrollment.md)                   | Agent login, scopes, expiry, and migration           |
| [private-attachments](docs/private-attachments.md) | Randomized private-repo attachment URLs and rotation |
| [roadmap](docs/roadmap.md)                         | Planned features                                     |

How to set up, test, and open a pull request:
[CONTRIBUTING.md](CONTRIBUTING.md). Agent working conventions live in
[AGENTS.md](AGENTS.md). Agents that land on this repo should start at
[llms.txt](llms.txt) (product use vs monorepo contribute). The product site
serves https://uploads.sh/llms.txt and https://uploads.sh/llms-full.txt.

## Local development

**Prerequisites:** Node ≥24 and pnpm ≥11 (`corepack enable`). No Cloudflare
account needed for the core local loop — `wrangler dev` simulates R2, KV, and
D1 on disk:

```bash
pnpm bootstrap        # one-command setup: tooling, deps, env vars, local D1, default workspace
pnpm dev              # API on :8787 (local R2 + KV + D1)
```

`bootstrap` is idempotent, and `pnpm doctor` diagnoses a setup without changing
it. The rest of the loop — the authenticated dev stack, the check and test
gates, and how to open a pull request — is in
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache 2.0](LICENSE).
