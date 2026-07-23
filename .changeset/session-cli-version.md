---
"@buildinternet/uploads": patch
---

Device login now saves a session token and keeps `session.cliVersion` fresh so
the account Sessions list can show your current CLI version after upgrades
without re-login.
