---
"@buildinternet/uploads": minor
---

Add `uploads github doctor` to check whether the GitHub App is subscribed to the webhook events uploads.sh needs (`issues`, `pull_request`). A missing subscription previously failed silently — the App's ping stayed green while webhook auto-promotion and title-cache invalidation quietly did nothing.
