---
"@buildinternet/uploads": minor
"@uploads/plugin": patch
---

Add `uploads approve`. The classifier can now hold an upload it thinks shows a secret or sensitive personal data, and the managed PR comment shows a held count in its place. `uploads approve --pr <n>` lists held files, `--all` approves them, and `uploads approve <key>` approves one file. The local-gh comment path leaves held files out the same way the bot does. The bundled CLI skill documents the flow.
