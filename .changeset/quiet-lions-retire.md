---
"@buildinternet/uploads": minor
---

`uploads config init` with no flags no longer seeds `UPLOADS_WORKSPACE=default`
into the config file. That entry outranked the workspace encoded in your token,
so it pinned every later `uploads login` to `default` no matter which workspace
the token was actually minted for. It now seeds only `UPLOADS_API_URL`; pass
`--workspace <name>` to set one explicitly.

`uploads login` on an account with no workspace yet now offers a name derived
from your GitHub login as a bracketed default (`… (lowercase, hyphens)
[octocat]:`). Press Enter to accept it, or type anything else to override. When
no name can be derived — no linked GitHub account, or the derived name is
reserved or already taken — the prompt is exactly as before.
