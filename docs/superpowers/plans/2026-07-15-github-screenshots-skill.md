# In-repo `github-screenshots` Workflow Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a thin `github-screenshots` workflow skill inside this repo (screenshots/recordings → PRs, issues, share links), trim the `uploads-cli` skill's trigger surface to CLI mechanics, and make `uploads install` install both skills.

**Architecture:** Two SKILL.md files split by altitude — a workflow skill that owns the "get this visual into a PR/issue/in front of a person" moment and defers to the CLI-reference skill, plus a list-driven change to `packages/uploads/src/commands/install.ts` so the skill step runs `npx skills add` once per skill and reports each step separately.

**Tech Stack:** Markdown skills (`npx skills add` convention), TypeScript CLI (`packages/uploads`), Vitest, Changesets.

**Spec:** `docs/superpowers/specs/2026-07-15-github-screenshots-skill-design.md`

## Global Constraints

- No capture implementation: no `uploads shot`, no bundled Playwright/capture scripts. Capture stays tool-agnostic.
- The new skill must NOT claim capture phrasings like "screenshot this page" in its description.
- No changes to the external `buildinternet/skills` repo in this plan.
- New skill body target: well under 150 lines.
- Repo commit style: conventional commits, no sensational adjectives.
- Product-facing examples use the global `uploads …` binary, never `pnpm uploads …`.
- Test command: `pnpm --filter @buildinternet/uploads test` (vitest); typecheck: `pnpm --filter @buildinternet/uploads typecheck`.
- A husky pre-commit hook runs wrangler types + lint-staged; it is slow but normal — do not bypass it.

---

### Task 1: Create the `github-screenshots` workflow skill

**Files:**

- Create: `skills/github-screenshots/SKILL.md`

**Interfaces:**

- Consumes: nothing (pure content).
- Produces: a skill named `github-screenshots` installable as `npx skills add buildinternet/uploads --skill github-screenshots`. Task 3 hardcodes this name; Task 4 links this path.

- [ ] **Step 1: Write the skill file**

Create `skills/github-screenshots/SKILL.md` with exactly this content:

````markdown
---
name: github-screenshots
description: >-
  Embed screenshots, images, diagrams, GIFs, and screen recordings in GitHub
  PRs and issues — or get a durable public link to share a visual with a
  person. Use this whenever a visual needs to end up in a PR description,
  issue body, or PR/issue comment, or in front of a teammate. Triggers include
  "attach a screenshot to the PR", "add a before/after to the issue", "include
  a screenshot of …", "share a GIF of the flow", "record the bug and put it in
  the issue", "get me a link I can paste in Slack", or having just captured or
  changed something visual that a shot would make clearer. Reach for this
  instead of drag-and-drop or github.com/user-attachments (agents can't upload
  there) and instead of hand-rolling cloud-storage uploads. Capture the visual
  with whatever browser or screenshot tooling you have; this skill covers
  hosting and embedding it.
---

# Screenshots and recordings in GitHub PRs and issues

## Why this exists

GitHub's native image hosting (`github.com/user-attachments/…`) only works
from an authenticated browser session — there is no `gh` CLI or REST endpoint
for it. Any image URL in a PR/issue body written with `gh … --body-file` must
already point at something publicly hosted. The **`uploads` CLI** provides
that: it hosts the file on uploads.sh and returns a stable public URL plus
ready-to-paste markdown.

## Step 1 — Get the visual (any tool)

Capture is tool-agnostic. Use whatever this environment has and save a local
file:

- The agent harness's own browser tools (screenshot the preview pane).
- A Playwright/browser MCP, `agent-browser`, or similar automation.
- An OS screenshot or screen recording the user already made.
- Any existing image, GIF, or diagram file.

GIFs and video upload as-is — the client-side optimizer only rewrites still
images (PNG/JPEG → WebP). No special flags needed for motion.

## Step 2 — Host and embed

For the common case — files attached to the current branch's PR — use
`uploads attach`. It infers the PR, uploads under stable keys, and maintains
a single managed "attachments" comment:

```bash
uploads attach ./before.png ./after.png
uploads attach ./flow.gif --issue 45 --repo myorg/myapp
uploads attach ./shot.png --no-comment      # stable URLs only, no comment
```

For a URL you'll hard-code in a PR/issue body (re-uploads overwrite in place,
URL never changes):

```bash
uploads put ./after.png --pr 123 --alt "Dashboard after" --width 700
```

For a durable public link to share anywhere (Slack, docs, a teammate):

```bash
uploads put ./demo.gif --format url
```

Always embed the returned **markdown** (or `embedUrl`) in GitHub — it uses the
no-cache host so overwrites propagate. Don't hand-build storage URLs.

## Step 3 — Embed well

- **Meaningful alt text**, always (`--alt`).
- **Constrain width** on large shots with `--width` (emits sized `<img>`).
- **Before/after** reads best side by side:

  ```markdown
  | Before                               | After                               |
  | ------------------------------------ | ----------------------------------- |
  | <img width="380" src="…/before.png"> | <img width="380" src="…/after.png"> |
  ```

- **Motion:** GitHub markdown won't autoplay MP4 URLs — prefer a GIF, or a
  still image that links to the video URL.
- Write bodies to a file and use `gh pr edit --body-file` / `gh issue comment
--body-file` rather than inline HEREDOCs.

## Setup and escalation

- CLI missing? `npm install --global @buildinternet/uploads`
- Not authenticated? `uploads login` (one-time, opens a browser), then
  `uploads doctor` to verify.
- Everything deeper — flags, key layouts, metadata and search, galleries,
  config defaults, output formats, exit codes — lives in the **uploads-cli**
  skill and `uploads <command> --help`.

## Cautions

- **Uploads are public and effectively permanent** until deleted. GitHub repo
  visibility is not an access control, and `gh/<owner>/<repo>/pull/<num>/…`
  keys are predictable. Never upload secrets, tokens, or customer PII —
  crop/redact first.
````

- [ ] **Step 2: Verify frontmatter parses and the capture-phrase constraint holds**

Run:

```bash
node -e '
const fs = require("fs");
const s = fs.readFileSync("skills/github-screenshots/SKILL.md", "utf8");
const m = s.match(/^---\n([\s\S]*?)\n---\n/);
if (!m) throw new Error("no frontmatter");
if (!/name: github-screenshots/.test(m[1])) throw new Error("bad name");
if (/screenshot this page/i.test(m[1])) throw new Error("claims capture trigger");
console.log("ok, body lines:", s.split("\n").length);
'
```

Expected: `ok, body lines:` followed by a number under 150.

- [ ] **Step 3: Commit**

```bash
git add skills/github-screenshots/SKILL.md
git commit -m "feat(skills): add github-screenshots workflow skill"
```

---

### Task 2: Trim the `uploads-cli` skill description to CLI mechanics

**Files:**

- Modify: `skills/uploads-cli/SKILL.md:1-14` (frontmatter only; body unchanged)

**Interfaces:**

- Consumes: the `github-screenshots` skill name from Task 1 (referenced in the description).
- Produces: nothing downstream.

- [ ] **Step 1: Replace the frontmatter description**

In `skills/uploads-cli/SKILL.md`, replace the entire frontmatter block (lines 1–14, from the opening `---` through the closing `---`) with:

```yaml
---
name: uploads-cli
description: >-
  Reference for the uploads CLI — host files on uploads.sh and manage them.
  Covers put and attach, stable PR/issue keys, the managed attachments
  comment, metadata and search, galleries, config defaults, login/doctor, and
  output formats. Use when driving the `uploads` CLI or its MCP tools, when
  you need a public URL for a local file ("upload this", "host this image",
  "give me a public URL for this file"), or when you need exact flags, key
  layouts, or setup and auth details. For the when-and-how of getting a
  screenshot or recording into a GitHub PR or issue, start with the
  github-screenshots skill — it defers here for CLI detail.
---
```

Do not change anything below the closing `---`.

- [ ] **Step 2: Verify only the frontmatter changed**

Run: `git diff --stat skills/uploads-cli/SKILL.md && git diff skills/uploads-cli/SKILL.md | grep '^+' | grep -v '^+++' | grep -cv 'description\|name:\|^+---\|^+  '`

Expected: 1 file changed; the count is `0` (no body lines added).

- [ ] **Step 3: Commit**

```bash
git add skills/uploads-cli/SKILL.md
git commit -m "docs(skills): scope uploads-cli skill description to CLI reference"
```

---

### Task 3: `uploads install` installs both skills

**Files:**

- Modify: `packages/uploads/src/commands/install.ts`
- Test: `packages/uploads/test/install.test.ts`

**Interfaces:**

- Consumes: skill names `uploads-cli` and `github-screenshots` (Task 1).
- Produces: result-record keys `skill:uploads-cli`, `skill:github-screenshots`, `mcp` in both human and `--json` output. Human success footer says `Done — skills and mcp ready.`; the partial-failure nudge says `Skills are installed.`

- [ ] **Step 1: Update the tests to the two-skill contract (failing first)**

In `packages/uploads/test/install.test.ts`, make these changes:

Replace the body of the first test (`runs both steps by default…`) `expect(calls)` with:

```ts
expect(calls).toEqual([
  [
    "npx",
    "-y",
    "skills",
    "add",
    "buildinternet/uploads",
    "--skill",
    "uploads-cli",
    "-g",
    "-y",
    "-a",
    "*",
  ],
  [
    "npx",
    "-y",
    "skills",
    "add",
    "buildinternet/uploads",
    "--skill",
    "github-screenshots",
    "-g",
    "-y",
    "-a",
    "*",
  ],
  [
    "claude",
    "mcp",
    "add",
    "--transport",
    "http",
    "uploads",
    DEFAULT_MCP_URL,
    "--header",
    "Authorization: Bearer up_acme_secret",
  ],
]);
```

In the test `prints step progress and suppresses child output on success`, replace:

```ts
expect(printed).toContain("Installing skill…");
expect(printed).toMatch(/skill: ok/);
```

with:

```ts
expect(printed).toContain("Installing skills…");
expect(printed).toMatch(/skill:uploads-cli: ok/);
expect(printed).toMatch(/skill:github-screenshots: ok/);
```

In the test `install skill runs only the skills step`, replace the two assertions after the `runInstall` call with:

```ts
expect(calls).toHaveLength(2);
expect(calls.every((c) => c[0] === "npx")).toBe(true);
```

In the test `install all without a token still installs the skill, then nudges login for MCP`, replace:

```ts
expect(calls).toHaveLength(1);
expect(calls[0][0]).toBe("npx");
expect(out.join("")).toMatch(/skill: ok/);
```

with:

```ts
expect(calls).toHaveLength(2);
expect(calls.every((c) => c[0] === "npx")).toBe(true);
expect(out.join("")).toMatch(/skill:uploads-cli: ok/);
expect(out.join("")).toMatch(/skill:github-screenshots: ok/);
```

and replace `expect(out.join("")).toMatch(/Skill is installed/);` with `expect(out.join("")).toMatch(/Skills are installed/);`.

Add this new test inside the `describe` block:

```ts
it("--json reports each skill step under its own key", async () => {
  const { run } = fakeRunner();
  const { out } = captureStreams();
  const code = await runInstall(["skill"], { globals: GLOBALS, json: true, runner: run });
  expect(code).toBe(0);
  const parsed = JSON.parse(out.join(""));
  expect(parsed.ok).toBe(true);
  expect(Object.keys(parsed.steps)).toEqual(["skill:uploads-cli", "skill:github-screenshots"]);
});
```

- [ ] **Step 2: Run the install tests to verify they fail**

Run: `pnpm --filter @buildinternet/uploads test -- test/install.test.ts`

Expected: FAIL — the default-run test sees 2 calls instead of 3, progress-text assertions miss.

- [ ] **Step 3: Implement the list-driven skill step**

In `packages/uploads/src/commands/install.ts`:

Replace line 14 (`const SKILL_NAME = "uploads-cli";`) with:

```ts
const SKILL_NAMES = ["uploads-cli", "github-screenshots"];
```

Replace the `INSTALL_HELP` intro paragraph and the two blocks under it so the help reads:

```ts
const INSTALL_HELP = `uploads install — set up agent integrations (skills + remote MCP)

Installs the github-screenshots and uploads-cli agent skills and registers
the hosted MCP server with Claude Code. The remote MCP endpoint infers your
workspace from the bearer token, so only the token is needed.

Usage:
  uploads install [skill|mcp|all]     (default: all)

What it does:
  skill   Agent skills (via npx skills) — github-screenshots: visuals into
          PRs/issues; uploads-cli: full CLI reference
  mcp     Hosted MCP server in Claude Code — put, list, attach, galleries

What runs under the hood:
  skill   npx -y skills add ${SKILL_SOURCE} --skill <name> -g -y -a '*'
          (once per skill: ${SKILL_NAMES.join(", ")})
  mcp     claude mcp add --transport http uploads ${DEFAULT_MCP_URL} \\
            --header "Authorization: Bearer <token>"

Options:
  --url <endpoint>    Remote MCP endpoint (default: ${DEFAULT_MCP_URL})
  --name <name>       MCP server name in the client (default: uploads)
  --dry-run           Print the plan without running anything
  --verbose           Show underlying command output (default: errors only)

Examples:
  uploads install
  uploads install skill
  uploads install mcp
  uploads install --dry-run
`;
```

Replace `skillCommand()`:

```ts
function skillCommand(skill: string): string[] {
  // -g global, -y non-interactive, -a '*' every agent (skips the multi-select TUI)
  return ["npx", "-y", "skills", "add", SKILL_SOURCE, "--skill", skill, "-g", "-y", "-a", "*"];
}
```

Replace the skill branch in `runInstall`:

```ts
if (target === "skill" || target === "all") {
  if (human) process.stdout.write("Installing skills…\n");
  for (const skill of SKILL_NAMES) {
    const command = skillCommand(skill);
    results[`skill:${skill}`] = dryRun
      ? { command, ok: true, skipped: "dry-run" }
      : runStep(run, command);
  }
}
```

Replace the success-footer call and the partial-failure branch at the bottom of `runInstall` (currently `printSuccessFooter(Object.keys(results), signedIn);` and the `else if` that checks `results.skill?.ok`):

```ts
const skillResults = Object.entries(results)
  .filter(([step]) => step.startsWith("skill:"))
  .map(([, r]) => r);
const skillsOk = skillResults.length > 0 && skillResults.every((r) => r.ok);

if (!failed && !dryRun) {
  const stepLabels = [
    ...new Set(Object.keys(results).map((k) => (k.startsWith("skill:") ? "skills" : k))),
  ];
  printSuccessFooter(stepLabels, signedIn);
} else if (failed && !dryRun && skillsOk && results.mcp && !results.mcp.ok) {
  const next =
    results.mcp.skipped === "sign-in"
      ? "Sign in with `uploads login`, then re-run `uploads install mcp`."
      : "Fix the MCP step above, then re-run `uploads install mcp`.";
  process.stdout.write(`\nSkills are installed. ${next}\n`);
}
```

- [ ] **Step 4: Run the install tests to verify they pass**

Run: `pnpm --filter @buildinternet/uploads test -- test/install.test.ts`

Expected: PASS (all tests, including the new `--json` one).

- [ ] **Step 5: Typecheck and full package tests**

Run: `pnpm --filter @buildinternet/uploads typecheck && pnpm --filter @buildinternet/uploads test`

Expected: both PASS. (The help-snapshot tests in `cli-help.test.ts` / `cli-style-help.test.ts` may assert on install help text — if one fails on the new wording, update its expected string to match the new `INSTALL_HELP` verbatim.)

- [ ] **Step 6: Commit**

```bash
git add packages/uploads/src/commands/install.ts packages/uploads/test/install.test.ts
git commit -m "feat(cli): uploads install adds the github-screenshots skill"
```

---

### Task 4: Update repo docs for the two-skill split

**Files:**

- Modify: `AGENTS.md` (layout block + skill paragraph)
- Modify: `README.md:85-89` (install snippet) and `README.md:106` (repo table)
- Modify: `docs/cli.md:17,42,178-186` (install mentions + Agent skill section)

**Interfaces:**

- Consumes: skill names/paths from Tasks 1–3.
- Produces: nothing downstream.

- [ ] **Step 1: AGENTS.md**

In the layout block, replace:

```
skills/uploads-cli  Agent skill for driving the CLI (host a file → embed in a PR/issue)
```

with:

```
skills/github-screenshots  Workflow skill — screenshots/recordings into PRs, issues, share links
skills/uploads-cli  Agent skill for driving the CLI (full reference: commands, flags, keys)
```

Replace the paragraph starting `The `uploads-cli`skill in`skills/uploads-cli/SKILL.md` is checked in…` with:

```markdown
Two agent skills are checked in at the repo root so they're installable via
the `npx skills add` convention (and by `uploads install`):
`skills/github-screenshots` is the thin workflow skill (when a screenshot or
recording should go into a PR/issue or be shared as a link — the in-repo
successor to the external `github-screenshots` skill's bundled R2 scripts),
and `skills/uploads-cli` is the full CLI reference it defers to. Keep both in
sync when the CLI's commands or flags change.
```

- [ ] **Step 2: README.md**

Replace the agent-skill snippet (currently the single `npx skills add buildinternet/uploads --skill uploads-cli` fence and its intro sentence) with:

````markdown
**Agent skills** — auto-triggering playbooks, installable into any agent
runtime without checking out anything (`uploads install` runs these for you):

```bash
npx skills add buildinternet/uploads --skill github-screenshots   # visuals → PRs/issues
npx skills add buildinternet/uploads --skill uploads-cli          # full CLI reference
```
````

In the "What's in this repo" table, replace the `skills/uploads-cli/` row with:

```markdown
| `skills/github-screenshots/` | Workflow skill — visuals into PRs/issues/share links |
| `skills/uploads-cli/` | Agent skill for driving the CLI |
```

(Re-align the table's column padding to match the surrounding rows.)

- [ ] **Step 3: docs/cli.md**

Line 17: change `# install the agent skill + register the hosted MCP server` to `# install the agent skills + register the hosted MCP server`.

Line 42 (command table): change `Install the agent skill + register the remote MCP server` to `Install the agent skills + register the remote MCP server`.

Replace the "Agent skill" section (heading and body around lines 178–186) with:

````markdown
## Agent skills

For agent runtimes, install the checked-in skills as well (`uploads install`
does this for you):

```bash
npx skills add buildinternet/uploads --skill github-screenshots
npx skills add buildinternet/uploads --skill uploads-cli
```

[`skills/github-screenshots/SKILL.md`](../skills/github-screenshots/SKILL.md)
is the workflow skill (screenshots/recordings into PRs and issues);
[`skills/uploads-cli/SKILL.md`](../skills/uploads-cli/SKILL.md) is the full
CLI reference it defers to. See [api.md](api.md) for REST routes.
````

- [ ] **Step 4: Verify no stale single-skill references remain**

Run: `grep -rn "the agent skill\b\|--skill uploads-cli" README.md AGENTS.md docs/cli.md | grep -v "github-screenshots"`

Expected: only lines that intentionally install `uploads-cli` alongside the new skill (the paired `npx skills add … --skill uploads-cli` lines); no prose describing a single skill.

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md README.md docs/cli.md
git commit -m "docs: describe the github-screenshots + uploads-cli skill split"
```

---

### Task 5: Changeset and final verification

**Files:**

- Create: `.changeset/install-github-screenshots-skill.md`

**Interfaces:**

- Consumes: everything above.
- Produces: release notes for the next `@buildinternet/uploads` version.

- [ ] **Step 1: Write the changeset**

Create `.changeset/install-github-screenshots-skill.md`:

```markdown
---
"@buildinternet/uploads": minor
---

`uploads install` now installs two agent skills: the new `github-screenshots`
workflow skill (when and how to get screenshots, GIFs, and recordings into
GitHub PRs and issues) alongside the existing `uploads-cli` CLI reference.
Skill steps are reported separately in human and `--json` output.
```

- [ ] **Step 2: Full verification**

Run: `pnpm --filter @buildinternet/uploads typecheck && pnpm --filter @buildinternet/uploads test`

Expected: PASS.

Run: `node packages/uploads/bin/uploads.js install --dry-run --json 2>/dev/null || pnpm uploads install --dry-run --json`

Expected: JSON with `steps["skill:uploads-cli"]`, `steps["skill:github-screenshots"]` (both `skipped: "dry-run"`), and an `mcp` step; no token visible.

- [ ] **Step 3: Commit**

```bash
git add .changeset/install-github-screenshots-skill.md
git commit -m "chore: changeset for two-skill uploads install"
```

---

## Manual follow-up checks (post-merge, not tasks)

- Fresh-agent trigger check: "attach this screenshot to the PR" routes to `github-screenshots`; "what flags does uploads put take" routes to `uploads-cli`.
- Retirement path (separate effort, per spec follow-ups): tombstone `buildinternet/skills/github-screenshots`, update external CLAUDE.md references, consider `uploads shot`.
