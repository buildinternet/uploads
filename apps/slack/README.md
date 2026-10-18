# @uploads/slack

The uploads.sh Slack app. It does two things:

1. When someone posts an uploads.sh share link (`/f/…`, `/g/…`, `/c/…`) in
   Slack, it adds a preview (below).
2. When an upload is held for review, it DMs the people who can approve it,
   with **Approve** and **Keep held** buttons
   ([Held-upload messages](#held-upload-messages)).

A preview shows:

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
items marked missing or withheld are skipped. The worker has no storage or
KV bindings. Its D1 access is limited to the Slack tables:
`slack_installations` (sealed bot tokens), `slack_link_tickets`, and
`slack_user_links`. It never reads upload data directly, so a preview can
never show more than the public share page.

If Slack rejects the call because it can't fetch an image, the worker retries
once with text-only previews.

## Work Objects

With `SLACK_WORK_OBJECTS` set to `on`, each `chat.unfurl` also carries
[Work Object](https://docs.slack.dev/messaging/work-objects-overview)
metadata (`src/entities.ts`). Slack then draws a structured card instead of
the Block Kit preview, and clicking it opens a flexpane beside the
conversation. The blocks are still sent, and if Slack rejects the metadata
the worker retries with the blocks alone.

| Link                     | Entity type    | Card shows                                        |
| ------------------------ | -------------- | ------------------------------------------------- |
| File (`/f/…`)            | `file`         | Image or poster, creator, date, PR or issue, path |
| Change feed (`/c/…`)     | `content_item` | Latest screenshot, PR or issue, state, file count |
| Gallery (`/g/…`)         | `content_item` | Cover, description, item count                    |
| One feed or gallery item | `file`         | The item, a link to its feed or gallery           |

The flexpane for a feed or gallery is a pager: it opens on the feed's newest
item (or the gallery's first) and has **Newer** / **Older** (feeds) or
**Previous** / **Next** (galleries) buttons. Opening the flexpane sends
`entity_details_requested` to `POST /slack/events`; a button press sends
`block_actions` to `POST /slack/interactivity`. Both answer with
`entity.presentDetails`, built from the same public endpoints as the
preview, so the card and flexpane never show more than the share page.
Anything that isn't public answers `not_found`.

Feed and gallery cards also show a strip of up to four thumbnails (a feed's
newest images, a gallery's first), as an array of `slack#/types/image`. The
pager flexpane leaves the strip out, since its current item leads.

Clicking a thumbnail can open Slack's full-size viewer
(`attributes.full_size_preview`), but only for PNG, JPEG, GIF, and WebP
images on a host listed in `SLACK_FULL_SIZE_HOSTS`. Slack loads the image
from `app.slack.com`, so each listed host must answer CORS for that origin.
For the hosted R2 domains that's a bucket CORS rule on `uploads-default`:

```json
{
  "rules": [
    {
      "allowed": { "origins": ["https://app.slack.com"], "methods": ["GET", "HEAD"] },
      "maxAgeSeconds": 3600
    }
  ]
}
```

```bash
wrangler r2 bucket cors set uploads-default --file slack-cors.json
```

Then add `storage.uploads.sh` (and `store.uploads.sh`) to
`SLACK_FULL_SIZE_HOSTS`. Images on other hosts (BYO buckets) keep the
thumbnail only.

Each entity's `external_ref` is fixed per link (the file key, feed id,
gallery id, or collection id plus item id), which Slack uses to list the
conversations that mention it. Slack only accepts ids matching
`^[0-9a-zA-Z\-_:!\/=]+$` and rejects the whole Work Object otherwise
(`error_processing_metadata`, "input must match regex pattern"), so
`slackRef` escapes any other character as `!` plus its UTF-8 bytes in hex
(`after.png` becomes `after!2epng`).

A file's size and content type only appear at the end of its side panel;
the card leaves them out so the PR and page path lead.

The card's creator is the repo owner's GitHub account. Galleries and files
with no repo show uploads.sh instead, since the public API has no uploader.

Turning it on:

1. Sync the manifest (`features.rich_previews` and the
   `entity_details_requested` event). No new scopes, so existing installs
   don't need to reinstall.
2. Set `SLACK_WORK_OBJECTS` to `on` in `wrangler.jsonc` and deploy.

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
The D1 install row is the only token source; a team without one gets no
previews or messages. Org-wide (Enterprise Grid) installs are refused for
now.

### Adding a scope

Slack never upgrades an existing install. A new scope only changes what new
installs request; every workspace keeps its old token until someone there
runs the OAuth flow again, and Slack then adds the new grant to the old one
(Slack's [App lifecycle & distribution](https://docs.slack.dev/app-management/distribution/)
guide). So:

1. Add the scope to the feature that needs it in `src/scopes.ts`
   (`FEATURE_SCOPES`), to `manifest.json`, and to
   `apps/api/src/slack-scopes.ts`. `test/scopes.test.ts` fails until all
   three agree, and `/slack/install` requests `BOT_SCOPES` from that file.
2. Ship it and run `slack manifest sync`.
3. Nothing else: each install's granted scopes are stored in
   `slack_installations.scopes`. Where any are missing, the Home tab shows
   an **Update permissions** banner that opens `/slack/install`, and the
   workspace's row under **Slack** on `/account/profile` does the same
   (`missingScopes` on `GET /me/slack/links`). A feature whose scopes are
   missing is skipped and logged instead of failing with `missing_scope`.

Slack shows the Allow page to anyone who can add apps; workspaces that
require admin approval route it to an admin.

For another workspace to install, the app needs public distribution
turned on under **Manage Distribution** in the app settings.

## Connecting Slack users to uploads.sh accounts

Each Slack user can link their uploads.sh account from the app's Home tab.
Held-upload messages use the link to know who to message and who pressed
**Approve**.

1. `app_home_opened` renders the Home tab (`src/home.ts`). An unlinked user
   gets a **Connect uploads.sh** button whose URL carries a fresh ticket:
   24 random bytes, single use, valid for 30 minutes. Only its SHA-256 is
   stored, in `slack_link_tickets` (`src/links.ts`).
2. The button opens `uploads.sh/slack/connect?ticket=…`. The page names the
   Slack user the ticket was minted for (looked up with `users.info` at mint
   time), so someone who follows a forwarded link can see it isn't theirs.
   The signed-in user confirms, and uploads-api's `POST /me/slack/connect/:ticket` consumes the
   ticket and writes `slack_user_links` (team, Slack user → uploads.sh user).
3. A linked user's Home tab says when it was connected and shows a
   **Disconnect** button. It never names the uploads.sh account, so a
   forwarded-link mistake can't leak whose account it is,
   handled by `POST /slack/interactivity`. Users can also unlink from
   uploads.sh with `DELETE /me/slack/links/:teamId/:slackUserId`.

Link previews don't depend on any of this; they work for everyone.

A link never adds anyone to an uploads.sh workspace, so it never uses a
seat. Free-plan member caps apply only when someone joins a workspace.

Signed-in users see and remove their links under **Slack** on
`/account/profile`, which reads `GET /me/slack/links` (with each Slack
workspace's name from `slack_installations`).

## Held-upload messages

When the classifier holds an upload (`apps/api/src/upload-hold-service.ts`),
uploads-api picks who to tell (`apps/api/src/slack-hold-notify.ts`):

- the uploader (`gh.uploader-id`), when the upload has one and they are
  still a member of the workspace;
- otherwise the workspace's admins and owners.

Each must have a Slack link and the `notify_slack_holds` preference on
(**Slack** on `/account/profile`; default on). For every link, uploads-api
calls `POST /slack/internal/hold` over its `SLACK` service binding, and this
worker opens a DM (`conversations.open`) and posts the message
(`chat.postMessage`), built in `src/holds.ts`. The message names the file,
the workspace, and the reason, and links to the signed-in `/f/` page.

The buttons come back to `POST /slack/interactivity`:

- **Approve** calls uploads-api's `POST /internal/slack/approve` over the
  `API` binding (host `api.internal`). The API maps the presser's Slack user
  to their uploads.sh account through `slack_user_links`, requires that
  account to be a member of the workspace, and runs the same
  `approveUpload` as `uploads approve`. A refusal or failure answers only
  the presser and leaves the buttons in place.
- **Keep held** changes nothing.

On success either button rewrites the DM through the payload's
`response_url` (Slack's `hooks.slack.com` only), so it can't be pressed
twice. Messages arrive in the app's Messages tab, which is read-only.

## Configuration

| Name                    | Kind   | Purpose                                                                    |
| ----------------------- | ------ | -------------------------------------------------------------------------- |
| `SLACK_SIGNING_SECRET`  | secret | Verifies every inbound request. Unset: `/slack/events` answers 503.        |
| `SLACK_CLIENT_SECRET`   | secret | OAuth client secret. Unset: `/slack/install` answers 503.                  |
| `SLACK_TOKENS_KEY`      | secret | 16+ character master key that seals bot tokens and signs OAuth state.      |
| `SLACK_CLIENT_ID`       | var    | The app's public OAuth client id.                                          |
| `SLACK_APP_ID`          | var    | The app's id, for the "Open Slack" link after install.                     |
| `SLACK_ORIGIN`          | var    | This worker's origin; the OAuth redirect URI is built from it.             |
| `WEB_ORIGIN`            | var    | The only origin whose share links unfurl.                                  |
| `SLACK_WORK_OBJECTS`    | var    | `on` adds Work Object metadata to unfurls ([Work Objects](#work-objects)). |
| `SLACK_FULL_SIZE_HOSTS` | var    | Image hosts Slack may open full size; each needs CORS for `app.slack.com`. |
| `API_ORIGIN`            | var    | The public API's origin; the plain-`fetch` target when `API` isn't bound.  |

```bash
wrangler secret put SLACK_SIGNING_SECRET --config apps/slack/wrangler.jsonc
wrangler secret put SLACK_CLIENT_SECRET --config apps/slack/wrangler.jsonc
wrangler secret put SLACK_TOKENS_KEY --config apps/slack/wrangler.jsonc
```

Rotating `SLACK_TOKENS_KEY` makes stored tokens unreadable; teams then need
to reinstall. There is no key ring yet.

## Setting up the Slack app

`manifest.json` is the app definition: the bot scopes below, unfurl domain
`uploads.sh`, Work Object previews for `file` and `content_item` entities,
the OAuth redirect URL, the `link_shared`, `entity_details_requested`,
`app_home_opened`, `app_uninstalled`, and `tokens_revoked` events pointed at
`https://agents.uploads.sh/slack/events`, the Home tab, a read-only Messages
tab (where held-upload DMs land), and interactivity at
`https://agents.uploads.sh/slack/interactivity`.

| Scope         | Why                                                                   |
| ------------- | --------------------------------------------------------------------- |
| `links:read`  | See uploads.sh links in messages (the URL only) to preview them.      |
| `links:write` | Add the preview.                                                      |
| `users:read`  | Show the connecting user's Slack name on the uploads.sh confirm page. |
| `chat:write`  | Send held-upload DMs and update them after a button press.            |
| `im:write`    | Open the DM between the app and a connected user.                     |

The list lives in `src/scopes.ts`, grouped by feature (see
[Adding a scope](#adding-a-scope)).

The manifest has no field for scope reasons. Slack's app settings ask for
one per scope; paste the "Why" column there. The app is installed in the Build
Internet workspace (app `A0CA0AWAJCD`, recorded in `.slack/apps.json`).

`apps/slack` is a Slack CLI project: `.slack/hooks.json` points the CLI's
`get-manifest` hook at `manifest.json`, so manifest changes go through the CLI
from this directory:

```bash
slack manifest validate
slack manifest diff      # project manifest vs. live app settings
slack manifest sync      # push manifest.json to the app
```

The CLI doesn't print the signing secret or client secret. Copy them from
the app's settings page (`slack app settings`, **Basic Information**). Then
set them as worker secrets (above) and deploy:

```bash
pnpm run deploy:slack
```

Slack sends a `url_verification` challenge to the event URL, so the signing
secret must be set before Slack can verify it. If the URL shows as unverified,
press **Retry** under **Event Subscriptions** once the secret is in place.

`pnpm run deploy` deploys this worker after the api, web, and mcp workers.
Workers Builds deploys each worker from its own directory on push to
`main`; the `uploads-slack` worker needs a build connected in the Cloudflare
dashboard (root directory `apps/slack`, deploy command
`pnpm run deploy`) like the others.

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
- **Notifications**: follow held-upload messages. uploads-api calls a
  `POST /slack/internal/*` route on this worker over its `SLACK` binding
  (host `slack.internal`), and the worker posts with `chatPostMessage` in
  `src/slack/api.ts`. Internal routes check the host, so the public route
  can't reach them.
- **Acting as a linked user**: follow **Approve**. Call an uploads-api
  `/internal/slack/*` route over the `API` binding (host `api.internal`)
  with the Slack team and user from the signed payload; the API resolves
  `slack_user_links` and checks membership itself.
