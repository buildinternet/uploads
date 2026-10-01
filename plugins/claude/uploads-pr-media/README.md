# uploads-pr-media mod

A Claude Code mod (function-hooks plugin) for the branch-staged screenshot
loop. It runs the local `uploads` CLI and needs no extra sign-in.

- **Band above the prompt.** Shows what is staged for the current branch, for
  example `uploads · 3 staged files on feat/x · attaches when the PR opens`.
  The band hides itself when nothing is staged. Press **Hide** to dismiss it
  for the session.
- **Attach on `gh pr create`.** After `gh pr create` opens a PR, the mod
  checks the branch's staged files:
  - Repo linked to this workspace: the GitHub App attaches them. The mod only
    reports it.
  - Repo not linked, or the link check failed: the mod runs
    `uploads attach --promote --pr <n> --repo <owner/name>`.
  - Repo linked to another workspace: the mod warns and does nothing.

  The mod also tells the model what happened, so it does not upload the files
  again.

## Requirements

- A Claude Code build with function hooks (mods).
- The `uploads` CLI on `PATH`, signed in. Without it the mod stays silent.

## Install

```
/plugin marketplace add buildinternet/uploads
/plugin install uploads-pr-media@uploads
```

## Develop

```
claude plugin validate plugins/claude/uploads-pr-media
claude plugin test plugins/claude/uploads-pr-media
claude --plugin-dir plugins/claude/uploads-pr-media
```

Ideas for more mods are tracked in
[#1050](https://github.com/buildinternet/uploads/issues/1050).
