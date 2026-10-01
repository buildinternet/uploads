---
title: "Staged media band for Claude Code"
date: 2026-10-01
tags: [platform, cli]
---

The uploads plugin for Claude Code now shows what is staged for your branch.
A band above the prompt reads "N uploads waiting for a PR on `<branch>` ·
attaches when it opens". Expand it to see one row per staged file, with
before/after pairs sharing a row and each half linking to its uploads.sh file
page. It draws in the terminal and in the Desktop app's Code tab, and needs
Claude Code 2.1.287 or later.

When `gh pr create` opens a PR, the plugin attaches the staged files. If the
repo is linked to your workspace, the GitHub App attaches them. Otherwise the
plugin runs `uploads attach --promote` for that PR. Clear **Attach staged
files on gh pr create** in `/plugin` to turn the automatic attach off.

Two CLI changes go with it. `uploads staged` and the `staged` MCP tool no
longer list files already promoted to a PR. The pre-PR reminder now says the
files attach automatically when the repo is linked to your workspace.
