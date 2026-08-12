# Publishing a changelog entry

One markdown file per platform update. CLI releases are merged in
automatically from `packages/uploads/CHANGELOG.md` — never write those here.

1. Capture the screenshot (if any).
2. Upload it — never commit images to the repo:

   ```bash
   uploads put shot.png --workspace buildinternet --key changelog/<slug>.png
   ```

   Copy the public `storage.uploads.sh` URL from the output.

3. Create `<slug>.md` in this directory (slug becomes the page anchor):

   ```md
   ---
   title: "Human-readable title"
   date: 2026-08-12
   tags: [platform]
   image:
     url: https://storage.uploads.sh/changelog/<slug>.png
     alt: "What the screenshot shows"
   ---

   Body in plain markdown. Inline images work too, absolute https URLs only.
   ```

4. Open a PR. Merge deploys /changelog and /changelog.xml; releases.sh picks
   up the new entry on its normal feed sweep.

Image rules: absolute `https://` URLs, 1 KB–8 MB, png/jpeg/gif/webp/avif —
that's what releases.sh mirrors into its own storage. `date` supports full
ISO timestamps (`2026-08-12T15:00:00Z`) when same-day ordering matters.
