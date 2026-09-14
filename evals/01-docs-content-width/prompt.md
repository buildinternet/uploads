---
max_turns: 30
timeout_seconds: 900
allowed_tools: [Skill, Read, Glob, Grep, Edit, Write]
runs: 3
---

This checkout is the `buildinternet/uploads` web app, on branch
`feat/docs-content-width`. The docs page is `src/pages/docs.astro` and its styles
are in `src/styles/app.css`. A dev server is running at
http://localhost:4321/docs

Let's increase the max width of the content area of our docs/guides to match how
we do it in the releases app (responsive layout). Currently, we have a very
narrow content area, even in cases where we have plenty of screen space.

Make the change, then get everything ready for a pull request and give me the
`gh pr create` command to run. (Don't run `gh` yourself — there's no network
here.)
