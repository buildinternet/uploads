# Eval suite notes — uploads plugin

## Scope

Suite covers ONE flow: the `github-screenshots` skill.

## Quality spec (what graders are written against)

Derived from the plugin author's real experience, NOT from SKILL.md's own claims.

- **Primary — timing.** Mid-task, right after a visual change, the agent captures and
  stages _then_, unprompted. Deferring to PR time ("I'll grab screenshots when we open
  the PR") or finishing with no capture is the failure that costs a real prompt.
- **Primary — no-dev-server excuse.** When capturing needs a dev server running, the
  agent starts it and captures anyway. Punting ("I can't easily run the app") is a
  fail, not a valid abstention. Suspected cause of the timing failure; graded
  separately so we learn whether it actually is.
- **Secondary (weight 0.5) — metadata.** `--state` present (near-100% today; floor
  check). `--meta path=/route` present ("most of the time" today; room to regress).
- **Secondary (weight 0.5) — transport & URLs.** Uses `uploads` (CLI where there's a
  shell), embeds the returned markdown/embedUrl, never hand-builds a storage URL,
  never reaches for drag-and-drop or github.com/user-attachments.

### Deliberately NOT graded

Whether attached images also appear in the PR **body**. The GitHub App's managed
comment lists every attachment regardless, so body placement is a preference, not a
defect. No grader should punish either choice.

## Deferred work

- **Real git fixtures (option 2).** Cases currently supply branch/repo context in the
  prompt text rather than creating a real git repo in the sandbox. The staging paths in
  the CLI are git-aware — a bare `uploads put` only stages when inside a git repo on a
  non-default branch — so prompt-supplied context exercises the agent's _intent_ but
  not the CLI's real branch-keyed behavior. Worth upgrading eventually: have each case
  `git init` a scratch repo and check out a feature branch before the task, so the
  git-aware code paths actually engage. Costs turns and wall-clock; revisit once the
  timing graders are stable.

- **Non-image artifacts.** This suite grades the screenshot flow only. A real and
  under-tested capability is uploading things GitHub itself refuses: `gh --attach` takes
  media only, while `uploads put` accepts Lighthouse/test reports, logs, JSON, PDFs, and
  zips, and the managed comment links them. The interesting failure mode is an agent
  that produces a coverage report, a bundle-size diff, a failing-test log, or a profiling
  trace and then pastes a truncated blob into the PR body — or claims it "can't attach
  that to GitHub" — instead of hosting the actual artifact. Worth its own set of cases
  once the screenshot timing graders are stable; the trigger language in the skill
  description is screenshot-heavy, so under-triggering on non-media is the thing to
  measure.

## Non-Claude harnesses

Codex and Grok also load this skill in practice. Claude is the primary target for this
suite, but transcript mining covered all three, and fixes that help Claude are expected
to carry over.

## Measured metadata adoption (prod, 2026-09-11)

Queried read-only via `uploads meta keys`. Across 625 objects carrying `gh.repo`:
`path` 445 (~71%), `state` 355 (~57%), `viewport` 296, `url` 275. This is well
below the author's recollection ("state almost always, path most of the time"), so
the `metadata-habit` grader is a live regression target, not a floor check.

Side finding, unrelated to the eval and NOT fixed here: derived `url` metadata on
public objects includes dev claim links with their token intact
(`http://localhost:8788/dev/claim?t=<token>&next=...`). Localhost tokens, so low
severity, but it is a credential-shaped string riding along on a public object,
arriving via automatic derivation rather than anything an agent typed. Worth a
follow-up issue.

## Dropped case

A sixth fire case (Grok's two-page flicker/skeleton-flash fix, shipped and merged
with zero visual evidence and no nudge) was cut from the first pass as too much of
an edge: the defect is motion, so there is no static thing to capture. Revisit when
video recording is in scope — that is the natural home for it.

## Known limitation of the current cases

Because no case grants Bash or Write (see below), each prompt is framed with the
code change already applied. That hands the agent a partial cue: it is asked to
wrap up rather than discovering mid-task that a visual milestone has been reached.
The graded behavior — capture and stage BEFORE the PR, not after — still matches
the observed failure, but a fixture-based version (option 2 above) would test
discovery too.

## Why no Bash / no Write

The `uploads` CLI is installed and authenticated on the author's machine. Granting
Bash would make every eval run upload real files to production under real
credentials (7 cases x 3 runs x 2 arms). Instead the mocked hosted MCP server is the
only upload path available, which keeps prod untouched and makes "did it stage?" a
checkable tool call. Consequence: the without-plugin arm has no MCP server, so
`tool_used` graders score 0 there by construction — they are weighted 0.5 and paired
with an LLM primary that BOTH arms can pass by stating the capture step.

## Case 05 scoping

The first version of this case asked for the alert emails at 50/90/100%. The agent
captured the same rendered preview three times under different names and tripped
the mock's near-duplicate `abort_when` — a true positive for the defect the author
reported, but it left the case unable to score its actual question (does the agent
recognize a rendered email as a visual artifact worth hosting?). Scoped the prompt
to the single 90% email so one capture is the natural answer. The duplicate guard
still protects every case, since `abort_when` is server-wide, not per-case.

## Models

The agent under test is pinned to Sonnet (`--model sonnet` in run.sh) so scores stay
comparable across runs and a model rollout can't be mistaken for a plugin regression.
The judge is also Sonnet (`--judge-model sonnet`) — a sonnet-tier or larger judge is
required; small judges miss nuance.

Caveat worth remembering when reading the numbers: the transcripts this suite was built
from were mostly Opus/Codex/Grok sessions. The suite measures how the plugin steers
Sonnet, which is not identical to the sessions where the misses were originally observed.
An Opus run (`--model opus`) is the cross-check if a Sonnet result ever looks surprising.

## Tracking performance per model

Treat the model as part of the result, not a detail of how it was run. A score is only
meaningful as "<score> on <model>, <date>" — the same suite on Sonnet and Opus answers
different questions, and neither transfers to the other.

Suggested convention when you want a comparable series:

```bash
./run.sh --ablation with-without --output-dir results/sonnet-$(date +%F)
./run.sh --ablation with-without --model opus --output-dir results/opus-$(date +%F)
```

`--json <path>` writes the machine-readable result document if you ever want to chart a
trend. Two rules for any trend line: leave out documents with `partial: true` (the cost
ceiling was hit, or the run was interrupted) and any run with `skippedPaidGraders: true`,
since its score isn't comparable.

How to read a model's number:

- **Sonnet** is the cheap directional signal — fast enough to run while iterating on the
  plugin, good for "did this change help or hurt."
- **Opus** is closer to the sessions where the original misses were observed, so it is
  the one to trust when deciding whether a fix actually landed.
- A green run on either is evidence about that model only. The skill is also loaded by
  Codex and Grok, which this harness cannot exercise at all — their behavior has to be
  spot-checked by hand in real sessions.

Also worth re-reading rather than trusting the headline: which graders moved. A case can
gain score because the MCP tool became available without the skill ever firing (observed
in `thumbnail-link-bug` during the pilot), which is capability uplift, not steering.

## Grader bug found in the first full run (fixed)

MCP tools are namespaced by the runner as `mcp__plugin_<plugin>_<server>__<tool>`, e.g.
`mcp__plugin_uploads_uploads__screenshot`. The original graders used `mcp__uploads__put`,
which never exists, so:

- `staged-via-uploads` failed in 100% of runs regardless of behavior;
- `no-upload` on both negative cases PASSED vacuously — it asserted that a nonexistent
  tool was not called, which is trivially true. The negatives' clean 1.00 scores in the
  first full run were therefore not evidence of restraint.

Also wrong on substance: it watched `put`. Across 42 runs agents never called `put` once.
They used `screenshot`, which captures and hosts in one step and is what the skill
recommends. Replaced with `hosted-a-capture` watching `screenshot`.

Known remaining flaw: `hosted-a-capture` only watches `screenshot`, so an agent that
correctly used `put` (e.g. hosting a file it already had) would be scored unfairly.
`tool_used` takes one tool and a `not_contains` regex over the trace can't help, because
the trace's session-init block lists every available tool name. Revisit if a `put`-based
solution is ever observed.

## Top issue for the next iteration: intent vs action

The primary LLM graders accept "commits to capturing" as a PASS. Inspection of a
`thumbnails-larger` run that scored `captures-after-state` = PASS shows the agent made NO
uploads tool call at all — it said it would capture and then didn't. So part of the
measured Δ is a shift in stated intent, not in behavior.

This was deliberate (it keeps a grader both arms can pass, so Δ isn't pure capability
uplift), but it is now the weakest link. Options for next time:

- split into two graders: `states-intent` (both arms passable) and `actually-captured`
  (tool call required), and report them separately; or
- require the tool call in the primary and accept that Δ becomes capability-dominated.
  Do not change this without re-piloting — the whole point of the split is that the two
  numbers mean different things.

## Advisor review of the first full run (findings to act on)

An independent review of `aggregate-result.json` turned up four things worth fixing
before anyone trusts a number from this suite:

1. **Δ is unsound as currently built.** Every without-arm run has NO uploads MCP tools
   (`mocks.calls` is null for all 21 of them), so the baseline cannot capture by
   construction and Δ >= 0 is guaranteed. It measures tool presence, not skill guidance.
   Either give the without-arm an equivalent capture path, or stop reporting Δ as the
   headline and report skill-fire rate plus capture rate separately.
2. **Case 07 (`neg-webhook-abstract`) is a bad negative.** Its prompt names "the bot that
   posts the attachments comment with the screenshots on a PR", so an agent loading the
   skill and calling `repo_link_status` is doing defensible diagnosis, not over-firing.
   Its 3/3 fire rate is not evidence of over-triggering. Case 06 (CLI completion, 1/3) is
   a real false positive. Rewrite 07 or drop it as trigger evidence.
3. **The mock serves tools with no descriptions or schema.** Every run warns: no
   `_tools.json` for the uploads server. Agents invented arguments the permissive shadow
   mock accepted. So "agents never called `put`" says nothing about the skill — the model
   never saw what `put` is for. Capture a real `tools/list` (needs OAuth) and save it as
   `mocks/uploads/_tools.json`.
4. **Early-stopping runs pollute the counts.** A dozen runs ended in 1-4 turns
   (`thumbnail-link-bug` without run1 = 1 turn; `neg-cli-completion` with run2 = 1 turn).
   Those look like early stops rather than decisions. Check turn counts before reading any
   per-case rate; a run that stopped at turn 1 neither fired nor declined to fire.

Also: `docs-content-width` with-run0 ran 47 turns and was aborted by the mock's own
near-duplicate guard, recording no graders — that is why its denominator is 2. Aborted
runs vanish from grader tallies rather than scoring 0, so always check n per case.
