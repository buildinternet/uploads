---
"@buildinternet/uploads": minor
---

GitHub attachment import is on by default for linked repos, with junk filters: attachments authored by `[bot]` accounts and images under 200px on either side are skipped. A new `.uploads.yml` key, `ingestBotAttachments: true`, re-admits bot media on the webhook path; `ingestGithubAttachments: false` turns importing off per repo or per workspace as before.
