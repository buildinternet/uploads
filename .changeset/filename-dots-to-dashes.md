---
"@buildinternet/uploads": patch
---

New upload keys keep only the final extension dot: interior dots, spaces, and other special characters in a filename collapse to single dashes (`127.0.0.1-admin.webp` → `127-0-0-1-admin.webp`). Existing keys and URLs are unchanged.
