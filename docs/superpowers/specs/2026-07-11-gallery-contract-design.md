# First-class media galleries — product and API contract

**Date:** 2026-07-11
**Status:** Approved design, pre-implementation

## Goal

Make a gallery a first-class uploads.sh resource: a stable, ordered collection
of public media that a human or agent can create once and optionally associate
with one or more external work items.

A gallery belongs to an uploads.sh workspace but has an opaque public identity.
GitHub PRs/issues and future Linear/Jira records are many-to-many external
references and lookup indexes, never gallery coordinates.

The launch outcome is:

1. Create a gallery and receive a stable public URL.
2. Add existing workspace objects in a deliberate order.
3. Link the gallery to zero or more external work items.
4. Find all galleries linked to an external coordinate while authenticated.
5. Share the gallery without installing a GitHub App.

## Decisions

| Question            | v1 decision                                                                                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical identity  | `gal_` plus 16 cryptographically random bytes encoded base64url (128 bits; 26 characters total). Immutable and never recycled.                                   |
| Canonical URL       | `https://uploads.sh/g/<gallery-id>`. It contains no workspace or external-system coordinates.                                                                    |
| Ownership           | Exactly one workspace. Authenticated operations derive the workspace from the route and bearer token; public resolution derives it from the gallery row.         |
| Visibility          | Public only. Anyone with the URL can enumerate gallery metadata and media. Random IDs reduce guessing but are not access control.                                |
| Gallery metadata    | Required title, optional plain-text description, timestamps, optional cover item, and an update version for optimistic concurrency.                              |
| Membership          | First-class ordered rows referencing workspace-relative object keys. One object can appear in many galleries but at most once in a given gallery.                |
| Ordering            | Explicit integer positions. Append uses spaced values; a bounded transactional reorder rewrites the full sequence. Item ID is the stable tie-breaker.            |
| Object ownership    | Objects stay owned and metered by their workspace. A gallery never copies, transfers, pins, or implicitly deletes bytes.                                         |
| Missing media       | Preserve the membership as a tombstone and render “removed or expired.” Do not silently change gallery order.                                                    |
| External references | Provider-neutral, normalized, many-to-many rows. Human coordinates are aliases, not gallery identity.                                                            |
| Auth scopes         | Owner reads/listing use `files:read`; all gallery metadata/item/reference mutations use `files:write`. Only explicit stored-object deletion uses `files:delete`. |
| Public reads        | Exact opaque-ID lookup only. No unauthenticated workspace listing or external-coordinate search.                                                                 |

## Identity and tenancy

Public IDs use the same Web Crypto and base64url approach already used for
random upload paths and auth secrets, with a `gal_` type prefix. Timestamped
IDs are avoided so the public identifier leaks neither workspace nor creation
order. Internal item/reference row IDs may use `crypto.randomUUID()`.

Every gallery row carries its owning workspace. Membership and reference
queries must join through that gallery and include the authenticated workspace
predicate. Public resolution looks up the opaque gallery ID, rejects deleted or
non-public rows, then loads the recorded workspace. It must never accept a
caller-provided workspace for public lookup or fall back to another tenant.

The canonical URL deliberately omits workspace name. Workspace deletion or
suspension makes its galleries unavailable; it never transfers ownership.

## Data model

The implementation issue will finalize SQL names, but the contract requires
these logical tables:

```sql
galleries (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  visibility TEXT NOT NULL DEFAULT 'public',
  cover_item_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
)

gallery_items (
  id TEXT PRIMARY KEY,
  gallery_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  position INTEGER NOT NULL,
  caption TEXT,
  alt_text TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (gallery_id, object_key),
  FOREIGN KEY (gallery_id) REFERENCES galleries(id) ON DELETE CASCADE
)

gallery_external_references (
  id TEXT PRIMARY KEY,
  gallery_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  normalized_key TEXT NOT NULL,
  locator_json TEXT NOT NULL,
  canonical_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (gallery_id, normalized_key),
  FOREIGN KEY (gallery_id) REFERENCES galleries(id) ON DELETE CASCADE
)
```

Required indexes cover `(workspace, created_at)`, ordered items by
`(gallery_id, position, id)`, and reverse lookup by `normalized_key`. The
normalized key is not globally unique: several galleries may reference the
same external item.

Object storage remains authoritative for bytes and object metadata. There is
no foreign key from D1 to provider storage. Gallery code passes the owning
workspace and client-visible key through `createStorage()`; it never constructs
shared-bucket physical prefixes or imports a storage adapter directly.

## Gallery fields and validation

- `title`: required after trimming; 1–120 Unicode characters.
- `description`: optional plain text; at most 2,000 UTF-8 bytes. No Markdown or
  raw HTML in v1.
- `caption`: optional plain text; at most 500 UTF-8 bytes.
- `altText`: optional plain text; at most 300 UTF-8 bytes.
- `coverItemId`: optional and must identify a current item in the gallery.
- `visibility`: returned as `public`; clients cannot request another value.

If a caller omits a title during a convenience create-and-add flow, the client
may generate one before calling the API. The API itself requires a non-empty
title so the stored contract stays unambiguous.

A gallery holds at most 100 items and 20 external references in v1. Workspace
gallery-count quotas are deferred until there is a multi-user billing model,
but create/mutation routes use the existing workspace write-rate limiter and
the implementation must leave room for a per-workspace cap.

## Items and ordering

Adding an item verifies through the owning workspace storage instance that the
object exists and has a non-null public URL. Public-only galleries cannot
contain private/unservable objects. The membership stores the exact
workspace-relative key, not the provider path or public URL; URLs are computed
at read time so shared-bucket prefixes and BYO base URLs remain transparent.

One object key may occur only once within a gallery. Re-adding it is
idempotent unless metadata or position is explicitly changed. The same key can
belong to any number of galleries in its workspace without copying or
double-counting bytes.

Append positions start at 1,000 and increase by 1,000. `PUT .../items/order`
accepts the complete ordered list of item IDs and rewrites positions in one D1
batch/transaction. Mutating responses increment `version`; callers may send the
last observed version and receive a conflict rather than overwrite a concurrent
edit. Partial reorder lists and unknown/duplicate item IDs are rejected.

## External references

Issue #62 introduced external references through authenticated owner and
reverse-lookup APIs. Issue #60 then resolved the public exposure model: the
unauthenticated gallery response includes a provider-neutral `references`
array (`provider`, `resourceType`, `coordinate`, `canonicalUrl`) so the public
gallery and item pages can list connected work items. Reference ids, timestamps,
and normalized keys stay private. Reverse lookup (coordinate → galleries) is
the part that remains authenticated-only; discoverability still requires the
opaque gallery URL. A future workspace-level control may let verified owners opt specific
repositories into public coordinate-path browsing (e.g. `/pr/owner/repo/123`);
nothing in this contract should preclude that.

The public input/output shape is provider-neutral:

```json
{
  "provider": "github",
  "resourceType": "item",
  "locator": {
    "owner": "buildinternet",
    "repository": "uploads",
    "number": 123
  },
  "canonicalUrl": "https://github.com/buildinternet/uploads/issues/123"
}
```

GitHub normalization lowercases owner/repository for matching and produces a
key such as `github:item:buildinternet/uploads#123`. `item` deliberately avoids
requiring the caller to distinguish a PR from an issue; GitHub uses one number
sequence for both. A later authenticated integration may record immutable
repository/node IDs as additional aliases without changing the gallery or
existing human-coordinate alias.

Repository rename/transfer behavior in v1:

- Gallery URLs and membership keys never change.
- Existing coordinate aliases continue to resolve by their stored old value.
- A caller may add the new normalized coordinate and remove the old alias.
- No webhook or background GitHub lookup automatically discovers renames.
- Existing `gh/<owner>/<repo>/...` object keys are never rewritten.

Provider parsers own their normalization rules. The database does not treat an
arbitrary URL string as canonical identity. Linear/Jira support is explicitly
deferred, but does not require a schema change.

## API shape

Authenticated owner routes live under the existing workspace boundary:

```text
POST   /v1/:workspace/galleries
GET    /v1/:workspace/galleries
GET    /v1/:workspace/galleries/:id
PATCH  /v1/:workspace/galleries/:id
DELETE /v1/:workspace/galleries/:id

POST   /v1/:workspace/galleries/:id/items
PUT    /v1/:workspace/galleries/:id/items/order
PATCH  /v1/:workspace/galleries/:id/items/:itemId
DELETE /v1/:workspace/galleries/:id/items/:itemId

POST   /v1/:workspace/galleries/:id/external-references
DELETE /v1/:workspace/galleries/:id/external-references/:referenceId
GET    /v1/:workspace/galleries/by-reference?...normalized fields...
```

The narrow unauthenticated read model is:

```text
GET /public/galleries/:id
```

The Astro route `https://uploads.sh/g/:id` consumes this endpoint. API and web
remain separate deployables; an unavailable or not-yet-migrated API produces a
safe gallery-unavailable page rather than exposing internals.

Create example:

```http
POST /v1/acme/galleries
Authorization: Bearer up_acme_...
Content-Type: application/json

{
  "title": "Settings redesign",
  "description": "Before and after media for the rollout.",
  "items": [
    { "objectKey": "screenshots/settings-before.png", "altText": "Old settings page" },
    { "objectKey": "screenshots/settings-after.png", "altText": "New settings page" }
  ],
  "externalReferences": [
    {
      "provider": "github",
      "resourceType": "item",
      "locator": { "owner": "buildinternet", "repository": "uploads", "number": 123 }
    }
  ]
}
```

Response:

```json
{
  "id": "gal_dBjftJeZ4CVP-mB92K27uh",
  "url": "https://uploads.sh/g/gal_dBjftJeZ4CVP-mB92K27uh",
  "workspace": "acme",
  "visibility": "public",
  "title": "Settings redesign",
  "description": "Before and after media for the rollout.",
  "coverItemId": null,
  "version": 1,
  "items": [
    {
      "id": "a711bf3e-6737-4c30-8d42-50535716c7bb",
      "objectKey": "screenshots/settings-before.png",
      "position": 1000,
      "status": "available",
      "url": "https://storage.uploads.sh/acme/screenshots/settings-before.png",
      "contentType": "image/png",
      "altText": "Old settings page"
    }
  ],
  "externalReferences": [],
  "createdAt": "2026-07-11T21:00:00.000Z",
  "updatedAt": "2026-07-11T21:00:00.000Z"
}
```

Owner responses include `workspace` and `objectKey`. The public response omits
both, along with provenance, hashes, uploader identity, raw provider metadata,
and precise object timestamps. It returns item ID, display filename, media type,
public URL, availability status, caption/alt text, and gallery metadata.
The public response includes a `references` array projecting each external
reference as `{provider, resourceType, coordinate, canonicalUrl}` (issue #60);
ids, timestamps, and normalized keys are omitted. Callers must still be warned
not to link a sensitive private-repository coordinate, since linked coordinates
are visible to anyone holding the gallery URL.

All errors use `AppError` subclasses and the existing nested wire envelope.
Mutations use the workspace write-rate limiter. Owner list and reverse-reference
results are cursor-paginated. Public reads are bounded by the 100-item cap.

## Authentication compatibility

Adding `galleries:*` scopes would require deciding how every existing D1 and
legacy workspace token migrates. V1 instead treats galleries as organization of
the same public files those tokens already manage:

- `files:read`: owner gallery read/list and authenticated reverse lookup.
- `files:write`: create/update/delete gallery metadata; add/remove/reorder items;
  add/remove external references.
- `files:delete`: unchanged and required only to delete underlying objects.

Deleting a gallery with `files:write` is safe because it does not delete stored
bytes. A future private-gallery or multi-user permissions model should introduce
dedicated scopes as an explicit versioned migration.

## Deletion and retention

Gallery deletion is a soft delete of control-plane state. It immediately hides
the gallery from public and owner lists and cascades/removes its memberships and
references when later hard-purged. It never deletes an object. Removing an item
or reference likewise removes only that relationship.

Underlying object deletion and the existing retention sweep operate independently:

- An item whose object disappears remains in the gallery as `status: "missing"`.
- Public UI says “removed or expired” without revealing the cause.
- A missing cover falls back to the first available item, then no cover.
- Adding an existing old object does not renew its `lastModified` timestamp.
- Galleries do not exempt or pin objects against workspace retention.
- Re-uploading the same workspace/key makes every referencing gallery available
  again and uses the newly computed public URL/metadata.

Lazy availability checks at read time are the v1 source of truth. Strong D1↔R2
referential integrity, deletion events, and background tombstone reconciliation
are deferred.

Soft-deleted galleries have no restoration API in v1. Metadata may be hard
purged after an operator-defined period in a later maintenance issue. Empty
galleries remain valid until explicitly deleted.

## Security and privacy

“Public” means anyone with the gallery URL can enumerate its title,
description, references, filenames/display metadata, and media. It does not
inherit GitHub, Linear, or repository visibility. Linking a public gallery to a
private repository can reveal the repository name, work-item number, filenames,
captions, and media. The UI, CLI, MCP descriptions, and documentation must state
this clearly.

V1 protections:

- Cryptographically random IDs, while explicitly not calling them access control.
- Exact-ID public lookup only; no public workspace or coordinate search.
- `noindex` and a restrictive CSP on gallery pages.
- Plain-text title/description/caption/alt rendering; no raw HTML.
- No EXIF, provenance, content hash, uploader identity, or precise upload time in
  the public payload.
- Existing byte-sniffed content allowlist remains authoritative; SVG stays excluded.
- Tenant ownership is checked before every authenticated read or mutation.
- All object operations continue through `createStorage()`.

## Limits and non-goals

V1 limits:

- 100 items per gallery.
- 20 external references per gallery.
- Title 120 characters.
- Description 2,000 UTF-8 bytes.
- Caption 500 UTF-8 bytes.
- Alt text 300 UTF-8 bytes.

Explicitly deferred:

- Private, password-protected, or authenticated galleries.
- Calling public-by-random-ID “unlisted”; it would imply security not provided.
- Cross-workspace items, ownership transfer, or gallery-owned object copies.
- Nested galleries, collaboration roles, comments, reactions, or analytics.
- Uploading bytes through a gallery-specific endpoint; clients use normal upload
  then add the resulting object key.
- Automatic deletion of objects when a gallery/item is deleted.
- Retention pinning, thumbnails/transcoding, or gallery-specific transformations.
- GitHub App/webhook sync and automatic repository rename/transfer handling.
- GitHub custom autolinks as a launch feature.
- Provider-specific Linear/Jira behavior.
- A public coordinate-to-gallery resolver or aggregate page.

## Migration and rollout

Gallery tables arrive in an additive timestamped D1 migration. The existing
worker continues to operate against a database containing unused gallery tables,
which keeps rollback compatible. `deploy:api` applies the migration before the
API worker deploy; the public web route ships only after its narrow public API
is available and must degrade safely during staggered rollout.

Server/web groundwork does not itself release `@buildinternet/uploads`.
User-visible client, CLI, or stdio MCP changes require a changeset for that
package and synchronized `skills/uploads-cli/SKILL.md` documentation. Remote MCP
tool changes require its own contract tests and documentation.

## Testing contract

- ID generation has 128 bits of randomness, the exact `gal_` format, and no
  timestamp/workspace leakage.
- Every database path is tenant-scoped; cross-workspace IDs produce the same
  not-found behavior as absent IDs.
- The same object can appear in several galleries without copying or
  double-counting bytes, but not twice in one gallery.
- Reorder is atomic, complete, version-checked, and deterministic.
- Many galleries can link to one normalized reference and one gallery can link
  to many references.
- Public reads require an exact active public ID and expose only allowlisted fields.
- Object delete/retention produces a durable missing item; re-upload restores it.
- Gallery/item deletion never deletes object bytes.
- One end-to-end contract covers create → upload → add → link → render.
- API, web, CLI, and MCP use the same gallery ID, URL, and reference normalization.
