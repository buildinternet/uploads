# @uploads/slack

The uploads.sh Slack app. Today it does one thing: when someone posts an
uploads.sh share link (`/f/…`, `/g/…`, `/c/…`) in Slack, it replaces the link
with a preview:

- **File** (`/f/…`): filename, the PR or issue it's attached to, the image
  (or a video's poster frame), then type, size, page path, and upload time.
- **Change feed** (`/c/…`): the PR number and title, the repo and PR state,
  the latest screenshot as a thumbnail, then the file count and last upload.
- **Gallery** (`/g/…`): title, description, cover thumbnail, item count.
- **One item in a feed or gallery**: the item's image, a link to its
  collection; gallery items also show their position ("3 of 12").

The layout is the one GitHub, Linear, and Loom unfurls use: bold title, one
line of what it belongs to, media, and a muted line of facts. Times use
Slack's date token, so each reader sees them in their own timezone.

Deployed as the `uploads-slack` worker on a route, `agents.uploads.sh/slack/*`,
in front of the uploads-mcp Custom Domain on the same hostname. Only
`/slack/*` reaches this worker; every other path on agents.uploads.sh still
goes to uploads-mcp.

## How a preview is built

1. Slack sends a signed `link_shared` event to `POST /slack/events`.
2. The worker checks the signature, answers 200 at once, and does the rest in
   `waitUntil` (Slack retries any event not answered within 3 seconds).
3. For each share link on `WEB_ORIGIN`, it reads uploads-api's public
   endpoints (`/public/files|feeds|galleries/…`) over the `API` service
   binding (`src/share.ts`).
4. It sends one `chat.unfurl` with Block Kit for every link that resolved
   (`src/unfurl.ts`).

The public endpoints are the only source of preview data, the same ones the
share pages render from. They never sign URLs and return 404 for private,
held, missing, and expired objects; a 404 means no preview, and collection
items marked missing or withheld are skipped. This worker has no storage, D1,
or KV bindings, so a preview can never show more than the public share page.

If Slack rejects the call because it can't fetch an image, the worker retries
once with text-only previews.

## Installing in a workspace

Anyone can add the app to their Slack workspace from
`https://agents.uploads.sh/slack/install` (the "Add to Slack" link):

1. `GET /slack/install` sets a short-lived, host-only state cookie and
   redirects to Slack's OAuth consent screen with the bot scopes.
2. Slack redirects to `GET /slack/oauth/callback` with a `code` and the
   `state`. The worker checks the signed state and that it matches the
   cookie, then exchanges the code with `oauth.v2.access`.
3. The bot token is sealed with `SLACK_TOKENS_KEY` (AES-GCM, `enc:v1:`) and
   stored per team in the shared D1 table `slack_installations`
   (`src/installs.ts`). Reinstalling a team replaces its row.
4. `app_uninstalled` and `tokens_revoked` events clear the stored token.

Each event looks up its team's token (`botTokenFor` in `src/config.ts`).
The original Build Internet install still uses the `SLACK_BOT_TOKEN`
secret, for `SLACK_TEAM_ID` only, until it reinstalls through the flow
above. Org-wide (Enterprise Grid) installs are refused for now.

For another workspace to install, the app needs public distribution
turned on under **Manage Distribution** in the app settings.

## Configuration

| Name                   | Kind   | Purpose                                                                   |
| ---------------------- | ------ | ------------------------------------------------------------------------- |
| `SLACK_SIGNING_SECRET` | secret | Verifies every inbound request. Unset: `/slack/events` answers 503.       |
| `SLACK_CLIENT_SECRET`  | secret | OAuth client secret. Unset: `/slack/install` answers 503.                 |
| `SLACK_TOKENS_KEY`     | secret | 16+ character master key that seals bot tokens and signs OAuth state.     |
| `SLACK_BOT_TOKEN`      | secret | Legacy `xoxb-` token, used only for `SLACK_TEAM_ID`.                      |
| `SLACK_CLIENT_ID`      | var    | The app's public OAuth client id.                                         |
| `SLACK_APP_ID`         | var    | The app's id, for the "Open Slack" link after install.                    |
| `SLACK_TEAM_ID`        | var    | The team the legacy token belongs to.                                     |
| `SLACK_ORIGIN`         | var    | This worker's origin; the OAuth redirect URI is built from it.            |
| `WEB_ORIGIN`           | var    | The only origin whose share links unfurl.                                 |
| `API_ORIGIN`           | var    | The public API's origin; the plain-`fetch` target when `API` isn't bound. |

```bash
wrangler secret put SLACK_SIGNING_SECRET --config apps/slack/wrangler.jsonc
wrangler secret put SLACK_CLIENT_SECRET --config apps/slack/wrangler.jsonc
wrangler secret put SLACK_TOKENS_KEY --config apps/slack/wrangler.jsonc
```

Rotating `SLACK_TOKENS_KEY` makes stored tokens unreadable; teams then need
to reinstall. There is no key ring yet.

## Setting up the Slack app

`manifest.json` is the app definition: bot scopes `links:read` and
`links:write`, unfurl domain `uploads.sh`, the OAuth redirect URL, and the
`link_shared`, `app_uninstalled`, and `tokens_revoked` events pointed at
`https://agents.uploads.sh/slack/events`. The app is installed in the Build
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

Without the `API` binding the worker calls `API_ORIGIN` over plain `fetch`.
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
- **Linking Slack users to uploads.sh accounts**: a per-team, per-user link
  table next to `slack_installations`, started from the app's Home tab.
