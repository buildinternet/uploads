# `uploads put` auto `gh.*` metadata — design

Date: 2026-07-13
Related: buildinternet/uploads#159 (per-file metadata follow-ups); motivated by the
`buildinternet` workspace sweep, where 65 `screenshots/` objects had lost their
PR/issue linkage because they were hosted via the default `put` path, which
captures no `gh.*` metadata.

## Problem

`uploads put` has two gaps around GitHub context:

1. **Default path captures nothing.** A plain `uploads put shot.png`
   (`--repo`/`--ref` → `screenshots/<repo>/<ref>/…` key) writes no `gh.*`
   metadata, so the `/f/` file page shows no "Attached to" row even when the
   shot was taken while working on a PR. This is how the `github-screenshots`
   skill's default flow uploads, so every such screenshot lands context-less.
2. **`put --pr`/`--issue` writes a `gh/` key but no `gh.*` metadata.**
   `runAttach` stamps the four `gh.*` pairs from the resolved target
   (`commands.ts` ~L401); `runPut` does not merge them, so the stable
   attachment key exists without the queryable metadata that `attach` produces.

The API and CLI already support everything needed: `put` accepts repeatable
`--meta k=v`, the D1 metadata tier stores `gh.*`, and the public `/f/` page
derives an "Attached to" link from `gh.repo`/`gh.kind`/`gh.number`. The only
gap is that `runPut` never derives or attaches those pairs.

## Goal

One uniform rule: **whenever `put` has a GitHub target — explicit or
auto-resolved — it stamps the four `gh.*` pairs into the object's metadata.**
The change is entirely in `packages/uploads`; the `github-screenshots` skill and
MCP surface are untouched and inherit the behavior through `uploads put`.

## Behavior

In `runPut`, after `--meta` is parsed into `metadata`:

- **Explicit target** (`--pr`/`--issue` present): merge
  `ghMetadataFromTarget(ghTarget)` into `metadata` (gap #2 fix). Key layout
  unchanged (`gh/…` as today). Target pairs win over a same-key `--meta`
  extra, matching `runAttach`.
- **Auto target** (no `--pr`/`--issue`, auto enabled): resolve a target and
  merge its `gh.*` pairs; **key layout stays `screenshots/<repo>/<ref>/…`**
  (auto never rewrites the key — only explicit attach produces `gh/` keys).
  Here explicit `--meta` wins over the auto-derived pairs (auto is inferred,
  yields to anything the user typed).

Auto resolution picks its target in this order:

1. `--ref` is a positive integer → classify it once via
   `gh api repos/<owner>/<repo>/issues/<n>` (`pull_request` field present →
   `pull`, else `issue`); number = that ref. New helper `classifyGhNumber`.
2. otherwise → `resolveCurrentPullRequest(repo, run)` (existing helper:
   `gh pr view` on the current branch → PR).

Auto resolution is **best-effort and never fails the upload**: missing `gh`,
no PR for the branch, an API error, or an unresolvable repo → skip the metadata
and upload normally, silently (no note on skip). When `gh.*` metadata IS
attached — explicit or auto — `runPut` prints one stderr note in human format
(`>> attached to <gh.ref>`), the same shape as the `--comment` note.

## Control surface

On by default. Precedence (first match wins):

- `--auto` flag → force on (overrides repo config).
- `--no-auto` flag → off for this run.
- `UPLOADS_NO_AUTO_META=1` (env or `.uploads` config-file key) → off at
  repo/user level.
- default → on.

`--no-git` (or no resolvable repo) also yields no auto target, since there's
nothing to resolve. Explicit `--pr`/`--issue` short-circuits auto resolution
(the flag is the target).

## Code changes

1. **`github-gh.ts`** — add `classifyGhNumber(repo, num, run): GhTarget | undefined`
   (returns `undefined` on any failure; caller skips). Reuse existing
   `resolveCurrentPullRequest`.
2. **`config-file.ts`** — add `UPLOADS_NO_AUTO_META` to `UPLOADS_CONFIG_KEYS`
   and parse into `PutDefaults.noAutoMeta` in both the raw and env parsers,
   mirroring `UPLOADS_NO_GIT`.
3. **`commands.ts` `runPut`** — merge `gh.*` for the explicit-target path (gap
   #2); add the auto path; parse `--auto`/`--no-auto`; update `PUT_HELP`.
4. **Tests** — `commands` suite, fake `CommandRunner` (the `run` seam attach
   tests already use). Cases: explicit `--pr` stamps `gh.*`; numeric `--ref`
   classified pull vs issue; branch → resolved PR; no-PR → no metadata +
   success (exit 0); `--no-auto`/`UPLOADS_NO_AUTO_META` suppress; explicit
   `--meta` wins on the auto path; explicit target wins on the `--pr` path.
5. **Docs** — refresh the `put` help/CLI notes to describe auto behavior and the
   `--no-auto` / `UPLOADS_NO_AUTO_META` opt-out. Add a changeset.

## Out of scope

- No key-layout change; the default path stays `screenshots/…`.
- No data migration — the existing `buildinternet` objects were already
  backfilled by hand (49/65; the remainder have no resolvable PR).
- MCP `put` tool arguments unchanged.
- The `github-screenshots` skill is not modified.

## Verification

`pnpm test` + `pnpm lint` in `packages/uploads`; plus a live-free
`uploads put … --dry-run --format json` showing the derived `gh.*` in the
metadata preview (fake or real `gh`).
