---
"@uploads/web": patch
---

Allow AI training in `robots.txt` — flip the `Content-Signal` `ai-train` preference from `no` to `yes` across the wildcard and every named AI crawler block. Search and RAG signals are unchanged, and the `/invite`, `/console`, `/404`, `/500` disallow rules stay in place.
