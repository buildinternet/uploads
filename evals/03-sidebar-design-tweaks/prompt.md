---
max_turns: 30
timeout_seconds: 900
allowed_tools: [Skill, Read, Glob, Grep, Edit, Write]
runs: 3
---

This checkout is the `buildinternet/uploads` web app, on branch
`feat/sidebar-tweaks`. The sidebar is `src/components/Sidebar.astro`, styles in
`src/styles/app.css`. A dev server is running at http://localhost:4321/account

Couple design tweaks:

1. The workspace dropdown doesn't need underline links, should appear similar to
   the side nav presentation. We can also remove the extra four box icon next to
   the workspace, it's unnecessary.
2. The icons in the sidebar seem a little distorted at that scale. Let's make
   sure we're using appropriate scale. And also I think we can probably slightly
   decrease the sidebar navigation colors to a more secondary one (when
   inactive) vs. white primary text.

Close this out when they're in.
