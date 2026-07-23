---
"@buildinternet/uploads": minor
---

Add `uploads update`. It upgrades the globally installed CLI, then re-runs
`uploads install` so the agent skills and the MCP registration match the new
version. When the CLI is already current it still refreshes them, because they
drift on their own. The upgrade step detects npm, pnpm, and bun global
installs, and refuses to overwrite a workspace checkout or an npx cache. The
existing update hint and help banner now name `uploads update`.
