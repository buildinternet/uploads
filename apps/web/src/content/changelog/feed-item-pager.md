---
title: "Page through a PR's screenshots"
date: 2026-09-15
tags: [platform, web]
---

A change feed now has an item page at `/feed/<id>/<item>` — previous / next, and
a 1 of N count. Syncing the managed PR comment creates that PR-scoped feed if
needed and points each image's click-through there. The image itself still
loads from the embed URL.

Standalone `/f/…` pages stay for one-off shares. Curated galleries are
unchanged.
