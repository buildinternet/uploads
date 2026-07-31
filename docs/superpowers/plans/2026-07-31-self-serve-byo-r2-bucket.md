# Self-serve BYO R2 bucket — orchestration plan

> **For agentic workers:** this is an orchestration-level plan. Each phase is
> scoped to be handed to a fresh subagent (or an external-CLI rescue lane) as an
> independent brief; the per-task detail below is the brief. Use
> superpowers:subagent-driven-development to execute, one task per agent, with
> review between tasks. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a workspace admin can point their workspace at their own R2 bucket —
paste credentials in the web settings UI, have them verified end-to-end
(auth, bucket access, public DNS), stored encrypted, and used for all
subsequent I/O — without an operator or a deploy.

**Architecture:** productize the existing operator-only BYO path. The storage
seam (`storage()` → `createStorage()` → files-sdk), the workspace-record fields
(`provider/bucket/binding/prefix/publicBaseUrl/accountId/accessKeyId/secretAccessKey`),
and at-rest credential encryption (`secrets.ts`, AES-GCM `enc:v1:` + KEK ring)
already exist. What's new: a member-gated write path for storage config, a
verification pipeline (credential probe + public-URL/DNS probe), the settings
UI, and guards on the platform jobs that assume a platform-owned bucket.

**Tech stack:** Cloudflare Workers (Hono), R2 via files-sdk 2.1.0 (patched),
KV workspace registry, Astro + vanilla-JS settings pages, Better Auth sessions
over the `AUTH` service binding.

## Global constraints

- v1 is **R2-only, HTTP-credential-mode only**. No per-customer wrangler
  bindings: bindings require a config edit + deploy per customer, which is the
  unsustainable part of the `buildinternet` prototype. Cross-account R2 over
  `https://<accountId>.r2.cloudflarestorage.com` with a bucket-scoped key pair
  already works with zero deploys — that is the only mechanism v1 uses.
  (`binding` stays supported for platform/internal workspaces; the self-serve
  path never writes it.)
- **BYO is declared at workspace creation in v1** (decided 2026-07-31): the
  create flow (`/account/workspaces/new` + `POST /v1/workspaces`) is where a
  user says they're bringing their own bucket, and the wizard runs there.
  Settings can still attach a bucket to an _empty_ existing workspace (same
  endpoints), and always handles rotate/re-verify/disconnect. No migration of
  populated workspaces (keys lose the shared-bucket prefix and every published
  URL would break); live migration and richer mappings (bucket → repo, etc.)
  are explicitly future versions.
- **Feature flag, off by default** (decided 2026-07-31): gate the whole
  surface behind a per-workspace record flag `byoBucketEnabled` (precedent:
  `videoPosterEnabled` + its fail-closed gate). Default off for everyone;
  when the feature is ready, enable it on the `buildinternet` and `default`
  workspaces first. Plan/billing gating is a later, separate decision — the
  flag is the short-term gate, and Task 1.3's plan-capability mechanism ships
  dark underneath it.
- **Secrets are write-only through the API.** Responses carry presence booleans
  and at most the last 4 characters of the access key id — never values
  (precedent: `GET /admin/workspaces/:name` projection in
  `apps/api/src/routes/admin.ts:515`).
- **Never store plaintext credentials.** `sealCredentialFields(undefined, …)`
  currently falls through to plaintext; the self-serve save path must hard-fail
  (500 `secrets_key_unconfigured`) when `WORKSPACE_SECRETS_KEY` is unset.
- All record writes go through `mutateWorkspaceRecord`
  (`apps/api/src/workspace-mutate.ts`) — never bare `REGISTRY.put`. Seal
  credentials _inside_ the mutation callback (precedent:
  `apps/api/src/reencrypt-registry.ts:91`).
- Endpoint construction is **derived, never customer-supplied**: the S3
  endpoint is always `https://<accountId>.r2.cloudflarestorage.com` with
  `accountId` validated as `^[0-9a-f]{32}$`. No free-form endpoint field in v1
  (kills the SSRF surface).
- `apps/api` and `apps/mcp` resolve storage through the same module
  (`apps/mcp/src/tools.ts:78` imports from `@uploads/api/storage`); every new
  config field, error type, and env var lands for both workers.
- Keep the repo's writing conventions: docs per `AGENTS.md` "Writing docs"
  (softened STE100), changeset only for CLI-visible changes, no sensational
  language in PRs.

---

## What exists today (verified 2026-07-31)

| Piece                                    | Where                                                                                                                                                                                       | Status                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Record fields for BYO                    | `apps/api/src/workspace.ts` (`WorkspaceRecord`: `provider`, `bucket`, `binding`, `prefix`, `publicBaseUrl`, `accountId`, `accessKeyId`, `secretAccessKey`)                                  | shipped                         |
| Credential encryption at rest            | `apps/api/src/secrets.ts` (AES-GCM-256, `enc:v1:`, KEK ring `WORKSPACE_SECRETS_KEY`/`_PREVIOUS`, rotation sweep `apps/api/src/reencrypt-registry.ts` + `POST /admin/credentials/reencrypt`) | shipped                         |
| Cross-account HTTP I/O                   | files-sdk r2 adapter `r2FromHttp`; selected by `createStorage()` when the config has creds and no binding (`packages/storage/src/index.ts`)                                                 | shipped                         |
| Single resolve seam                      | `apps/api/src/storage.ts` — `storageConfig(env, ws)` decrypts and resolves; `storage(env, ws)` returns a `Files`                                                                            | shipped                         |
| Prefix confinement + BYO-mode semantics  | `packages/storage/test/prefix-confinement.test.ts` (includes "unprefixed instance sees the whole bucket")                                                                                   | shipped                         |
| Operator provisioning                    | `apps/api/scripts/add-workspace.mjs` (`--bucket --account-id --access-key-id --secret-access-key --public-base-url`)                                                                        | shipped, operator-only          |
| Reference deployment                     | `buildinternet` workspace on `buildinternet-dev` — **binding-mode prototype; treat as a learning artifact, not the pattern** (per Zach)                                                     | shipped                         |
| Self-serve write path for storage config | —                                                                                                                                                                                           | **missing (core of this plan)** |
| Credential/bucket verification           | — (bad creds today = 500 at next upload)                                                                                                                                                    | **missing**                     |
| Public-URL/DNS verification              | —                                                                                                                                                                                           | **missing**                     |
| Settings UI for storage                  | — (admin panel is read-only presence booleans)                                                                                                                                              | **missing**                     |

## The customer-side setup (what the UI must walk them through)

The wizard documents these steps and verifies each one server-side:

1. **Create an R2 bucket** in their Cloudflare account (any name, any
   jurisdiction — record the jurisdiction caveat: v1 supports the default
   endpoint only; `eu`/`fedramp` jurisdiction endpoints are a fast-follow flag).
2. **Create a bucket-scoped R2 API token**: Cloudflare dashboard → R2 → Manage
   API Tokens → "Object Read & Write", scoped to that one bucket. This yields
   the Access Key ID / Secret Access Key pair plus their account id. The UI
   copy insists on bucket-scoped (not account-wide) tokens so our blast radius
   if the KEK is ever compromised is one bucket, not their account.
3. **Public access for serving** — one of:
   - **Custom domain** (recommended): connect a domain to the bucket
     (R2 → bucket → Settings → Public access → Custom domains). Requires the
     domain to be on a Cloudflare zone in their account; Cloudflare provisions
     the DNS record + cert. They paste the resulting
     `https://media.example.com` as the public base URL.
   - **`r2.dev` managed URL**: **not supported in v1** (decided 2026-07-31).
     The verify pipeline rejects `*.r2.dev` public base URLs with a dedicated
     check + copy along the lines of "r2.dev URLs aren't supported right now —
     connect a custom domain, or save without a public URL for signed-only
     access." Revisit later.
   - **No public access**: allowed but degraded — uploads work, and file access
     falls back to signed URLs (the `/me/workspaces/:name/file-url` resolver
     already degrades public → signed → typed error). GitHub embeds won't work
     without a public base URL; the UI must say so plainly.

## Verification pipeline (server-side, the heart of the feature)

`POST /me/workspaces/:name/storage/verify` — runs against _candidate_ config
(request body), not saved state, so users can iterate before anything is
persisted. Response modeled on `GithubHealthResult`
(`apps/api/src/routes/github-health.ts`): `configured` vs `ok`, required vs
recommended checks, per-check `hint` naming the exact remediation.

Required checks, in order, short-circuiting:

1. **Shape**: `accountId` matches `^[0-9a-f]{32}$`; bucket name matches R2
   rules (3–63 chars, `^[a-z0-9][a-z0-9-]*[a-z0-9]$`); key pair non-empty.
2. **Auth + bucket reachability**: `head`/`list` (limit 1) against the derived
   endpoint. Distinguish DNS/network failure vs 401/403 (bad or mis-scoped
   token) vs 404 (bucket name typo) in the hint.
3. **Write/read/delete round-trip**: put a probe object under
   `_internal/uploads-verify/<random>` with a random body, `get` it back,
   compare bytes, delete it. Proves the token is Object Read & **Write** and
   the bucket is actually writable.
4. **Empty-bucket / takeover guard**: `list` must show zero non-probe objects
   when attaching a bucket for the first time **unless** the user explicitly
   confirms an "adopt existing contents" checkbox (recorded in the request).
   This both enforces the empty-workspace constraint and prevents pointing a
   workspace at a bucket whose contents the token holder didn't intend to
   expose.

Recommended checks (never flip `ok`):

5. **Public base URL probe** (only when a `publicBaseUrl` was supplied): the
   URL must be `https:`, a syntactically valid host, not resolve to the
   platform's own hosts (`storage.uploads.sh`, `embed.uploads.sh`, any
   `*.uploads.sh`), and **not be a `*.r2.dev` host** (rejected with the
   "not supported right now" copy above — this one is a _required_ failure,
   not a warning). Then fetch `<publicBaseUrl>/<probe-key>` while the probe
   object from step 3 still exists and require the same bytes back. This
   proves DNS + custom-domain wiring end-to-end in one shot. Timeout ~5s;
   failure hint distinguishes NXDOMAIN/timeout ("domain not connected to the
   bucket yet — DNS can take a few minutes") from 401/404 ("domain is
   connected to a different bucket or public access is disabled").
6. **Cache behavior note**: HEAD the probe URL and report whether the platform
   `Cache-Control: public, max-age=60` came back, so overwrite-freshness
   behavior is known (see `uploads-edge-cache-freshness` history).
7. **Embed twin**: report `embed: unsupported` for BYO hosts (the
   `DEFAULT_EMBEDDABLE_HOSTS` allowlist in `packages/storage/src/index.ts`
   doesn't extend to them) with a doc link. Camo-revalidation for BYO domains
   is a deferred fast-follow, not silently broken.

Abuse controls: verify is rate-limited per user (reuse `allowWrite` /
dedicated limiter, ~5/min), probes carry a per-request random key so
concurrent verifies can't collide, and the endpoint never echoes the secret
back in any error path. Probe fetches must never follow redirects to
non-https and must cap response size read (compare via hash of first N KB).

---

## Phase 0 — hardening prerequisites (independent, parallelizable)

Small, self-contained tasks; each is one subagent brief and one PR (or one
stacked series). All are safe to land before any UI exists.

### Task 0.1: teardown/retention guard for unprefixed buckets

- **Files:** `apps/api/src/workspace-teardown.ts`, `apps/api/src/retention.ts`,
  `apps/api/src/reconcile.ts` + colocated tests.
- `teardownWorkspace` on a record with no `prefix` and customer creds must
  **not** walk-and-delete the bucket. Policy: BYO teardown deletes platform
  state (KV record, D1 rows, galleries) and _leaves the customer's objects in
  their bucket_, reporting `objectsSkipped: "byo-bucket"` in the teardown
  summary. Add an explicit operator-only `--purge-objects` escape hatch for
  platform-owned dedicated buckets. Retention/reconcile: skip or
  page-limit full-bucket `listAll()` walks on BYO records (their storage,
  their lifecycle rules; document that `retentionDays` is unsupported on BYO
  in v1).

### Task 0.2: typed errors out of the storage seam

- **Files:** `apps/api/src/storage.ts` (+ its error surface in
  `apps/api/src/errors.ts` or equivalent), tests.
- `storageConfig` throwing on an unknown binding or failed decrypt currently
  becomes a 500. Map to typed errors (`storage_misconfigured`,
  `storage_credentials_unreadable`) that routes translate to 4xx/503 with a
  hint pointing at the settings page. Also: `sealCredentialFields` gets a
  strict variant (`sealCredentialFieldsStrict`) that throws
  `secrets_key_unconfigured` when the KEK is missing — used by every
  self-serve write path.

### Task 0.3: single sealing implementation

- **Files:** `apps/api/scripts/add-workspace.mjs`,
  `apps/api/src/secrets.ts`, tests.
- The `enc:v1:` format exists twice (`secrets.ts` WebCrypto +
  `add-workspace.mjs:39` Node crypto). Make the script import the WebCrypto
  implementation (Node ≥20 has `globalThis.crypto`) and delete the duplicate.

### Task 0.4: pin platform-owned writes

- **Files:** `apps/api/src/routes/reports.ts:102`.
- The abuse-report attachment writes to `c.env.UPLOADS_DEFAULT` directly and
  correctly so — add the comment that this is deliberate platform storage,
  never workspace-routed, so nobody "fixes" it into a customer bucket.

## Phase 1 — API surface (after Phase 0; blocks Phase 2)

### Task 1.1: storage config read/verify/write routes

- **Files:** new `apps/api/src/routes/workspace-storage.ts` (or a section in
  `apps/api/src/routes/me.ts` following the comment-settings triple), new
  `apps/api/src/storage-verify.ts` (probe pipeline, pure + injectable S3
  client for tests), `apps/api/src/workspace.ts` (new fields, below),
  `apps/api/src/env.d.ts` + `apps/mcp/src/env.d.ts`, tests beside each.
- **Routes** (all `sessionAuth` + `requireSessionUser` +
  `adminWorkspaceOr403`, writes behind `allowWrite`):
  - `GET /me/workspaces/:name/storage` → `{ mode: "shared" | "byo",
bucket?, accountIdMasked?, accessKeyIdLast4?, publicBaseUrl?,
verifiedAt?, verify?: <last verify summary> }`. Never values.
  - `POST /me/workspaces/:name/storage/verify` → runs the pipeline above on
    the request body; persists nothing.
  - `PUT /me/workspaces/:name/storage` → requires a passing _required_ check
    set within the same request (re-runs the pipeline server-side; never
    trusts a client-side "verified" claim), then
    `mutateWorkspaceRecord` with: `bucket`, `accountId`,
    sealed creds (strict), `publicBaseUrl?`, `prefix` removed, and
    guard-in-callback that the workspace still has zero objects/usage unless
    `adoptExistingContents` was set. Stamps `storageConfiguredAt`,
    `storageVerifiedAt`, `storageConfiguredBy: userId`.
  - `DELETE /me/workspaces/:name/storage` → detach: only valid when the
    workspace is empty (or force-flagged); restores shared-bucket defaults
    from `self-serve-defaults.ts`. Never deletes customer objects.
- **Record additions** (`WorkspaceRecord`): `storageConfiguredAt?`,
  `storageVerifiedAt?`, `storageConfiguredBy?` — provenance + the settings
  UI's "verified ✓ 3 days ago" line. No new secret fields.
- **Audit**: log configure/verify/detach events (structured log line at
  minimum; reuse the pattern behind `credential_decrypted_with_previous_key`).

### Task 1.2: budget/metering policy for BYO

- **Files:** `apps/api/src/budget.ts`, `packages/billing/src/resolve.ts` (or a
  pure predicate beside `workspace-cap.ts`), `apps/api/src/usage.ts` docs,
  tests.
- Policy: on BYO records, `maxStorageBytes` is **not enforced** (their disk),
  but usage is still _recorded_ (D1 ledger powers the UI and any future
  gateway pricing). `maxUploadBytes` / `maxVideoUploadBytes` /
  `maxUploadsPerPeriod` stay enforced (they protect platform compute, not
  storage). Implement as a pure `storageBudgetApplies(record)` predicate so
  enforcement and display read the same seam.

### Task 1.3: feature flag + plan gating hook

- **Files:** `apps/api/src/workspace.ts` (`byoBucketEnabled?: boolean` on the
  record), gate enforced in Task 1.1's routes (verify + PUT + the create-flow
  branch), surfaced in the GET response so the UI can hide the panel;
  `packages/billing/src/plans.ts` capability flag `byoBucket` on
  `PlanDefinition` as the dark-shipped future gate; pure predicate module
  beside `workspace-cap.ts`; tests.
- **Short-term gate is the record flag, off by default, fail-closed**
  (precedent: `videoPosterEnabled`). Only an operator can set it
  (admin-ui limits/plan PATCH pattern). At enable-time: turn it on for
  `buildinternet` and `default`. The plan-capability predicate lands with
  `byoBucket: true` on all plans so a future billing decision is a one-line
  flip underneath the record flag. Follow the `marketsMemberCap` precedent —
  callers read the predicate, never a plan-id switch.

## Phase 2 — web settings UI (after Phase 1)

### Task 2.1: create-flow BYO path + Storage panel on workspace settings

- **Files:** `apps/web/src/pages/account/workspaces/new.astro` (create form
  gains a "bring your own bucket" option, visible only when the flag allows),
  `apps/web/src/pages/account/workspaces/[name]/settings.astro` (new
  section), `apps/web/src/lib/api-client.ts` (client fns mirroring the
  comment-settings pair), tests per the api-client test pattern.
- **Creation is the primary entry** (v1 decision): choosing BYO on the create
  form creates the workspace (shared-bucket record, normal path), then drops
  the user directly into the storage wizard for that workspace before any
  files exist. Creation itself stays one unchanged transaction — BYO is
  attach-immediately-after, so a wizard abandoned halfway leaves a normal
  empty shared workspace, not a broken one.
- Follow the settings-tab conventions exactly: section starts `hidden`,
  revealed in `onSession`, non-`ok` GET leaves it hidden for non-admins,
  `requireElement`, `isCurrentPageVisit` guard, sequence token, 400 messages
  surfaced verbatim.
- States: **shared mode** (default) shows "Your files live on
  storage.uploads.sh" + "Connect your own bucket" CTA (disabled with an
  explanatory note when the workspace has files — links the empty-workspace
  constraint); **byo mode** shows bucket name, masked ids, public base URL,
  `verifiedAt`, a "Re-run verification" button, "Rotate credentials" (same
  form, keys only), and "Disconnect".
- The connect flow is a 3-step wizard in one panel: (1) instructions with
  copy-paste dashboard paths for bucket + scoped token + custom domain,
  (2) the form (account id, bucket, key id, secret — `type=password`,
  `autocomplete=off` — public base URL optional), (3) live verify results
  rendered as a checklist from the verify response (each check row: label,
  pass/fail/warn, hint verbatim). Save is enabled only after required checks
  pass; the recommended public-URL check failing shows the degraded-serving
  warning but doesn't block.
- Secret handling in the browser: never store in localStorage or URL; keep in
  form state only; on save success, clear the fields.

### Task 2.2: everywhere the URL story surfaces

- **Files:** `apps/web/src/pages/f/[workspace]/[...key].astro` (no change
  expected — verify), workspace file table / account browser components that
  compose public URLs, `docs/` (Task 3.2 owns prose).
- Sweep for any place that assumes `storage.uploads.sh` or re-derives URLs
  instead of using server-supplied `pageUrl`/`publicUrl` fields (memory:
  clients must read server-supplied URLs; verify that holds and fix stragglers).

## Phase 3 — CLI, docs, and operator visibility (parallel with Phase 2)

### Task 3.1: doctor + CLI awareness

- **Files:** `packages/uploads/src/commands.ts` (`buildDoctorReport` gains a
  `storage` sub-check calling the GET route; surfaces mode + verifiedAt +
  degraded-serving warning), changeset (CLI-visible).
- `uploads doctor` on a BYO workspace whose verify is stale/failing prints the
  same hints as the web checklist.

### Task 3.2: docs

- **Files:** `docs/workspaces.md` (rewrite the Bring-your-own-bucket section
  as the self-serve flow; keep the operator script documented for internal
  buckets), new `docs/byo-bucket.md` subject page wired into DocsLayout +
  `sitemap.xml` + `llms.txt` (docs-structure rule), `README.md` path table if
  a new doc lands, `VISION.md` untouched (already promises this).
- Content: the three customer-side steps, the token-scoping insistence, the
  serving matrix (custom domain / signed-only; r2.dev explicitly called out
  as not supported right now), what's degraded
  (embed twin, retentionDays), data ownership + off-boarding ("disconnecting
  never touches your objects").

### Task 3.3: admin/operator panel read-out

- **Files:** `apps/api/src/routes/admin-ui.ts`, `apps/web/src/pages/admin/…`
  workspace view.
- Operator view shows storage mode, verify status, and configure/rotate
  provenance; keeps the existing "presence booleans only" projection. Admin
  metrics: count of BYO workspaces (adoption metric, `/admin/metrics`).

## Phase 4 — follow-ups (file as issues at ship time, don't build now)

- **Embed twin for BYO hosts** — per-workspace `embedBaseUrl` + customer-side
  Transform Rule recipe, or platform-proxied embed host. Needed before BYO
  users get in-place-overwrite Camo behavior.
- **Jurisdiction endpoints** (`eu`, `fedramp`) — one endpoint-template flag.
- **Live migration shared → BYO** — copy job + dual-read window + URL rewrite
  policy. The empty-workspace constraint is v1's substitute.
- **Other S3 providers** — `StorageProvider` union is deliberately `"r2"`;
  files-sdk already carries adapters. Opens the VISION "more storage
  providers" door; separate plan.
- **Per-workspace DEKs** — today all records seal under one KEK
  (SHA-256(secret) → AES key). Fine at current scale; envelope-per-workspace
  is the upgrade if BYO adoption grows. Rotation machinery already exists.
- **Billing framing** — "bring your own storage, pay for the workflow layer"
  (VISION language). Gating mechanism ships dark in Task 1.3.

---

## Track B — data layer: D1 → Postgres (PlanetScale) evaluation

**Decision: decoupled from Track A, and deferred behind explicit triggers.**
Nothing in the BYO feature needs Postgres — Track A's only new state is two
timestamps + provenance on the KV workspace record; the usage ledger and
metadata tables are untouched. Coupling the two tracks would put a
multi-week platform migration on the critical path of a feature that is
~80% built.

### What the offering actually is (researched 2026-07-31)

"$5/month through Cloudflare" = PlanetScale Postgres **PS-5**: a
**single-node, non-HA** instance (1/16 vCPU, 512 MB RAM, 10 GB storage per
branch), provisioned from the Cloudflare dashboard and billed on the
Cloudflare invoice at PlanetScale's standard price — a billing/provisioning
integration, not a discounted SKU. A production-grade 3-node HA cluster is
**$15/mo** minimum; dev branches are $5 each. Workers connect through
**Hyperdrive** + `pg`/Postgres.js over TCP (free tier: 100k queries/day,
~20 origin connections; paid: unlimited queries, ~100 connections). Latency
is D1-comparable only when Hyperdrive's pool, the database region, and
Smart Placement are aligned; misaligned it's 20–30 ms/query. Hyperdrive is
transaction-mode pooling: no LISTEN/NOTIFY, no session state, ~60 s query
kill (migrations/backfills must bypass the pool). Better Auth on Postgres
via Drizzle/Kysely over Hyperdrive is a documented, known-good pattern.

### The real migration surface (measured)

Two independent D1 databases:

| DB                               | Consumers                                                                              | Access style                                                                                                                            | Port cost                                                                                                                                                                                 |
| -------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `uploads-auth` (19 tables)       | apps/auth only                                                                         | Drizzle ORM (`drizzle-orm/d1` → Better Auth adapter), zero raw SQL                                                                      | **Low** — swap dialect (`sqliteTable` → `pgTable` in `apps/auth/src/schema.ts`), driver, and Hyperdrive binding                                                                           |
| `uploads-production` (15 tables) | apps/api + apps/mcp (shared binding; mcp reuses api's query helpers, no duplicate SQL) | Raw `env.DB.prepare()` — ~90 call sites concentrated in ~13 domain modules (`galleries.ts` 25, `usage.ts` 13, `file-metadata.ts` 11, …) | **Moderate** — mechanical but wide: `db.batch()` (15 sites across 6 files) → real transactions, `INSERT OR IGNORE`/`ON CONFLICT` → Postgres upserts, `strftime` defaults, one `json_each` |

The **largest hidden cost is the test harness**: ~25 apps/api suites +
~15 apps/auth suites execute the repo's actual migration SQL against
`node:sqlite` (`apps/api/test/helpers/sqlite-d1.ts`,
`apps/auth/src/test/fake-d1.ts`) and assert on real SQLite semantics. A
Postgres move means porting that harness (embedded Postgres, pglite, or
containers) or migrating suites to the hand-rolled map fakes — likely more
work than the production SQL translation itself. Also of note: **no** D1
Sessions API, read replication, or FTS is in use, so the hardest-to-port
D1 surfaces are absent; and D1 migrations auto-apply via two path-triggered
CI workflows that would need Postgres equivalents (PlanetScale
deploy-request flow, which is also the biggest thing we'd _gain_).

### What would actually be gained / lost

- **Gain:** no 10 GB/db hard ceiling (D1's cap, not raisable); PlanetScale
  branching + safe-migration deploy requests (lint, ghost tables,
  revertability); PITR; read replicas; a real console.
- **Lose:** zero-config colocation (D1 binding is effectively free latency),
  Time Travel included, no pooling layer to operate, no second bill.
  Cost trajectory: $5 (non-HA, fine for staging) → $15 HA → $39+ next size,
  plus Hyperdrive paid tier once past 100k queries/day.

### Triggers to revisit (any one of these reopens the decision)

1. `file_metadata` / `daily_metrics` growth trending toward the 10 GB
   database cap (check quarterly via `/admin/metrics` + `wrangler d1 info`).
2. A schema change scary enough that the lack of a safe-migration/branching
   workflow materially slows shipping.
3. Needing relational features D1 can't express (cross-table constraints in
   one transaction beyond `batch()`, replicas for read scaling).
4. Multi-region latency complaints traceable to D1 single-primary placement.

### If/when triggered: migration shape (not scheduled)

1. Pilot on `uploads-auth` first — the Drizzle layer makes it a
   dialect+driver swap with Better Auth's Kysely/Drizzle Postgres support,
   and it's single-consumer. Run PS-5 non-HA for staging, HA for prod.
2. Then `uploads-production`: introduce nothing new architecturally — the
   ~13 domain modules stay the seam; translate SQL in place, replace
   `batch()` with transactions, port the sqlite test harness once and reuse.
3. Both workers (`apps/api`, `apps/mcp`) get the same Hyperdrive binding;
   align the PlanetScale region with where D1 is placed today and enable
   Smart Placement before measuring.

## Decisions (resolved 2026-07-31 unless noted)

1. **Plan gating**: still open long-term; short-term the gate is the
   `byoBucketEnabled` record flag, off by default, enabled for
   `buildinternet` + `default` at rollout (Task 1.3).
2. **Adopt-existing-contents**: still open; plan builds the confirmation
   path but it can ship disabled (hard-require empty) without rework.
3. **Uploads-per-period on BYO**: **keep enforced** (platform compute).
   Revisit later — decoupling is plausible; the `storageBudgetApplies`
   predicate seam is where that change would go.
4. **r2.dev URLs**: **blocked in v1**, with dedicated "not supported right
   now" copy in the verify checklist and docs.
5. **BYO entry point**: **declared at workspace creation** (create-form
   option → immediate wizard); settings-attach stays for empty workspaces;
   migration of populated workspaces is a future version.

## Orchestration notes

- **PR consolidation (Zach's preference, 2026-07-31): few substantial PRs,
  not a dozen tiny ones.** Target shape:
  - **PR 1** — this plan + all of Phase 0 (tasks 0.1–0.4) as one hardening PR.
  - **PR 2** — Phase 1 (API surface + verify pipeline + flag/budget policy,
    tasks 1.1–1.3).
  - **PR 3** — Phase 2 + Task 3.1/3.3 (UI + CLI doctor + admin read-out).
  - **PR 4** — docs (Task 3.2), or folded into PR 3 if it stays small.
- Phase 0 executes as two parallel lanes with disjoint file sets sharing one
  branch/worktree: Lane A = task 0.1 (lifecycle guards), Lane B = tasks
  0.2 + 0.3 + 0.4 (typed errors, strict seal, sealing consolidation,
  pinned-write comment). Lanes leave changes uncommitted; the orchestrator
  reviews, runs the full suite, and commits.
- Task 1.1 is the critical path and the highest-judgment task — keep it in a
  reviewed lane, not an external CLI. 1.2/1.3 can run parallel to 1.1 once
  the predicate seam is agreed.
- Phase 2 depends on 1.1's response shapes; freeze those in PR 2's
  description so the UI lane can start from the contract before it merges.
- Every phase ends with `pnpm test` (root runner) + targeted vitest projects;
  UI tasks verify against the local stack per the stack-raw recipe
  (127.0.0.1 signed-in session).
- Stacked PRs based on a non-main branch skip Test/Lint entirely — rebase
  onto main before requesting review (memory: stacked-PR CI gotcha).
