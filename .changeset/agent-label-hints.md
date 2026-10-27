---
"@buildinternet/uploads": patch
"@uploads/plugin": patch
---

`put --help` now opens with the labels the PR comment shows (`--meta path=`, `--screen`, `--state`, `--caption`) and a labeled example. After a comment sync, `put` and `attach` end with a line saying the attachments comment already shows the files. The missing-label tip says labels show in the PR comment, and suggests `--screen` for apps. The github-screenshots skill's quick path shows labeled `put` calls.
