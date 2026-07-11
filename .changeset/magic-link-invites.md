---
"@buildinternet/uploads": minor
---

`uploads admin invite create` now prints a single self-contained magic link by
default. The one-time code rides in the link's URL fragment (`…/invite?id=…#code=…`),
which browsers never send to a server, so the invite page can offer a one-click login
command while the code stays out of query strings, server logs, and referrers—and
opening the page neither logs nor consumes it. Pass `--separate-code` for the previous
two-channel output (a non-secret page URL plus a code you deliver separately). The
invite page also now shows which workspace the invitation is for.
