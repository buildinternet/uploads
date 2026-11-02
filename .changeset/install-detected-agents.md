---
"@buildinternet/uploads": patch
---

`uploads install` now installs skills only into the agents already on your machine, instead of creating a skills folder in your home directory for every agent the skills CLI supports. If it finds no agent, it skips skills and prints the `npx skills add` command to run yourself.
