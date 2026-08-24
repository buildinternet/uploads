---
"@buildinternet/uploads": patch
---

Default the CLI auth base to the same-origin app origin (`uploads.sh`) instead of the retired `auth.uploads.sh` subdomain. Since #731 the auth endpoints are served at `<origin>/api/auth`, so an `api.<domain>` base now derives its parent (`api.uploads.sh` → `uploads.sh`). Explicit `--auth-url` / `UPLOADS_AUTH_URL` still override, and `auth.uploads.sh` continues to serve during the transition, so pinned configs keep working.
