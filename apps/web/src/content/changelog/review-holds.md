---
title: "Uploads that show a secret wait for review"
date: 2026-10-19T18:00:00Z
tags: [platform, web, cli, mcp]
image:
  url: https://storage.uploads.sh/default/screenshots/misc/changelog/review-holds-463997.webp
  alt: "A held file page with an amber Held for review banner, an Approve and publish button, and the flagged lines outlined in the preview"
---

Agents take a lot of screenshots, fast, and nobody reads each one before it
goes up. Sooner or later one of them catches a terminal with an API key, an
`.env` file, or a customer's card number. Every uploads.sh URL is public, so
that shot needs to stop before it reaches a pull request.

Now it does. When [AI labels](/docs/ai-labels) are on for a workspace, each
image is checked shortly after upload. If the labeler is confident the image
shows a credential (an API key, a password, a token, a private key) or an ID
document or financial details, the file is **held for review**:

- **The link is paused.** On hosted storage, the image URL shows a "Held for
  review" card until a member approves it. Approval brings the file back at
  the same URL, so nothing needs re-linking.
- **The PR comment leaves it out.** One line says how many files are held and
  how to approve them. It never names the file. The comment's **View on
  uploads.sh** button turns golden while anything is held.
- **Members see the real file.** Signed in, the file page shows the image with
  the flagged area outlined, the reason, and **Approve and publish**. The
  outline is approximate, so check the whole image.

Any workspace member can approve, wherever they happen to be:

```bash
uploads approve --pr 12        # list held files on a PR and why
uploads approve --pr 12 --all  # approve them all
```

The hosted and local MCP servers have `list_held` and `approve` tools, so the
agent that took the shot can ask you about it in the chat. With the
[Slack app](/docs/slack#held-uploads) connected, the uploader gets a DM with
**Approve** and **Keep held** buttons. You can also turn on an email for each
new hold under Email notifications in your account settings. It's off by
default.

Each approval records who released the file and when, shown to members in a
**Reviewed** section on the file page. Approved one by mistake? **Hold for
review again** is in the ⋯ menu.

If a held file really does show a credential, rotate the credential first,
then delete or replace the file. Approving doesn't make a leaked key safe.

What to know:

- **It fails open.** A classifier error or timeout never holds a file, and a
  hold never blocks a merge.
- **Client versions.** Holds apply to uploads from `uploads` 0.59.0 or newer
  (the first release with `uploads approve`) and from the hosted MCP server.
  Signed uploads over 25 MB aren't checked.
- **Narrow on purpose.** Names and emails in a signed-in header don't hold a
  file, and neither does general contact info.
- **Your own bucket.** A file in a [bring-your-own bucket](/docs/byo-bucket)
  keeps serving from your domain. The hold covers the comment, feeds, and
  galleries.

AI labels are still experimental and off by default. To try them on your
workspace, [open an issue](https://github.com/buildinternet/uploads/issues).
Admins can turn labels, or just holds, off under **Settings → AI labels**.
See [Held uploads](/docs/ai-labels#held-uploads) for the full rules.
