---
"@buildinternet/uploads": minor
---

`uploads admin invite create --email <address>` now delivers the invite magic link
by email instead of printing it. The API sends from `invites@uploads.sh` via
Cloudflare Email Sending; delivery is rate-limited per recipient and audit-logged
without the code or link. On success the CLI confirms delivery and does not print the
secret; if delivery fails the invite is still created and the CLI prints the link as a
fallback.
