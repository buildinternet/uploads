# OpenAI UI compatibility spike

An isolated MCP Apps experiment with synthetic staged screenshots. It does not
connect to uploads.sh, read credentials, inspect Git, or change real files. The
only tool returns demo data. Production workers and the shared MCP package are
unchanged.

## Run

This directory is an independent private npm package, outside the pnpm workspace.
Use Node 24 or later:

```sh
cd scripts/openai-ui-spike
npm ci
npm run build
npm test
npm start
```

- MCP endpoint: `http://127.0.0.1:4319/mcp`
- Local SDK harness: `http://127.0.0.1:4319/`
- Standalone resource: `http://127.0.0.1:4319/gallery` (reports no host)

The server binds to loopback. Stop it with Ctrl-C. A sandbox may require approval
to bind a local port. The smoke test starts an ephemeral server and closes it.

Use `SPIKE_TRACE=1 npm start` for transport diagnostics. Logs include the method,
path without its query string, HTTP status, duration, and resource-read marker.
They exclude request bodies and headers.

The lockfile pins the tested SDK versions. The initial build uses MCP
server/client/core 2.4.0, Node adapter 2.1.2, and MCP Apps 2.0.3. Unlike the
repository's existing MCP server dependency, this server supports resource
registration directly.

## What this proves

`npm test` checks actual HTTP tool discovery, the UI resource, both entrypoint
metadata values, populated/empty/error results, invalid inputs, legacy protocol
initialization, the static route allowlist, and Host/Origin checks.

The local harness uses the official SDK `Client` and `AppBridge`. It fetches the
real tool and resource over HTTP, then renders the bundled HTML in a sandboxed
iframe. Refresh and fixture selection call the MCP tool through that bridge.
Use its layout and theme selectors to check a narrow panel and dark appearance.
The gallery diagnostics report the actual connected host name and display mode.

**A successful local harness does not prove OpenAI entrypoint support.** Actual
host results belong in [RESULTS.md](RESULTS.md).

## Test in OpenAI

OpenAI custom MCP registration requires a reachable endpoint or Secure MCP
Tunnel. For a temporary public fixture-only tunnel, preserve the loopback Host
guard by setting the upstream Host header:

```sh
cloudflared tunnel --url http://127.0.0.1:4319 --http-host-header 127.0.0.1:4319
```

Use the returned HTTPS origin plus `/mcp` in the custom MCP form, with no
authentication. This exposes only synthetic fixture responses and the two
allowlisted built pages. Do not add credentials or real data to this server.
Stop the tunnel after the test; this URL is not a submission endpoint.

After installing the personal test plugin, verify these separately:

1. The global sidebar entry appears and opens the gallery.
2. The conversation panel entry appears and opens beside a conversation.
3. The bridge diagnostics name the real host; demo images render.
4. Refresh increments the result counter. Empty and Error recover to Populated.
5. Narrow and dark layouts remain usable.
6. A tool call in a non-UI client returns the readable demo summary.

Record the host/build, installation method, observed behavior, and screenshots.
Mark untested surfaces as untested. Do not infer desktop support from web or the
local harness.

## Integration boundary

The tool uses `_meta.ui.resourceUri` and
`_meta["openai/ui"].entrypoints` with `global` and `thread`. The HTML resource uses
`text/html;profile=mcp-app`. It bundles its scripts, styles, and synthetic images;
the resource CSP declares no external connection or asset domains. No UI action
sends a message, opens a URL, or writes to a service.

A later real-data integration needs authenticated workspace-scoped reads,
explicit repository/branch selection, `gh.status=staged`, pagination, and a
deliberate production SDK update. None of those are implied by this fixture test.

References: [MCP Apps UI](https://developers.openai.com/plugins/build/chatgpt-ui),
[OpenAI extensions](https://developers.openai.com/plugins/build/extensions), and
[connect and test](https://developers.openai.com/plugins/deploy/connect-chatgpt).
