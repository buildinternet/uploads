---
"@buildinternet/uploads": patch
---

Fix `usage`, `reconcile`, and `purge_expired` MCP tools failing with an output validation error. The two-lane storage work added `sharedBytes`, `sharedObjects`, and `storageBudgetBasis` to the usage payload, and the usage route separately stamps `scopes`, `plan`, and `storage`, but the MCP output schema didn't list them, so the strict (`additionalProperties: false`) schema rejected real responses.
