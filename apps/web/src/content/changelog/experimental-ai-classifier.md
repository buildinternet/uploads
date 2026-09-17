---
title: "Experimental: AI labels on upload"
date: 2026-09-17
tags: [platform]
---

An **experimental** classifier can now tag files as they arrive. When
Flagship `llm-file-classifier` serves on for a workspace (org allowlist),
a successful upload may later grow server-owned `ai.tags`, `ai.summary`,
and `ai.kind` metadata — the same queryable map agents already read with
`uploads meta get` and `uploads find`.

It is off by default. Classifier errors never fail the upload. Workers AI
calls go through Cloudflare AI Gateway. See the
[agent docs](/docs/agents#experimental-ai-tags) for how to read the labels.
