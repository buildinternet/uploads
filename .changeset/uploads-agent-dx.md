---
"@buildinternet/uploads": minor
---

CLI onboarding and agent-friendly put:

- **`uploads install`** — short progress, no child stdout unless `--verbose`/failure;
  non-interactive skills (`-g -y -a '*'`); success next-steps; MCP without a token is
  skipped with a login nudge (skill still installs).
- **Missing token** — onboarding copy (no `error:` prefix); exit non-zero; `--json`
  keeps `MISSING_TOKEN`. Rejected tokens stay `UNAUTHORIZED` with a re-login hint.
- **`put --name <leaf>`** — clean key leaf on the stable `--pr`/default path.
- **`put --dry-run`** — resolve key + public URL without writing (API `?dryRun=1`).
- **Scripted failures** — `--format json|url|markdown` also print on stdout.
- **`FILE_NOT_FOUND`** — distinct code (exit 2) for a missing local file.
