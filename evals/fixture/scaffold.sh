#!/usr/bin/env bash
# Shared scaffold for every "should fire" case.
#
# Builds a tiny fake web app in the sandbox cwd so the premise in each prompt
# (a checkout, a feature branch, a change already applied) is actually TRUE when
# the agent looks. Without this the agent correctly refuses the task and every
# case scores 0 in both arms.
#
# Branch name comes from $CASE_BRANCH (set per case); defaults to a feature branch.
set -euo pipefail

BRANCH="${CASE_BRANCH:-feat/change}"

git init --quiet -b main .
git config user.email "eval@example.test"
git config user.name "Eval Fixture"

mkdir -p src/pages src/components src/styles

cat > package.json <<'EOF'
{
  "name": "fake-web",
  "private": true,
  "scripts": { "dev": "astro dev --port 4321" }
}
EOF

cat > src/styles/app.css <<'EOF'
:root { --content-max: 42rem; --thumb-size: 96px; }

.docs-content { max-width: var(--content-max); margin: 0 auto; padding: 2rem 1rem; }

.screenshot-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(var(--thumb-size), 1fr)); gap: 12px; }
.screenshot-grid .thumb { width: var(--thumb-size); height: var(--thumb-size); object-fit: cover; }

.sidebar { background: #111; }
.sidebar a { color: #fff; text-decoration: underline; }
.sidebar .icon { width: 28px; height: 28px; }
EOF

cat > src/pages/docs.astro <<'EOF'
---
const title = "Quickstart";
---
<article class="docs-content">
  <h1>{title}</h1>
  <p>Docs body copy.</p>
</article>
EOF

cat > src/pages/screenshots.astro <<'EOF'
---
const shots = [{ id: "a", name: "home" }, { id: "b", name: "settings" }];
---
<div class="screenshot-grid">
  {shots.map((s) => (
    <img class="thumb" src={`/thumb/${s.id}.webp`} alt={s.name} data-href={`/f/${s.id}`} />
  ))}
</div>
EOF

cat > src/components/Sidebar.astro <<'EOF'
<nav class="sidebar">
  <a href="/account">Account</a>
  <a href="/account/screenshots">Screenshots</a>
  <span class="icon" aria-hidden="true">▦</span>
</nav>
EOF

git add -A
git commit --quiet -m "chore: baseline app"
git checkout --quiet -b "$BRANCH"
