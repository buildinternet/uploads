# Public viewer staging measurements

Issue #1170. Measured on 2026-10-19 UTC in the `codex/issue-1170-viewer`
worktree, based on `8b889b98`, with the viewer and download-routing
changes in this PR. Production routing remains off. Review these results before activation.

The combined viewer reduced first-observed file latency in all six paired runs.
Collection results were mixed. The 100-item gallery showed no consistent paired
improvement. Storage HEAD hydration dominates feed and gallery route time.
These results support reviewing a file-first rollout separately from collections.

## Method

The harness used isolated Workers, a dedicated KV namespace, and preview D1/R2.
Every arm used the same bindings and compatibility settings. Synthetic data stayed
in workspace `viewer-bench-1170`: 100 gallery items, 2,000 feed scope rows, and
151 actual 68-byte PNG objects. The feed list requested 50 available objects.
The pager requested the oldest item while fetching the list concurrently.

Each round deployed new build markers, alternated arm order, and interleaved one
first request plus five warm repeats. The file comparison used six rounds;
other scenarios used four. Per-build index prefixes gave each pager arm an
independent miss followed by hits. Every accepted response passed status, DTO,
byte/hash, and relevant download-header checks.

There are 408 accepted samples. One file round saw an old deployment marker;
its three partial samples were excluded and the whole round reran. All caller
requests reported BOS. No other attempts were excluded.

Times below measure service-binding requests from the caller Worker, including
body consumption. They exclude browser rendering and the public edge dispatcher.
First-observed requests after deployment are **not guaranteed cold starts**.
The paired differences describe these small samples, not statistical guarantees.

## Combined viewer versus full API

All times are milliseconds. A positive paired reduction means the viewer was faster.
The median of paired differences can differ from the difference of arm medians.

| Surface                  | Samples | First API | First viewer | Warm API | Warm viewer | Paired first reduction, median (range) | Faster pairs |
| ------------------------ | ------: | --------: | -----------: | -------: | ----------: | -------------------------------------- | -----------: |
| File metadata            |     144 |     233.5 |          149 |       72 |          77 | 96.5 (38 to 345)                       |          6/6 |
| Gallery, 100 items       |      72 |    2255.5 |         2215 |     1902 |        1881 | -8 (-155 to 196)                       |          2/4 |
| Feed, 50 items           |      48 |    1288.5 |         1054 |     1026 |         945 | 97.5 (-353 to 442)                     |          3/4 |
| Pager + list, 2,000 keys |      48 |    1185.5 |         1026 |    938.5 |       922.5 | 113 (56 to 997)                        |          4/4 |
| File download            |      48 |       523 |          308 |    129.5 |       132.5 | 236.5 (1 to 445)                       |          4/4 |
| Gallery download         |      48 |     745.5 |        288.5 |    187.5 |         194 | 386.5 (103 to 540)                     |          4/4 |

The file sample count includes files-only and files-plus-galleries arms. Gallery
samples include a files-plus-galleries arm. Other scenarios compare two arms.

## Incremental bundle check

| File metadata arm | First median | Warm median | Paired first reduction (range) |
| ----------------- | -----------: | ----------: | ------------------------------ |
| files             |        133.5 |        74.5 | 107 (52 to 369)                |
| galleries         |        150.5 |          77 | 110 (50 to 324)                |
| combined          |          149 |          77 | 96.5 (38 to 345)               |

Adding collection routers retained the observed file benefit. The files-plus-
galleries arm's gallery first median was 2,151 ms, with three of four paired
wins; this does not establish a consistent collection benefit.

Wrangler reported uploaded staging bundles of 8,905.22 KiB for the full API,
1,380.33 KiB for files, 1,393.65 KiB for files plus galleries, and 1,416.75 KiB
for the combined viewer. These include benchmark wrappers. The full API includes
WASM; the viewer does not. Bundle size is neither visitor transfer size nor latency.

## Where the time went

For the combined viewer, warm gallery HEAD hydration had a 1,709.5 ms median
within a 1,793 ms route median. Warm feed HEAD hydration had an 851.5 ms median
within a 903.5 ms route median. The smaller entrypoint does not remove these storage calls. Phase medians are not additive.

Pager detail's first index read/write medians were 98/321.5 ms for the viewer
and 102/301 ms for the API. Warm index reads were 2 ms in both arms. Warm hits
still ran scope validation (12 ms median), metadata, hold, and object checks.
Detail header medians were 727.5/200.5 ms first/warm for the viewer and
828.5/188 ms for the API. The parallel list remained the slower request.

Hashing, DTO construction, and serialization were instrumented but often reported
0 ms at the Workers timer's observable resolution. This does not prove zero CPU cost.
Time outside the route timer includes dispatch and other work; it is not an
isolated measurement of startup.

## Validation boundaries

All arms omitted GitHub credentials equally. Public GitHub title enrichment and
title-cache behavior were not measured. The fixtures used R2 bindings; live BYO
credentials, other providers, posters, and multi-region behavior remain rollout
checks. Downloads were 68 bytes, so they establish parity rather than throughput.
Same-key replacement with different bytes and private counterpart behavior remain
part of the broader activation checklist.

`pnpm types`, `pnpm typecheck`, `pnpm test`, `pnpm check`, and
`pnpm viewer:bundle:check` passed. The suite passed 7,387 tests with two skipped.
The isolated caller harness also passed five tests and its TypeScript check.
Production web routing remains off. The bundle guard verifies that the edge
rollout stays off and has no routes or viewer binding.

Raw samples, build/version records, phase summaries, and deployment logs remain
in `.context/issue-1170/benchmark/` in this worktree. The ignored harness sources
live in `apps/api/.context/viewer-benchmark/`. Do not publish its secret file.
See [the viewer runbook](public-viewer.md) for deployment and rollback controls.

## Download routing checks

An isolated hostname tested the same file and gallery download paths through
the edge dispatcher. All 26 requests passed, including propagation polls.
`off` used the full API; `files` moved only file downloads; `all` moved both.
Successful downloads retained attachment, no-store, nosniff, and sandbox headers.
HEAD returned no body. Private and held files returned 401; their gallery
counterparts returned 404. Missing objects and revoked gallery links returned 404.
Restoring the fixture restored successful downloads.

The fallback check waited until the diagnostic prefix showed the empty active
lane. The gallery download still succeeded from the original fallback lane.
Diagnostic reads were added only after timing collection and are excluded from
all latency samples. Unit tests also cover active-private masking, per-lane public
URLs, pass-through Range headers, and no retry after viewer errors.

## Cleanup and production boundary

Cleanup confirmed zero fixture objects and zero gallery, feed, and metadata rows.
All seven temporary Workers and the dedicated KV namespace were deleted.
The staging hostname and route were removed. Zone routes and Worker custom domains
matched the pre-run snapshot after cleanup.

Production API and web deployment IDs changed during the run through separate
deployments; this task deployed only the named staging Workers. Therefore the
snapshots do not establish unchanged production application versions. They do
establish unchanged routing. Production viewer activation remains disabled in
this PR. The 30 preview D1 migrations explicitly authorized by the user remain
applied; production D1 was not migrated.
