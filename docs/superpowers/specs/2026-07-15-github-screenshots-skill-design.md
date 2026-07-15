# In-repo `github-screenshots` workflow skill

**Date:** 2026-07-15
**Status:** Approved design, pre-implementation

## Problem

The skill that activates when someone wants to put a screenshot or recording
into a GitHub PR/issue lives outside this repo, in
`buildinternet/skills/github-screenshots`. It predates uploads.sh: it bundles
MVP shell scripts (Playwright capture, direct-R2 upload) that the CLI has since
superseded, and it merely _prefers_ the uploads CLI when configured. Anyone who
installs the uploads CLI or the `uploads-cli` skill today still has to discover
and install that secondary external skill before the common "attach a
screenshot to the PR" moment reliably routes to uploads.

Goal: installing uploads (`uploads install`) should make the
screenshot-into-GitHub workflow work out of the box, with no external skill.

## Non-goals (deliberate follow-ups, not this change)

- **No capture implementation.** No `uploads shot` CLI command, no bundled
  Playwright script. Capture stays tool-agnostic: agents use whatever
  browser/screenshot tooling their environment has.
- **No changes to the external skill yet.** Tombstoning
  `buildinternet/skills/github-screenshots` (and updating references to it,
  e.g. in user CLAUDE.md files) happens after this skill ships and proves out.
  Note: the new skill reuses the same name, so once both are installed the
  names collide — the external one should be uninstalled/tombstoned promptly.
- **No R2-fallback migration.** The direct-R2 path is the legacy the CLI
  replaced; it stays behind in the external skill and dies with it.

## Design

Two skills in this repo, split by altitude, both installed by
`uploads install`:

### 1. New: `skills/github-screenshots/SKILL.md` — the workflow skill

Owns the _moment_: "I have (or am about to have) an image or recording that
needs to end up in a PR, an issue, or in front of a person." Thin — it teaches
when and how to use uploads for this job and defers CLI detail to the
`uploads-cli` skill.

**Frontmatter description (trigger surface)** claims:

- Screenshots/images/diagrams destined for a PR description, issue body, or
  comment ("attach a screenshot to the PR", "add a before/after to the
  issue", "include a screenshot of …").
- Recordings and motion: GIFs and screen recordings of an interaction
  ("share a GIF of the flow", "record the bug and put it in the issue").
- The post-capture moment: user or agent just captured something visual and
  it needs to be shared.
- Sharing visuals with people generally: "get me a link I can paste in
  Slack / send to a teammate" (durable public URL).
- Steers away from drag-and-drop / `github.com/user-attachments` (not
  scriptable) and hand-rolled cloud-storage uploads.

It does **not** claim capture phrasings like "screenshot this page" — those
remain with the environment's browser tooling (and, for now, the external
skill).

**Body outline** (short — target well under 150 lines):

1. _Why_: GitHub's native image hosting is browser-session-only; `gh
… --body-file` needs an already-public URL. uploads.sh provides it.
2. _Get the visual_ (tool-agnostic): use the harness browser tools,
   Playwright MCP, OS screenshot, or an existing file; save locally. GIFs
   and video upload as-is (the optimizer only rewrites still images).
3. _Host + embed_: `uploads attach <files…>` for the common PR/issue case
   (managed comment, stable keys); `uploads put --pr/--issue` for URLs to
   hard-code in bodies; plain `uploads put` for a durable share link.
   Always use the returned `markdown`/`embedUrl` for GitHub embeds.
4. _Etiquette_: meaningful alt text, `--width` on large shots,
   before/after side-by-side table, GIF-vs-MP4 (GitHub markdown won't
   autoplay MP4 — prefer GIF or a still linking to the video URL).
5. _Setup + escalation_: not installed → `npm i -g @buildinternet/uploads`;
   not authed → `uploads login`; anything deeper (flags, keys, metadata,
   galleries, config) → see the `uploads-cli` skill / `uploads --help`.
6. _Cautions_: uploads are public; predictable `gh/…` keys; redact secrets.

### 2. Existing: `skills/uploads-cli/SKILL.md` — the CLI reference

Body unchanged. Frontmatter description trimmed to hosting/CLI mechanics
("upload this", "host this image", "public URL for this file", driving the
`uploads` CLI) so the two descriptions don't compete for the workflow
phrasings the new skill now owns. Keep enough overlap that either skill
resolving still leads to the same commands.

### 3. `uploads install` installs both

`packages/uploads/src/commands/install.ts` currently hardcodes one skill
(`SKILL_NAME = "uploads-cli"`). Change to a list
(`["uploads-cli", "github-screenshots"]`), one `npx skills add` step per
skill (the `skills` CLI takes one `--skill` per invocation), reported
separately in human and `--json` output (e.g. keyed results or an array),
same continue-on-failure semantics as today. Help text and dry-run output
updated to show both.

### 4. Docs

- `AGENTS.md` layout table: add `skills/github-screenshots` and describe the
  split (workflow skill vs CLI reference); note both are kept in sync with
  the CLI.
- `docs/cli.md` / README mention of `uploads install`: reflect that it
  installs two skills, if they enumerate.

## Testing

- Existing install-command tests updated for the two-skill list (command
  construction, `--json` shape, dry-run).
- `uploads install --dry-run` shows both `npx skills add … --skill …` steps.
- Skill lint/review pass on the new SKILL.md (description length, triggers).
- Manual: fresh-agent trigger check — "attach this screenshot to the PR"
  routes to the new skill; "what flags does uploads put take" routes to
  `uploads-cli`.

## Follow-ups (out of scope, tracked for the retirement path)

1. Tombstone `buildinternet/skills/github-screenshots` (pointer to
   `npm i -g @buildinternet/uploads && uploads install`), or delete it.
2. Update external references to the old skill (global CLAUDE.md files).
3. Optional: `uploads shot <url>` capture subcommand (Playwright resolved
   on demand), at which point the new skill can claim capture triggers too.
