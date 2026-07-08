# @buildinternet/uploads

CLI and client for **uploads.sh** — upload files, get public URLs, and produce GitHub-ready markdown. Successor to the R2 scripts in `buildinternet-skills/github-screenshots`.

## CLI

Binary: `uploads` (also `pnpm uploads` from repo root after `pnpm install`).

```bash
pnpm uploads setup --env-file .env
pnpm uploads put ./shot.png --env-file .env
pnpm uploads put ./after.png --pr 123 --comment --env-file .env
pnpm uploads doctor --env-file .env
```

Commands: `put`, `comment`, `list`, `delete`, `setup`, `config`, `doctor`, `health`.

Config layers (first match wins): CLI flags → env vars → `--env-file` → `~/.config/buildinternet/config`. See `config.example` for keys.

## Programmatic use

```ts
import { createUploadsClient } from "@buildinternet/uploads";
```

Agent/MCP helpers: `@buildinternet/uploads/agent` (`createUploadsWorkerFileTools` for Workers).

## Layout

```
src/
  cli.ts            Entry + help
  commands.ts       put, list, delete, comment, …
  client.ts         HTTP client for the API
  github.ts         PR/issue key paths + attachment comments
  embed.ts          Markdown image output
bin/uploads.js      Bin shim
```

## Commands

```bash
pnpm build        # tsc → dist/
pnpm typecheck
pnpm test
```

Agent-oriented usage: [`skills/uploads-cli/SKILL.md`](../../skills/uploads-cli/SKILL.md). REST details: [`docs/api.md`](../../docs/api.md).
