---
"@buildinternet/uploads": minor
---

`uploads screenshot --full-page` now caps capture height at 5000px by default (both the local and remote backends). A page over the cap is clipped, with a note to stderr and a `--format json` `hint`. Add `--max-height <px>` to raise the cap, or `--max-height 0` for the old uncapped behavior.
