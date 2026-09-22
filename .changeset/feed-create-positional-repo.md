---
"@buildinternet/uploads": patch
---

`uploads feed create owner/repo` uses that repository. A bare repo argument was ignored, so every create in one checkout reused the current git repo's feed.
