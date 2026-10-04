---
"@buildinternet/uploads": minor
---

When the managed PR comment posts through your local `gh` (no GitHub App on the repo), it now matches the bot comment: it creates the pull request's live link (the same feed `uploads feed create --pr` makes), opens with a `N files · View all on uploads.sh →` line, and links each file tagged with that pull request to its live link page. If the live link can't be created (an older server or a network error), the comment renders as before. `linkToFilePage: false` in `.uploads.yml` turns off the line and links each file to its raw URL, as the bot comment does.
