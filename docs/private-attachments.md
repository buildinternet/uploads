# Private-repo attachment URLs

How uploads.sh keys GitHub attachments for private repositories, and why the
keys look different from public ones. Follow-up to the derivable-key gap
(#631).

## The problem

A public-repo attachment key is derivable: `gh/<owner>/<repo>/pull/<num>/...`.
Anyone who knows the owner, repo, and PR number can construct the URL. For a
public repo that's fine — the repo itself is public. For a private repo it
isn't: naming the repo is enough to guess its attachment URLs, even though
nobody outside the repo should be able to do that.

## The fix: a randomized prefix

When the uploads GitHub App can see that a target repo is private, attachment
keys use `gh/private/<id>/...` instead of `gh/<owner>/<repo>/...`. The `<id>`
is a random 32-character hex string (about 128 bits), so it isn't guessable
from the owner or repo name.

uploads.sh mints the id server-side and stores it per (owner, repo, branch).
Issue attachments and ingested assets use a repo-level id instead, since they
aren't tied to a branch. Everything beneath the prefix — filenames, the
`pull/<num>` tail — stays exactly as before, so overwrites, before/after
pairing, comment dedupe, and repo/project grouping keep working unchanged.

Public repos are unchanged: they keep the derivable `gh/<owner>/<repo>/...`
layout. Repos the App can't see (not installed) are also unchanged, because
uploads.sh has no way to know they're private.

This applies to new attachments only. Existing attachments keep their
original keys — there's no migration. The comment-gathering logic on a repo
lists both the old derivable shape and the new randomized shape, so a repo
that adopts the App mid-history shows a consistent comment either way.

## Design rule: match GitHub Camo's model

Inline images in PR and issue bodies render through GitHub's Camo proxy.
Camo fetches the image once, caches it, and serves the cached copy from then
on — it does not carry the viewer's GitHub session or check repo membership
on every render. That rules out signed or expiring URLs for this use case:
when Camo's cache expires and it re-fetches, it does so anonymously, so a
signed URL would need to still be valid at some unpredictable future time
with no way to renew it.

So the design follows Camo's own model: a durable, unguessable URL with no
auth gate. That's what the randomized prefix provides.

## Who can discover a URL

The `<id>` appears only in the PR and issue surfaces that repo members can
already see: the managed attachments comment, and any rendered image in a PR
or issue body. Discovering an attachment URL for a private repo requires
being able to view one of those surfaces.

## What this does not protect against

This is the same trust model as GitHub Camo itself, or a docs site's
unlisted share link: a durable, unguessable URL grants read access to
whoever holds it, not to whoever is currently authorized. It's a
capability-URL scheme, not access control.

Concretely: once someone has a URL, they can read it until the branch's id
is rotated, regardless of whether their access to the repo changes in the
meantime. A forwarded link, an ex-collaborator's browser history, or a URL
that ended up in a server log all keep working. Camo's own cached copies stay
visible too, to anyone who could already view the comment or PR body that
embeds them — that's the same audience the source URL was visible to, so it
adds no new exposure.

Rotate a branch's id after removing a collaborator's access, or any other
time you want existing URLs for that branch to stop working.

## Rotating a prefix

```bash
uploads github rotate-prefix --branch <branch>
uploads github rotate-prefix --repo-level
```

Rotation mints a new id and moves every object under the old prefix to the
same tail under the new id. It then deletes the old objects, so the old URLs
404 at origin immediately. It re-syncs the managed comment so it points at
the new URLs.

Camo's own cache is outside uploads.sh's control. A viewer who already has a
Camo-cached copy of an old image keeps seeing it until Camo's cache expires
on its own; new fetches always go through the new URL.

Use `--branch <branch>` to rotate one branch's id, or `--repo-level` to
rotate the id shared by issue attachments and ingested assets.
