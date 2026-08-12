---
"@buildinternet/uploads": patch
---

Fix `uploads completion zsh` producing a script that could not complete anything.

The generated `_arguments` call was missing line continuations between its
option specs, so zsh ended the call after the first spec and tried to execute
the remaining ones as commands — Tab printed a wall of `command not found`
instead of completing. Short flags now also pair with their long form's
summary, so the menu no longer reads `Show help (short)`.

Regenerate an installed script after upgrading:
`uploads completion zsh > ~/.zsh/completions/_uploads`
