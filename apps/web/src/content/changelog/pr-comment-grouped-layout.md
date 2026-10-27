---
title: "Tighter PR comment layout"
date: 2026-10-27
tags: [github]
---

The managed PR comment packs screenshots more tightly. Phone screenshots now
share rows, up to three across, instead of one per row with empty space
beside each.

When most shots have a `--screen` or `--meta path`, the comment groups them
under a heading per screen or page. Each group shows its before and after
first, then its other shots, and captions only show what the heading doesn't.

Once a comment has a before/after pair, a new screen with only an after shot
gets its own row, with a dashed "No before shot" placeholder in the empty
cell. The footer is now just the `uploads put` command and a docs link.
