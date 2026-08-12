---
"@buildinternet/uploads": patch
---

Fix `uploads completion zsh` producing a script that could not complete anything.

The generated `_arguments` call was missing line continuations between its
option specs, so zsh ended the call after the first spec and tried to execute
the remaining ones as commands — Tab printed a wall of `command not found`
instead of completing. Short flags now also pair with their long form's
summary, so the menu no longer reads `Show help (short)`.

`uploads completion --help` now also covers installation properly. Saving the
script into an fpath directory does nothing when `compinit -C` reuses a cached
dump, which is common under Oh My Zsh, so the help gives the `compdef` binding
that works regardless of startup order.

Regenerate an installed script after upgrading:
`uploads completion zsh > ~/.zsh/completions/_uploads`
