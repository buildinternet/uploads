# Randomized Private-Repo Attachment Prefixes (#631) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Private-repo GitHub attachments get stored/served under a randomized ~128-bit per-(owner, repo, branch) URL prefix (`gh/private/<32-hex-id>/…`) so their URLs are unguessable capability URLs, while public repos keep today's derivable keys unchanged.

**Architecture:** A new D1 table maps `(repo_full_name, branch)` → random 32-hex `prefix_id`. The API worker is the only minter: a new resolve endpoint answers "is this repo private, and if so what's the prefix id for this target" (CLI calls it over HTTP; hosted MCP, promotion, webhook, and ingest call the same service function in-process). Repo privacy is learned from the GitHub App (`GET /repos/{repo}` with the installation token, KV-cached, webhook write-through). Filenames and the `kind/num` tail beneath the random prefix stay stable, so `--pr` overwrite, before/after pairing, comment dedupe, and by-path grouping survive untouched. Rotation mints a new id, copies objects (bytes + D1 metadata) to the new prefix, deletes the old objects, and re-syncs the managed comment through the existing machinery. Prospective only: existing attachments stay at their current keys, and comment gathering lists both shapes.

**Tech Stack:** Cloudflare Workers (Hono), D1 (SQLite), KV, R2 via `packages/storage`, TypeScript strict/ESM, vitest (unified root runner `pnpm test`).

## Global Constraints

- Follow repo conventions in AGENTS.md: `AppError` subclasses from `@uploads/errors` (never hand-rolled `c.json({error})`), no floating promises, storage only via `createStorage()`/existing helpers, TypeScript strict, ESM, `lib: ["ES2022"]`.
- D1 migrations: `apps/api/migrations/YYYYMMDDHHMMSS_snake_case.sql`. Merging to main auto-applies them to prod — no manual step, and nothing else must be owed.
- New D1 tables need BOTH test mechanisms: a `*-sqlite.test.ts` suite using `apps/api/test/helpers/sqlite-d1.ts` (real migration SQL) AND a `apps/api/test/helpers/fake-<name>-table.ts` wired into `apps/api/test/usage-fake-d1.ts` (or route/webhook suites touching the new query path fail).
- `apps/mcp` never imports `apps/api` internals directly — only through the export boundary modules (`@uploads/api/github-repo-binding`, `@uploads/api/github-comment-service`). New cross-worker exports go through a boundary module.
- The API worker's comment renderer keeps a deliberate byte-identical private copy of CLI key helpers, held in sync by `test/fixtures/github-comment-golden.json`. Do NOT try to dedupe the copies; extend both and extend the golden fixture.
- User-visible CLI changes need a changeset naming ONLY `"@buildinternet/uploads"` (a changeset naming a private `@uploads/*` package silently poisons npm publishing).
- Verification gate before any "done" claim: `pnpm test`, `pnpm typecheck`, `pnpm check` all green. Run `pnpm types` first if `wrangler.jsonc` changed (it won't in this plan — no new bindings are needed; DB and GITHUB_CACHE already exist).
- Commit after each task with a conventional-commit message.
- Prospective only. No migration of existing objects. Public repos byte-for-byte unchanged behavior.

## Design invariants (read before every task)

- **Key shapes.** Plain (unchanged): `gh/<owner>/<repo>/<pull|issues>/<num>/<filename>` and staged `gh/<owner>/<repo>/branch/<branch>/<filename>`. Private (new): `gh/private/<id>/<pull|issues>/<num>/<filename>` and staged `gh/private/<id>/branch/<filename>` (no branch-name segment — the id is already branch-scoped, and repeating the branch name would leak it to URL holders). Ingested (new, private repos): `gh/private/<id>/ingest/<kind>-<num>/<basename>.<ext>` — must never sit under a prefix `gatherCommentBody` lists, mirroring the existing `ingestKey` invariant.
- **Id.** 16 random bytes from `crypto.getRandomValues`, lowercase hex, 32 chars, regex `^[0-9a-f]{32}$`. Never derived from repo/branch.
- **Branch mapping rule (determinism).** `{repo, branch}` → id of that branch. Target `{repo, kind: "pull", num}` → id of the PR's head branch (server fetches head ref via installation token, KV-cached — the head branch of a PR never changes). Target `{repo, kind: "issues", num}` and ingestion → the repo-level id, stored as `branch = ""`.
- **Ambiguity note.** A real GitHub owner can be named `private` (usernames allow alphanumerics + hyphen), so `gh/private/...` is not a reserved namespace by construction. Parsers must try the strict private shape (32-hex second segment) FIRST; the residual ambiguity (an owner named `private` with a repo named as 32 lowercase hex chars) is accepted and harmless — it grants nothing.
- **Trigger.** Private mode applies only when the server can positively determine the repo is private via the GitHub App. Unknown (no App installation, API failure, unauthorized workspace) → plain keys, today's behavior. Fail-open to plain, never fail the upload.
- **Unchanged surfaces (verify, don't touch).** `isManagedGithubKey` (`startsWith("gh/")`) still matches → strict-overwrite exemption survives. `key-policy` allowlist root is `gh/` → passes; depth of private keys is ≤ 6 segments, under the default cap of 8. Before/after pairing scopes structurally to "everything up to last `/`" → works under opaque prefixes. Screenshots page grouping and `/f/` pages are `path`/`gh.*`-metadata driven → unaffected. Serving is an R2 custom domain with no worker → no change.

## File Structure

- Create: `apps/api/migrations/20260811210000_github_private_prefixes.sql` — the mapping table.
- Create: `apps/api/src/github-private-prefixes.ts` — D1 row ops (get-active / mint / rotate) + id generation.
- Create: `apps/api/test/helpers/fake-private-prefixes-table.ts` + wire into `apps/api/test/usage-fake-d1.ts`.
- Modify: `apps/api/src/github-app.ts` — `repoIsPrivate` (KV-cached `GET /repos/{repo}`) + `prHeadBranch` (KV-cached `GET /repos/{repo}/pulls/{num}`) + `cacheRepoPrivacy` write-through.
- Create: `apps/api/src/github-private-prefix-service.ts` — `resolveGhKeyContext` (the one server-side decision function) + `rotatePrivatePrefix`.
- Modify: `apps/api/src/github-repo-binding.ts` — re-export the service for `apps/mcp`.
- Create: `apps/api/src/routes/github-private-prefix.ts` — `POST /v1/:workspace/github/private-prefix` (resolve) and `POST /v1/:workspace/github/private-prefix/rotate`; mount in the API app.
- Modify: `packages/uploads/src/github.ts` — private key builders + `parseGhPrivateKey`; `parseGhKey` gains private-shape awareness.
- Modify: `apps/api/src/github-comment-render.ts` — private-shape twin helpers (the deliberate copy) + golden fixture.
- Modify: `apps/api/src/github-comment.ts` — `gatherAttachments` also lists active private prefixes for the target repo.
- Modify: `apps/api/src/github-promote.ts` + `github-webhook.ts` — promotion under the branch id; webhook privacy write-through.
- Modify: `apps/api/src/github-ingest.ts` — private ingest keys via the repo-level id.
- Modify: `packages/uploads/src/client.ts` + `commands.ts` + `commands/screenshot.ts` + `mcp/tools.ts` — resolve-before-key-build with graceful degradation; CLI-side gather/staged/list/meta-resync awareness.
- Modify: `apps/mcp/src/tools.ts` — hosted MCP resolves in-process.
- Create: `docs/private-attachments.md` — threat model; link from `docs/README.md`/hub + `llms.txt` + sitemap if docs pages index it (follow the docs-structure convention).
- Create: `.changeset/<name>.md` — `"@buildinternet/uploads": minor`.

---

### Task 1: D1 table + `github-private-prefixes.ts` row ops

**Files:**

- Create: `apps/api/migrations/20260811210000_github_private_prefixes.sql`
- Create: `apps/api/src/github-private-prefixes.ts`
- Create: `apps/api/test/github-private-prefixes-sqlite.test.ts`
- Create: `apps/api/test/helpers/fake-private-prefixes-table.ts`
- Modify: `apps/api/test/usage-fake-d1.ts` (compose the new fake table)

**Interfaces:**

- Consumes: nothing new.
- Produces (later tasks import these from `./github-private-prefixes`):
  - `generatePrefixId(): string` — 16 bytes `crypto.getRandomValues`, lowercase hex, 32 chars.
  - `PRIVATE_PREFIX_ID_RE: RegExp` — `/^[0-9a-f]{32}$/`.
  - `getActivePrefixId(db: D1Database, repo: string, branch: string): Promise<string | null>`
  - `getOrMintPrefixId(db: D1Database, repo: string, branch: string, now?: Date): Promise<string>` — insert-if-absent, race-safe via the partial unique index (on conflict, re-select).
  - `listActivePrefixIds(db: D1Database, repo: string): Promise<string[]>`
  - `retirePrefixId(db: D1Database, repo: string, branch: string, prefixId: string, now?: Date): Promise<void>` — sets `rotated_at`.
  - `repo` is always lowercased `owner/name` on the way in (reuse the `normalizeRepo` idiom from `github-repo-links.ts`); `branch` is lowercased; `""` is the repo-level sentinel.

**Migration SQL:**

```sql
-- Randomized per-branch URL prefixes for private-repo attachments (#631).
-- One active id per (repo, branch); rotated rows are kept as tombstones.
-- branch = '' is the repo-level id (issue attachments, ingestion).
CREATE TABLE github_private_prefixes (
  repo_full_name TEXT NOT NULL,
  branch TEXT NOT NULL,
  prefix_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  rotated_at TEXT,
  PRIMARY KEY (repo_full_name, branch, prefix_id)
);
CREATE UNIQUE INDEX github_private_prefixes_active_idx
  ON github_private_prefixes (repo_full_name, branch)
  WHERE rotated_at IS NULL;
CREATE INDEX github_private_prefixes_repo_idx
  ON github_private_prefixes (repo_full_name);
```

- [ ] **Step 1: Write the failing sqlite test** — `apps/api/test/github-private-prefixes-sqlite.test.ts` using `new SqliteD1([...migration paths...])` like `github-repo-links-sqlite.test.ts`. Cases: mint returns a 32-hex id and is idempotent (second call returns the same id); distinct branches get distinct ids; `""` branch works; `listActivePrefixIds` returns ids across branches and excludes retired ones; `retirePrefixId` then `getOrMintPrefixId` mints a fresh different id; the partial unique index rejects a second active row for the same (repo, branch) (assert the ON CONFLICT re-select path by calling `getOrMintPrefixId` twice and getting one id); `generatePrefixId` matches `PRIVATE_PREFIX_ID_RE` and two calls differ; inputs are lowercased.
- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @uploads/api test github-private-prefixes` → FAIL (module not found).
- [ ] **Step 3: Write migration + module.** `getOrMintPrefixId` = `INSERT ... ON CONFLICT DO NOTHING` (target the partial index by inserting with `rotated_at NULL`; D1/SQLite: use `INSERT OR IGNORE`) then `SELECT prefix_id ... WHERE rotated_at IS NULL`. Use `tryRun/tryFirst/tryAll`-compatible plain `db.prepare(...)` calls matching the house style in `github-repo-links.ts`.
- [ ] **Step 4: Write the fake table** — `fake-private-prefixes-table.ts` following `fake-repo-links-table.ts`'s shape (match normalized SQL prefixes for the module's exact statements), compose into `usage-fake-d1.ts`.
- [ ] **Step 5: Run to verify pass** — `pnpm --filter @uploads/api test` → PASS (whole package, to catch fake-D1 fallthroughs).
- [ ] **Step 6: Commit** — `feat(api): github_private_prefixes table + row ops (#631)`

### Task 2: Repo privacy + PR head-ref knowledge in `github-app.ts`

**Files:**

- Modify: `apps/api/src/github-app.ts`
- Modify/Create tests: extend the existing `github-app` test suite (find it via `apps/api/test/*github-app*`; if none covers fetch helpers, follow the mocked-`fetchImpl` pattern used by `installationForRepo` callers).

**Interfaces:**

- Consumes: existing `installationForRepo`, `installationToken`, `GITHUB_CACHE` KV, `GithubAppConfig`.
- Produces:
  - `repoIsPrivate(env: Env, cfg: GithubAppConfig, installationId: number, repo: string, fetchImpl?: typeof fetch): Promise<boolean | null>` — KV `ghpriv:<repo>` → `"1"|"0"`, TTL 600s; on miss `GET /repos/{repo}` with the installation token, read `.private`; `null` on any failure (degrade like every helper in this file — see its module docblock).
  - `cacheRepoPrivacy(env: Env, repo: string, isPrivate: boolean): Promise<void>` — write-through for webhook payloads (same KV key/TTL).
  - `prHeadBranch(env: Env, cfg: GithubAppConfig, installationId: number, repo: string, num: number, fetchImpl?: typeof fetch): Promise<string | null>` — KV `prhead:<repo>#<num>`, TTL 3600s (a PR's head ref never changes); `GET /repos/{repo}/pulls/{num}` → `.head.ref`, lowercased.
- [ ] **Step 1: Write failing tests** — mock `fetchImpl`: privacy true/false cached round-trip (second call served from KV, fetch called once); API 404/500 → `null` and nothing cached; `cacheRepoPrivacy` makes `repoIsPrivate` answer without fetching; `prHeadBranch` returns lowercased ref and caches.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** following `installationForRepo`'s exact caching idiom (string values in `GITHUB_CACHE`, `expirationTtl`).
- [ ] **Step 4: Run → PASS** (`pnpm --filter @uploads/api test`).
- [ ] **Step 5: Commit** — `feat(api): repo privacy + PR head-ref lookups via the GitHub App (#631)`

### Task 3: Private key builders + parsers (CLI package + API renderer copy)

**Files:**

- Modify: `packages/uploads/src/github.ts`
- Modify: `packages/uploads/test/github.test.ts` (or the existing suite covering `ghKeyPrefix` — locate it)
- Modify: `apps/api/src/github-comment-render.ts` (the deliberate copy)
- Modify: `test/fixtures/github-comment-golden.json` + whatever suite asserts copy-parity (find it by grepping for the fixture name; extend it to cover the private builders)

**Interfaces:**

- Consumes: existing `GhTarget`, `sanitizeKeySegment`.
- Produces (exported from `packages/uploads/src/github.ts`, twinned in `github-comment-render.ts`):
  - `GH_PRIVATE_ROOT = "gh/private/"` (const)
  - `ghPrivateKeyPrefix(prefixId: string, target: GhTarget): string` → `` `gh/private/${prefixId}/${target.kind}/${target.num}/` ``
  - `ghPrivateAttachmentKey(prefixId: string, target: GhTarget, filename: string): string` → prefix + `sanitizeKeySegment(filename)`
  - `ghPrivateBranchKeyPrefix(prefixId: string): string` → `` `gh/private/${prefixId}/branch/` ``
  - `ghPrivateBranchAttachmentKey(prefixId: string, filename: string): string`
  - `parseGhPrivateKey(key: string): { prefixId: string; kind: GhTargetKind; num: number } | undefined` — regex `/^gh\/private\/([0-9a-f]{32})\/(pull|issues)\/([1-9][0-9]*)\/./`. Note: it cannot recover the repo — callers that need the repo read `gh.repo` metadata.
  - `parseGhKey` change: return `undefined` for keys matching the private shape (check `parseGhPrivateKey` first) so nothing misparses `private` as an owner.
  - Each builder throws (or asserts) if `prefixId` fails `/^[0-9a-f]{32}$/` — a malformed id must never silently produce a public-ish key.
- [ ] **Step 1: Failing tests** — exact expected strings for each builder; parse round-trips; `parseGhKey("gh/private/<32hex>/pull/5/x.png")` → `undefined` while `parseGhPrivateKey` parses it; `parseGhKey("gh/private/realrepo/pull/5/x.png")` (non-hex second segment) still parses as owner `private` (the accepted ambiguity, documented in a comment); malformed prefixId throws.
- [ ] **Step 2: Run → FAIL.** `pnpm --filter @buildinternet/uploads test`
- [ ] **Step 3: Implement in `github.ts`**, then mirror byte-identically in `github-comment-render.ts` and extend the golden fixture + parity test.
- [ ] **Step 4: Run → PASS** (`pnpm test` at root — the golden parity suite may live outside either package).
- [ ] **Step 5: Commit** — `feat: private-prefix gh key builders and parsers (#631)`

### Task 4: Resolve service + API routes + export boundary

**Files:**

- Create: `apps/api/src/github-private-prefix-service.ts`
- Create: `apps/api/src/routes/github-private-prefix.ts`; mount in the API Hono app next to the existing `routes/github-comment.ts` mount (find the mount site in `apps/api/src/index.ts` or `app.ts`).
- Modify: `apps/api/src/github-comment-service.ts` — export `checkRepoAuthorization` (rename-free `export`), it's currently module-private.
- Modify: `apps/api/src/github-repo-binding.ts` — re-export `resolveGhKeyContext` for `apps/mcp`.
- Create: `apps/api/test/github-private-prefix-service.test.ts` and a route test following the house route-test pattern (grep `routes/github-comment` tests for the harness: fake env, `UsageFakeD1`, mocked fetch).

**Interfaces:**

- Consumes: Task 1 row ops, Task 2 privacy/head-ref, existing `githubAppConfig`, `installationForRepo`, `checkRepoAuthorization`, `findRepoLinkStrict`.
- Produces:
  - `type GhKeyMode = { mode: "plain" } | { mode: "private"; prefixId: string }`
  - `resolveGhKeyContext(env: Env, workspaceName: string, mintingUserId: string | null, req: { repo: string; branch?: string; target?: { kind: "pull" | "issues"; num: number } }): Promise<GhKeyMode>` — flow: App configured? no → plain. `installationForRepo` → none → plain. `repoIsPrivate` → not `true` → plain. `checkRepoAuthorization` declines → plain (fail-open to today's behavior; the resolve endpoint must never leak ids to unauthorized workspaces, and must never block an upload). Then pick the branch: explicit `branch` wins; else `target.kind === "pull"` → `prHeadBranch` (null → plain); else `""`. Then `getOrMintPrefixId` → `{ mode: "private", prefixId }`.
  - Route `POST /v1/:workspace/github/private-prefix` — body `{ repo: string; branch?: string; target?: { kind: "pull"|"issues"; num: number } }`, workspace bearer auth like the comment route (reuse its middleware chain), responds `{ mode: "plain" }` or `{ mode: "private", prefixId }`. Also returns `activePrefixIds: string[]` (all active ids for the repo) ONLY when the caller passed authorization — the CLI gh-fallback comment gather needs the list. Unauthorized/unknown cases return `{ mode: "plain" }` with no ids (indistinguishable from a public repo — no oracle).
- [ ] **Step 1: Failing service tests** — matrix: no App config → plain; no installation → plain; public → plain; private + authorized + branch → private with stable id across calls; private + pull target → id of mocked head branch (same id as staging that branch); private + issues target → repo-level id (differs from branch id); unauthorized workspace → plain AND no row minted (assert table untouched); privacy lookup failure (`null`) → plain.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement service + route + boundary export.**
- [ ] **Step 4: Route tests** — 200 shapes for plain/private; auth required (401 without bearer); malformed body → 4xx `AppError` envelope.
- [ ] **Step 5: Run → PASS** (`pnpm --filter @uploads/api test`).
- [ ] **Step 6: Commit** — `feat(api): private-prefix resolve service + endpoint (#631)`

### Task 5: Comment gathering under mixed key shapes (server + CLI gh-fallback)

**Files:**

- Modify: `apps/api/src/github-comment.ts` (`gatherAttachments`)
- Modify: `packages/uploads/src/commands.ts` (~line 753, the gh-fallback gather) and the CLI client if it needs the resolve call (`packages/uploads/src/client.ts`)
- Tests: extend the existing `github-comment` gather suite (server) and the CLI fallback-comment suite (grep for tests listing `ghKeyPrefix`).

**Interfaces:**

- Consumes: `listActivePrefixIds` (Task 1), `ghPrivateKeyPrefix` twin (Task 3), resolve endpoint (Task 4, CLI side via a new `client.resolveGhPrefix` — defined here, reused in Task 6/7): `resolveGhPrefix(opts: { repo: string; branch?: string; target?: { kind: "pull"|"issues"; num: number } }): Promise<{ mode: "plain" } | { mode: "private"; prefixId: string; activePrefixIds?: string[] }>` — POSTs the Task 4 endpoint; ANY failure (404 from an older server, network, non-2xx) → `{ mode: "plain" }`, cached per-process per repo+branch+target.
- Produces: `gatherAttachments` lists, in order: the plain `ghKeyPrefix(target)` prefix, then for each id from `listActivePrefixIds(env.DB, target.repo)` the prefix `gh/private/<id>/<kind>/<num>/`. Concatenated before metadata fetch; the rest of the pipeline (COMMENT_META_KEYS, render, before/after pairing) is unchanged. CLI gh-fallback does the same using `activePrefixIds` from `resolveGhPrefix`.
- [ ] **Step 1: Failing server test** — seed fake R2 listing with one object under the plain prefix and one under a private prefix (row seeded in fake D1); assert the rendered body embeds both, ordering stable (plain first), and the empty-state/count logic counts both.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement server side.**
- [ ] **Step 4: Failing CLI test** — fallback gather includes private-prefix objects when the resolve endpoint returns ids; endpoint 404 → plain-only listing (no error).
- [ ] **Step 5: Implement CLI side. Run → PASS** (`pnpm test` root).
- [ ] **Step 6: Commit** — `feat: managed comment gathers plain + private prefixes (#631)`

### Task 6: Promotion, webhook write-through, ingestion

**Files:**

- Modify: `apps/api/src/github-promote.ts` (staged prefix + destination under the id)
- Modify: `apps/api/src/github-webhook.ts` (privacy write-through from `repository.private`; promote path passes branch through as today)
- Modify: `apps/api/src/github-ingest.ts` (private ingest keys)
- Tests: extend `github-promote`, `github-webhook`, `github-ingest` suites.

**Interfaces:**

- Consumes: `resolveGhKeyContext` (Task 4), `cacheRepoPrivacy` (Task 2), builders (Task 3), `getActivePrefixId`/`getOrMintPrefixId` (Task 1).
- Produces:
  - `promoteBranchAttachments`: resolve mode for `(repo, branch)`. Private → staged prefix is `ghPrivateBranchKeyPrefix(id)` twin, destination `gh/private/<id>/pull/<num>/<filename>`; ALSO always sweep the plain staged prefix (`stagedPrefix(owner, name, branch)`) so files staged before this feature (or during a privacy flip) still promote — destination follows the CURRENT mode. Metadata flips (`gh.status` → `promoted` etc.) unchanged.
  - Webhook: extend `PullRequestPayload`/`IssueCommentPayload` picks with `repository: { private?: boolean }`; at the top of event handling, when `private` is a boolean call `cacheRepoPrivacy(env, repo, private)` (fire-and-forget is NOT allowed — await it; no floating promises).
  - `ingestForWebhook`/`reconcileIngestTarget`: resolve repo-level mode once per call; private → `ingestKey` variant `gh/private/<id>/ingest/<kind>-<num>/<basename>.<ext>`; ledger `object_key` stores whatever was written (already does).
- [ ] **Step 1: Failing promote tests** — private repo: staged file under `gh/private/<id>/branch/a.png` promotes to `gh/private/<id>/pull/7/a.png` with metadata flip; plain-staged file promotes into the private destination when mode is private; public repo path byte-identical to before (regression assert on existing fixtures).
- [ ] **Step 2: Failing webhook test** — a pull_request payload with `"private": true` populates the KV privacy cache (assert via `repoIsPrivate` answering without fetch).
- [ ] **Step 3: Failing ingest test** — private repo ingest writes under `gh/private/<id>/ingest/pull-7/<asset>.png` and the comment-gather prefix (`gh/private/<id>/pull/7/`) does NOT match it.
- [ ] **Step 4: Implement all three. Run → PASS** (`pnpm --filter @uploads/api test`).
- [ ] **Step 5: Commit** — `feat(api): promotion, webhook, and ingestion under private prefixes (#631)`

### Task 7: CLI + hosted MCP write paths

**Files:**

- Modify: `packages/uploads/src/commands.ts` (`uploadPreparedImage` ~593, `uploadAttachments` ~1132, `uploadBranchAttachments` ~1168, `resolveStaged` ~1986, `list --pr` ~2847, `resyncCommentAfterMetaSet` ~3060)
- Modify: `packages/uploads/src/commands/screenshot.ts` (~525)
- Modify: `packages/uploads/src/mcp/tools.ts` (~920, ~1116 — local stdio MCP mirrors the CLI)
- Modify: `apps/mcp/src/tools.ts` (`resolveKey` ~717 — hosted MCP calls `resolveGhKeyContext` in-process via `@uploads/api/github-repo-binding`)
- Create: `.changeset/private-attachment-prefixes.md`
- Tests: CLI command suites (fake-server pattern already used for put/attach), hosted MCP suite.

**Interfaces:**

- Consumes: `client.resolveGhPrefix` (Task 5), builders (Task 3), `resolveGhKeyContext` (Task 4, hosted MCP only).
- Produces: every key-build site branches on the resolved mode: plain → existing builder; private → private builder. Read-back sites: `resolveStaged` and `list --pr` list the resolved prefix AND the plain prefix (mixed history), deriving `filename` per-prefix via `key.slice(prefix.length)`; `resyncCommentAfterMetaSet` for a key where `parseGhKey` returns `undefined` but `parseGhPrivateKey` matches → recover the repo from the key's `gh.repo` metadata (the command just wrote/read metadata on that key — fetch via the existing metadata client call) and resync with that target. Degradation rule everywhere: resolve failure → plain (never block an upload; print nothing — this is not an error).
- [ ] **Step 1: Failing CLI tests** — fake server advertises private mode: `put --pr` writes the private key and the printed URL contains `/gh/private/<id>/`; bare `put` on a feature branch stages under `gh/private/<id>/branch/<file>`; `--state` naming untouched; fake server without the endpoint (404) → exact pre-#631 keys (regression: assert byte-identical key to the old expectation); `staged`/`list --pr` see files under both shapes; meta-set resync works on a private key.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement CLI + stdio MCP.** One resolve call per command invocation, cached; thread the mode through rather than re-resolving per file.
- [ ] **Step 4: Failing hosted MCP test** — `put` with `--pr`-equivalent args on a private repo mints via D1 directly and returns the private embed URL; public repo unchanged.
- [ ] **Step 5: Implement hosted MCP. Run root `pnpm test` → PASS.**
- [ ] **Step 6: Write the changeset** — `"@buildinternet/uploads": minor` — "Private GitHub repos get randomized, unguessable attachment URL prefixes (#631). Public repos are unchanged. Requires no flags; applies automatically when the uploads GitHub App can see the repo is private."
- [ ] **Step 7: Commit** — `feat(cli,mcp): mint private prefixes on upload paths (#631)`

### Task 8: Rotation

**Files:**

- Modify: `apps/api/src/github-private-prefix-service.ts` (add `rotatePrivatePrefix`)
- Modify: `apps/api/src/routes/github-private-prefix.ts` (add `/rotate`)
- Modify: `packages/uploads/src/commands.ts` + CLI registration (new `uploads github rotate-prefix [--branch <b>|--repo-level]` subcommand next to `github doctor`)
- Tests: service + route + CLI suites.

**Interfaces:**

- Consumes: Tasks 1–5 (`retirePrefixId`, `getOrMintPrefixId`, storage list/copy/delete via the same helpers `github-promote.ts` uses, `postManagedComment` with `resync: true`, ingest ledger).
- Produces: `rotatePrivatePrefix(env, ws, workspaceName, mintingUserId, repo, branch): Promise<{ rotated: false; reason: string } | { rotated: true; prefixId: string; moved: number }>` — flow: authorization identical to resolve but here a decline is an ERROR (rotation is explicit; return the reason, route maps to 403); no active id → `{ rotated: false, reason: "no_prefix" }`; else mint new id first, then for every object under `gh/private/<old>/`: copy bytes + R2 custom metadata to the same tail under the new id (mirror `github-promote.ts`'s copy idiom), `UPDATE file_metadata SET object_key = <new> WHERE workspace = ? AND object_key = <old>`, `UPDATE github_ingested_assets SET object_key = <new> WHERE object_key = <old>`, delete the old object; then `retirePrefixId(old)`; finally re-sync the managed comment(s): for each distinct `(kind, num)` seen among moved keys (via `parseGhPrivateKey` on the tails), call `postManagedComment(..., { resync: true })`. Old URLs now 404 at origin ("dies at the CDN"); embeds in the comment point at the new prefix.
  - Note rotation moves EVERYTHING under the old id — `branch/`, `pull/`, `issues/`, `ingest/` tails alike.
- [ ] **Step 1: Failing service test** — seed two objects (one `pull/7/a.png` with metadata rows, one `branch/b.png`) under an old id + an ingested asset; rotate; assert: new id ≠ old, objects exist at new tails, old keys deleted, `file_metadata` and ledger rows point at new keys, old row retired, comment resync invoked once for `pull#7` with a body embedding the new prefix.
- [ ] **Step 2: Run → FAIL.** **Step 3: Implement.** **Step 4: Route test** (403 when unauthorized, 200 shape). **Step 5: CLI test** — `uploads github rotate-prefix --branch feature-x` prints moved count and new-prefix confirmation; degrade message when server lacks the endpoint. **Step 6: Run root `pnpm test` → PASS.**
- [ ] **Step 7: Commit** — `feat: private-prefix rotation with object move + comment re-sync (#631)`

### Task 9: Docs + threat model + skills sync

**Files:**

- Create: `docs/private-attachments.md`
- Modify: docs hub/index per the docs-structure convention (adding a docs page also means updating `sitemap.xml` + `llms.txt` if this page ships on the website — check whether `docs/*.md` here are repo docs or web pages; repo-only docs skip sitemap).
- Modify: `skills/uploads-cli/SKILL.md` + `skills/github-screenshots/SKILL.md` (one short paragraph each: private repos get `gh/private/<id>/…` URLs automatically; rotation command exists).
- Modify: `docs/ops.md` if it lists key layouts.

**Content requirements (acceptance criterion 4, write in the AGENTS.md softened-STE100 style):** what the randomized prefix is; the Camo design rule (durable unguessable URL, no auth gate — signed URLs break Camo re-fetches); who can discover URLs (repo members via the PR/issue surfaces); the forwarded-URL caveat stated plainly ("possession of a URL grants read — a forwarded link, an ex-collaborator's history, a server log — until the branch's id is rotated"); rotation semantics (old URLs die, comment re-syncs to new ones, Camo caches expire on their own); prospective-only compatibility; explicit statement that this is the capability-URL class, not access control.

- [ ] **Step 1: Write the doc + skill paragraphs.**
- [ ] **Step 2: `pnpm check` (format gate) → PASS.**
- [ ] **Step 3: Commit** — `docs: private-attachment threat model and rotation (#631)`

### Task 10: Final verification sweep

- [ ] `pnpm test` (root, whole suite) → PASS, zero skips introduced.
- [ ] `pnpm typecheck` → PASS.
- [ ] `pnpm check` → PASS.
- [ ] Grep sweep: every call site of `ghKeyPrefix|ghAttachmentKey|ghBranchKeyPrefix|ghBranchAttachmentKey|parseGhKey|stagedPrefix|destinationKey|ingestKey` either branches on mode or is documented in this plan as intentionally plain-only (`comment-preview-fixtures.ts`, `routes/me.ts:518`'s `gh/` listing which matches both shapes, `isManagedGithubKey`, key-policy roots).
- [ ] Acceptance criteria from #631 checked off one by one against tests.
- [ ] Commit any residue; do not open the PR without the user's go-ahead being already granted in the task ("implement" includes the PR per repo convention — open it, no CodeRabbit request, embed no screenshots (no visual surface), title `feat: randomized URL prefixes for private-repo attachments (#631)`).

## Self-review notes

- Spec coverage: AC1 (randomized prefixes) Tasks 3–7; AC2 (anonymous fetch works / guessing infeasible / rotation kills) Tasks 4, 8 — "anonymous fetch works" is structural (R2 custom domain, no worker) and asserted by the URL-shape tests; AC3 (stable-tail ergonomics) Task 5 (dedupe/pairing via gather tests), Task 7 (overwrite, grouping untouched = metadata-driven, regression-asserted); AC4 (threat model doc) Task 9. Out-of-scope items respected: no public-repo change (regression asserts in Tasks 6–7), no migration, no github-branch provider.
- Type consistency: `GhKeyMode`, `resolveGhKeyContext`, `resolveGhPrefix`, builder names are used identically across Tasks 3–8.
- Known accepted risks, deliberate: `gh/private` owner-name ambiguity (parser ordering); fail-open-to-plain on any resolve failure (uploads never break; matches today's security posture and the "no oracle" rule); issues + ingest share the repo-level id.
