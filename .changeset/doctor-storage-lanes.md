---
"@buildinternet/uploads": minor
---

`uploads doctor` now reports the workspace's storage lanes: hosted storage vs your own bucket, how many previous lanes still serve old files, and whether the active lane is healthy — read from a new bearer-safe summary on the usage endpoint. Against older servers it keeps the honest "not checked from the CLI" line.
