# OpenAI review cases

The canonical five positive and three negative cases are
[review-cases.json](review-cases.json). They cover public uploads, PR attachments,
branch staging, the conversation panel, comment refresh, visible credentials,
workspace isolation, and unauthorized GitHub access.

Build the package and prepare fixtures with [directory.md](directory.md).
The optional public review configuration replaces its template values and adds
an accessible walkthrough recording. Keep reviewer credentials and sign-in
instructions in the portal's private Review details, not in the ZIP.

The prepared positive PR cases expect an installed, authorized fixture repo.
A safe authorization decline remains valid tool behavior; it means the fixture
cannot demonstrate the expected successful comment and must be fixed before
submission. Negative cases must never publish credentials, delete another
workspace's files, or invent a successful GitHub comment.

Reviewers must run the cases against the deployed production endpoint with
the dedicated test account. Local tests and the developer's personal OAuth
connection do not replace this review-account validation.
