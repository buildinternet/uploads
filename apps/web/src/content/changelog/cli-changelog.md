---
title: "Read the changelog from the CLI"
date: 2026-09-10
tags: [cli]
---

`uploads changelog` prints the latest product updates in your terminal, then a
link to the full list at [uploads.sh/changelog](/changelog). Agents get the same
feed from `--json` or the MCP `changelog` tool.

```bash
uploads changelog
uploads changelog --limit 10
uploads changelog --json
```
