# Codex plugin

Manifest: [`.codex-plugin/plugin.json`](../../.codex-plugin/plugin.json).
Listing mark: [`assets/logo.png`](../../assets/logo.png) (the same pixel chevron as the site favicon).

Ships the checked-in skills, the hosted MCP server in
[`.mcp.json`](../../.mcp.json) (`https://agents.uploads.sh/mcp`), and the shared
pre-PR hook in [`hooks/hooks.json`](../../hooks/hooks.json)
(`uploads hook pre-pr-screenshot`). Portal paste-ins (test cases, annotation
justifications) live in [submission.md](submission.md).
If the `uploads` CLI is not on `PATH`, the hook exits 0 and stays silent.
After enabling the plugin, open `/hooks` once and trust the hook if Codex asks.

Disable the reminder with `UPLOADS_HOOK_DISABLE=1`.

## OpenAI directory package

Build the public-directory ZIP from the same skills, icon, and hosted MCP:

```bash
pnpm plugin-directory:build
```

The output is `dist/plugins/uploads-openai-<plugin-version>.zip`. The builder
uses the version owned by `@uploads/plugin`; it does not change versions.
The build requires `zip` and `unzip` on `PATH`.
It writes the portable Agent Plugins `plugin.json` and `mcp.json` formats.
The ZIP contains only those manifests, the logo, and the canonical skills.
Local hooks, Claude mods, repository files, and environment files stay outside
the package. OpenAI currently rejects directory ZIPs with lifecycle hooks or
registered app references.

This first build is a draft. It does not claim that review cases have passed
or invent a recording URL. To import review cases and an existing recording,
follow [directory.md](directory.md). Free and paid uploads.sh accounts use
the same OAuth connection; the directory package does not sell subscriptions.

Run `pnpm plugin-directory:check` to test the package boundaries and validate
the archive. CI runs this check. A new ZIP is needed for changes to skills or
listing metadata; OpenAI scans hosted MCP tool changes separately.
