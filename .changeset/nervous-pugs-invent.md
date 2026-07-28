---
"@buildinternet/uploads": minor
---

Stop hiding the reason a command failed (#545). A missing argument used to
print the command's whole help block with no error line in it — `uploads put`,
`find`, `delete`, `meta`, `gallery`, `screenshot`, `annotate`, and
`config set` all did this. Each now prints one `error:` line naming what is
missing, plus the `uploads <cmd> --help` hint, so trimmed output still carries
the reason and `--json` gets a real error payload. An unknown `config`
subcommand does the same instead of dumping the config help.
