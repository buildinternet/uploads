# Managed-comment attachments link to the `/f/` file page

**Date:** 2026-07-20
**Status:** Approved (design)

## Goal

In the `uploads-sh[bot]` managed attachments comment, clicking an attachment —
image _or_ video/other file — should open its **`/f/<workspace>/<key>` file
page** (curated metadata, dual dates, GitHub context, video player) instead of
dropping the viewer onto the raw, Camo-proxied bytes.

This mirrors what gallery previews in the same comment already do: each preview
links to its item page via `itemUrl`/`pageUrl`. Plain attachments are the only
things in the comment that still link to raw bytes; this change closes that gap.

Only the **click-through `href` changes**. The `<img src>` stays on the raw /
embed host — GitHub's Camo proxy revalidates against it and it must remain the
raw bytes.

## Background / current state

The renderer `attachmentsCommentBody` exists in two byte-identical copies, kept
in sync by a golden fixture asserted from both sides:

- `apps/api/src/github-comment-render.ts` — server copy (the bot path; the
  published CLI imports no `@uploads/*` package, so it cannot be shared).
- `packages/uploads/src/github.ts` — CLI copy (the local `gh` fallback path).

Today, for each attachment item (`{ key, url, embedUrl }`):

- **Image** (`inferContentType` starts with `image/`): rendered as
  `<a href="{url}"><img src="{embedUrl ?? url}" …></a>` — the click-through
  `href` is the raw `url`.
- **Non-image** (videos, other files): rendered as a bullet `- [name]({url})` —
  also the raw `url`.

The destination already exists: the public file page
`uploads.sh/f/<workspace>/<key>` (issues #135/#139) — curated metadata view,
dual dates, visibility gate, `github` block derived from `gh.*` tags, and a
video player for `video/*`.

### Video note (why non-images matter here)

An externally-hosted MP4 can never render as an inline player in a GitHub
comment: GitHub's HTML sanitizer strips `<video>`/`<source>`, and its
auto-embedded player only fires for videos on `github.com/user-attachments`
(which a bot can't upload to). So a video attachment can only ever be a link in
the comment — which makes pointing that link at the `/f/` page (a real player)
strictly better than raw bytes. Making a video _look_ embedded (poster
thumbnail) needs thumbnail generation and is tracked separately in **#299**.

## Approach: server-computed `pageUrl` on the object DTO

The codebase has a firm convention (see doc-comments on `GalleryItem.pageUrl`
and `GalleryCommentItem.url`): **canonical/public URLs are computed by the API
and returned; clients must not synthesize them.** Gallery item pages already
follow this. Plain object listings (`ListItem`) don't carry a page URL yet.

So: the API computes the file-page URL and returns it on the object DTO; both
the bot path and the CLI `gh` path pass it through to the renderer unchanged.

### 1. API — file-page URL helper + object DTO field

- Add `filePageUrl(env, workspace, key)` returning
  `${WEB_ORIGIN}/f/<workspace>/<key>` with each path segment encoded, sibling to
  `galleryUrl`/`galleryItemUrl` in `apps/api/src/gallery-service.ts` (or a
  shared url helper module). Uses the same `env.WEB_ORIGIN` base + trailing-slash
  trim as `galleryUrl`.
- The object listing DTO (`ListItem`, and the internal `listObjects` items used
  by the bot path) gains optional `pageUrl?: string`.
- `pageUrl` is populated **only when the object has a public `url`** (the same
  condition that makes it embeddable). Objects with `url: null` (BYO/private
  workspaces with no public host) get no `pageUrl`.

### 2. Renderer — prefer `pageUrl` for the click-through (both copies)

- `AttachmentItem` gains `pageUrl?: string | null` in **both**
  `apps/api/src/github-comment-render.ts` and `packages/uploads/src/github.ts`.
- Image href precedence: `pageUrl ?? stable ?? src`.
- Non-image bullet: `- [name]({pageUrl ?? stable})`.
- `<img src>` is unchanged (`embedUrl ?? url`).
- Update the golden fixture `test/fixtures/github-comment-golden.json` and keep
  the both-sided identity assertion green. **Change both copies together.**

### 3. Callers pass the field through

- Bot path (`apps/api/src/github-comment.ts`, `gatherAttachments`): include
  `pageUrl` when mapping `listObjects` items into `AttachmentItem`.
- CLI `gh` path (`packages/uploads/src/commands.ts`): map `pageUrl` from
  `client.listAll` items; add `pageUrl?` to the client's `ListItem` DTO.

## Graceful degradation

An older API deployment returns no `pageUrl` → the renderer falls back to the
raw `url`, byte-for-byte today's behavior. This is the same pattern already
documented on `GalleryItem.pageUrl` ("Absent on older API deployments"). No
version negotiation needed.

## Out of scope (deferred)

- **Configurability** — any workspace setting or in-repo config file to toggle
  file-page linking on/off. Explicitly a later step; this pass only flips the
  default.
- **Video poster thumbnails** (#299) — making a video entry _look_ embedded
  inline. Needs thumbnail generation; separate issue.
- **Per-object private-visibility handling** — an object whose bytes are public
  but whose metadata `visibility` is `private` (#139) will link to a `/f/` page
  that returns 401 `auth_required`. This is an existing quirk of the
  public-bytes / private-metadata split: the image is _already_ publicly
  embedded in the comment regardless, so this change does not worsen exposure.
  Emitting `pageUrl` whenever a public `url` exists (rather than re-deriving
  per-object visibility) keeps the change small. Noted, not solved.

## Testing

- **Golden fixture** (`test/fixtures/github-comment-golden.json`) updated;
  existing both-sided identity assertion continues to guard CLI/API parity.
- **Renderer unit tests** (`packages/uploads/test/github.test.ts`, and the API
  render test): image and non-image items with `pageUrl` set → href is the page
  URL; with `pageUrl` absent → href falls back to raw `url` (degradation path).
- **API test**: object listing emits `pageUrl` for objects with a public `url`,
  and omits it when `url` is `null`.

## Files touched (anticipated)

- `apps/api/src/gallery-service.ts` (or shared url helper) — `filePageUrl`.
- `apps/api/src/github-comment-render.ts` — `AttachmentItem.pageUrl`, href
  precedence.
- `apps/api/src/github-comment.ts` — pass `pageUrl` from `listObjects`.
- object listing route / DTO — add `pageUrl` when a public `url` exists.
- `packages/uploads/src/github.ts` — `AttachmentItem.pageUrl`, href precedence.
- `packages/uploads/src/client.ts` — `ListItem.pageUrl`.
- `packages/uploads/src/commands.ts` — pass `pageUrl` through the `gh` path.
- `test/fixtures/github-comment-golden.json` + the unit/api tests above.
