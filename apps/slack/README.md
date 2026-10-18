# @uploads/slack

The uploads.sh Slack app. Today it does one thing: when someone posts an
uploads.sh share link (`/f/…`, `/g/…`, `/c/…`) in Slack, it replaces the link
with a preview. Images show inline, videos show their poster frame, and
galleries and change feeds show a titled link with a cover thumbnail.

Deployed as the `uploads-slack` worker on a route, `agents.uploads.sh/slack/*`,
in front of the uploads-mcp Custom Domain on the same hostname. Only
`/slack/*` reaches this worker; every other path on agents.uploads.sh still
goes to uploads-mcp.

## How a preview is built

1. Slack sends a signed `link_shared` event to `POST /slack/events`.
2. The worker checks the signature, answers 200 at once, and does the rest in
   `waitUntil` (Slack retries any event not answered within 3 seconds).
3. For each link on `WEB_ORIGIN`, it calls uploads-web's public
   `/oembed?url=…` over the `WEB` service binding.
4. It sends one `chat.unfurl` with Block Kit for every link that resolved.

The oEmbed endpoint is the only source of preview data. It returns 404 for
private, held, missing, and expired objects, and a 404 means no preview. This
worker has no storage, D1, or KV bindings, so a preview can never show more
than the public share page.

If Slack rejects the call because it can't fetch an image, the worker retries
once with text-only previews.

## Configuration

| Name                   | Kind   | Purpose                                                                    |
| ---------------------- | ------ | -------------------------------------------------------------------------- |
| `SLACK_SIGNING_SECRET` | secret | Verifies every inbound request. Unset: `/slack/events` answers 503.        |
| `SLACK_BOT_TOKEN`      | secret | `xoxb-` token for `chat.unfurl`. Unset: events are acked and ignored.      |
| `SLACK_TEAM_ID`        | var    | Optional. When set, events from any other Slack team are ignored.          |
| `WEB_ORIGIN`           | var    | The only origin whose links unfurl. Must be the origin that serves oEmbed. |

```bash
wrangler secret put SLACK_SIGNING_SECRET --config apps/slack/wrangler.jsonc
wrangler secret put SLACK_BOT_TOKEN --config apps/slack/wrangler.jsonc
```

## Setting up the Slack app

`manifest.json` is the app definition: bot scopes `links:read` and
`links:write`, unfurl domain `uploads.sh`, and the `link_shared` event pointed
at `https://agents.uploads.sh/slack/events`. The app is installed in the Build
Internet workspace (app `A0CA0AWAJCD`, recorded in `.slack/apps.json`).

`apps/slack` is a Slack CLI project: `.slack/hooks.json` points the CLI's
`get-manifest` hook at `manifest.json`, so manifest changes go through the CLI
from this directory:

```bash
slack manifest validate
slack manifest diff      # project manifest vs. live app settings
slack manifest sync      # push manifest.json to the app
```

The CLI doesn't print the bot token or signing secret. Copy them from the
app's settings page (`slack app settings`): **Basic Information** → Signing
Secret, and **OAuth & Permissions** → Bot User OAuth Token. Then set them as
worker secrets (above) and deploy:

```bash
pnpm run deploy:slack
```

Slack sends a `url_verification` challenge to the event URL, so the signing
secret must be set before Slack can verify it. If the URL shows as unverified,
press **Retry** under **Event Subscriptions** once the secret is in place.

The worker is not part of `pnpm run deploy` or Workers Builds yet. Add it once
the app is installed.

`icon.png` (1024×1024, rendered from `apps/web/public/favicon.svg` on a full
square) is the app icon. The manifest can't set an icon, so upload it under
**Basic Information** → **Display Information**.

## Local development

```bash
pnpm dev:slack    # wrangler dev on :8790
pnpm test:slack
```

Without the `WEB` binding the worker calls `WEB_ORIGIN` over plain `fetch`.
Put the secrets in `apps/slack/.dev.vars` to exercise it locally; to receive
real events, tunnel port 8790 and point a test app's event URL at the tunnel.

## Adding features

The worker is laid out so the next features slot in without reshaping it:

- **New Slack events**: add a handler to `EVENT_HANDLERS` in `src/events.ts`
  and the event to `manifest.json`.
- **Slash commands** (for example, an agent search command): a new
  `POST /slack/commands` route in `src/index.ts` that reuses `readSignedBody`.
- **Notifications** (for example, a flag or PII hold): uploads-api calls a
  `POST /slack/internal/*` route on this worker over a service binding, and
  the worker posts with a `chat.postMessage` wrapper in `src/slack/api.ts`.
  Internal routes must not be reachable from the public route.
- **More than one Slack workspace**: the OAuth install flow plus a per-team
  token store. Only `botTokenFor()` in `src/config.ts` changes.
