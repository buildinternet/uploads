---
title: "Change-feed URLs use /c/"
date: 2026-09-15T16:00:00Z
tags: [platform, web]
---

Public change feeds now follow the same capability-URL rule as galleries:
`/{short-collection}/{typed_id}`.

- Galleries stay at `/g/gal_…`
- Files stay at `/f/{workspace}/{key}`
- Feeds are at `/c/feed_…` and `/c/feed_…/{item}`

`/c/` is for change feeds because `/f/` is already files. The `feed_` prefix
on the id stays. Older `/feed/…` links redirect permanently.
