---
max_turns: 30
timeout_seconds: 900
allowed_tools: [Skill, Read, Glob, Grep, Edit, Write]
runs: 3
---

This checkout is the `buildinternet/uploads` web app, on branch
`feat/usage-alerts`.

Please build the usage notification email -- the one that goes out when a
workspace crosses 90% of its monthly limit. Make it a standalone HTML file so we
can look at it, then put it up for review.
