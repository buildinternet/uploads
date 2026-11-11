---
"@buildinternet/uploads": minor
---

Uploads aimed at a repo now go to the workspace that repo is linked to. When you're a member of that workspace, `uploads put`, `uploads attach` and `uploads screenshot` switch to it for PR, issue and staged uploads and print `>> sending to workspace "<name>"`; your login token works there too. They still stop with a clear error when you aren't a member. `uploads login` now saves a `upk_…` token, which works in every workspace your account belongs to.
