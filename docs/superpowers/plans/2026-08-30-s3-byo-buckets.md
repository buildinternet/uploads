# S3-Compatible BYO Buckets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let workspaces bring any S3-compatible bucket (AWS S3, MinIO, Wasabi, DigitalOcean Spaces, …) as a BYO storage lane, alongside the existing Cloudflare R2 support (issue #595).

**Architecture:** Add a `"s3"` provider to the existing lane machinery. The lane record's `provider` is already a widened string and all storage IO already flows through files-sdk-backed `packages/storage`, so this is a provider branch, not a new subsystem. Runtime client: files-sdk's internal Workers-safe `s3FetchAdapter` (aws4fetch; takes `endpoint`/`region`/`forcePathStyle`), exposed via a tiny pnpm patch — the public `files-sdk/s3` adapter requires `@aws-sdk/client-s3`, which breaks in workerd (`DOMParser` — see PR #780's lesson). Verify pipeline, routes, web form, and docs each get a provider branch. Everything is developed and tested against injected `fetch`/fake clients — **no AWS account required**; a live smoke test against a real S3 bucket happens later when Zach provides one (R2's own S3 endpoint also works as a real-world S3-compatible target).

**Tech Stack:** TypeScript, Cloudflare Workers (workerd), files-sdk 2.2.5 (+ pnpm patch), aws4fetch, vitest (plain, in-process fakes), Astro (apps/web), pnpm workspace.

**Spec:** Issue #595 + this plan's Contract section (no separate spec doc).

## Global Constraints

- All storage IO stays inside `packages/storage` / files-sdk; no direct aws4fetch use in app code except the existing `r2-list-buckets.ts`.
- Any files-sdk HTTP-mode client running in a Worker must be fetch-based (aws4fetch), never `@aws-sdk/*` (workerd has no `DOMParser`).
- Tests: plain vitest, in-process fakes, run with `pnpm test` at repo root. Route tests use the existing seams (`setStorageVerifyForTests`, etc.).
- Lane `mode: "shared" | "byo"` is projected, never inferred from field absence.
- All `ws:` KV mutations go through `mutateWorkspaceRecord`.
- Credentials sealed via `sealCredentialFieldsStrict` on self-serve write paths (already provider-agnostic).
- Public copy says "S3-compatible bucket"; never expose internal flag names. No sensational adjectives in PR/commit messages.
- Formatter: `.ts` = oxfmt (`pnpm fmt` if present; match repo scripts), `.astro` = prettier.
- Commit frequently on the current branch `claude/s3-byo-buckets-ef2d23`; do not create new branches.

---

## Contract (fixed — every task conforms to this)

**New lane/record fields (S3 lanes only, stored plaintext except creds):**

```ts
// Added to StorageLaneFields + WorkspaceRecord (apps/api/src/workspace.ts)
endpoint?: string;        // https origin, e.g. "https://s3.us-east-1.amazonaws.com"
region?: string;          // SigV4 region, e.g. "us-east-1" ("auto" allowed for R2-compat endpoints)
forcePathStyle?: boolean; // path-style addressing; default false
```

R2 lanes keep `accountId`/`jurisdiction` and never set `endpoint`/`region`. S3 lanes set `endpoint`+`region` and never set `accountId`/`jurisdiction`.

**packages/storage config variant:**

```ts
export type StorageProvider = "r2" | "s3";

export interface S3StorageConfig {
  provider: "s3";
  bucket: string;
  prefix?: string;
  endpoint: string;
  region: string;
  forcePathStyle?: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl?: string;
}
```

`createStorage` for `"s3"` calls the patched export `s3FetchAdapter` from `files-sdk/r2` with `providerLabel: "S3 error"`, `name: "s3-http-fetch"`.

**Verify candidate additions (apps/api/src/storage-verify.ts):**

```ts
provider?: "r2" | "s3";   // default "r2" (back-compat)
endpoint?: string;
region?: string;
forcePathStyle?: boolean;
```

S3 shape rules: `endpoint` required, must parse as `https:` URL with no path/query/fragment (origin only), host must pass the same internal-host/IP guard used by `checkPublicBaseUrlShape` (SSRF); `region` required, `/^[a-z0-9-]{1,32}$/` (also allows "auto"); bucket name rule for s3: `/^[a-z0-9]([a-z0-9.-]{1,61})[a-z0-9]$/` (AWS rules — dots allowed). No jurisdiction probing for s3 (single client attempt). `StorageVerifyResult` unchanged except it never sets `jurisdiction` for s3.

**API surface:** `candidateFromBody` accepts the new fields; PUT stamps `provider` from the candidate (default `"r2"`); lane dedupe key = `bucket` + (`accountId` ?? `endpoint`). Lane/status projections gain `provider`, `endpoint`, `region` (endpoint is not secret). `POST /storage/buckets` (ListBuckets picker) stays R2-only; the web form shows a plain bucket text field in S3 mode.

**Budget:** `storageBudgetApplies` BYO detection becomes `!binding && accessKeyId && secretAccessKey && (accountId || endpoint)`.

**Web form:** a provider toggle — "Cloudflare R2" (default, unchanged) vs "Other S3-compatible". S3 mode fields: Endpoint URL, Region, Bucket (text input, no picker), Access key ID, Secret access key, Public base URL (still required client-side per PR #825). Convenience parse: pasting an AWS endpoint (`s3.<region>.amazonaws.com` or `<bucket>.s3.<region>.amazonaws.com`) auto-fills region (and bucket for the virtual-hosted form).

---

### Task 1: files-sdk patch exposing `s3FetchAdapter` + `"s3"` provider in packages/storage

**Files:**

- Create: `patches/files-sdk.patch` (via `pnpm patch files-sdk`)
- Modify: `pnpm-workspace.yaml` (patchedDependencies)
- Modify: `packages/storage/src/index.ts` (StorageProvider union, S3StorageConfig, createStorage case)
- Test: `packages/storage/test/s3-provider.test.ts` (new)

**Interfaces:**

- Consumes: files-sdk internal `s3FetchAdapter` (`dist/internal/s3-fetch.d.ts` documents `S3FetchAdapterOptions`).
- Produces: `StorageProvider = "r2" | "s3"`, `S3StorageConfig` (exact shape in Contract), `createStorage` accepting it. Later tasks import these from `@uploads/storage` (check the actual package name in `packages/storage/package.json` and use it).

- [ ] **Step 1: Create the pnpm patch.** Run `pnpm patch files-sdk` (from repo root; it prints an edit dir). In the edit dir:
  - `dist/r2/index.js`: change the final `export { r2 };` to `export { r2, s3FetchAdapter };`
  - `dist/r2/index.d.ts`: append:
    ```ts
    export { s3FetchAdapter } from "../internal/s3-fetch.js";
    export type { S3FetchAdapter, S3FetchAdapterOptions } from "../internal/s3-fetch.js";
    ```
    Then `pnpm patch-commit <dir>`. Verify `pnpm-workspace.yaml` gained the `files-sdk` entry under `patchedDependencies` and `pnpm install` succeeds. Add a comment in the patch-adjacent location only if the repo has a convention for it; otherwise document in the PR body. (Upstream FR to files-sdk is follow-up work, not this PR.)

- [ ] **Step 2: Write failing tests** in `packages/storage/test/s3-provider.test.ts`. Mirror the style of the existing `packages/storage/test/index.test.ts`. Cases:

  ```ts
  // 1. createStorage({provider:"s3", ...}) returns a Files instance whose adapter name is "s3-http-fetch"
  // 2. a PUT via storage with an injected fetch hits the expected virtual-hosted URL
  //    https://my-bucket.s3.us-east-1.amazonaws.com/<prefix><key> and carries an
  //    Authorization header containing "Credential=" and "/us-east-1/s3/aws4_request"
  // 3. forcePathStyle:true produces https://s3.us-east-1.amazonaws.com/my-bucket/<key>
  // 4. prefix confinement still applies (reuse the pattern from prefix-confinement.test.ts)
  ```

  files-sdk's fetch adapter takes `fetch` as an option — thread an injectable `fetch` through `S3StorageConfig` the same way tests need it, OR (preferred, smaller surface) capture requests with a vitest `globalThis.fetch` stub returning minimal S3 XML responses. Look at how existing tests handle this and match.

- [ ] **Step 3: Run tests, verify they fail** (`pnpm --filter <storage-pkg> test` or `pnpm vitest run packages/storage/test/s3-provider.test.ts`).

- [ ] **Step 4: Implement.** In `packages/storage/src/index.ts`: widen `StorageProvider`, add `S3StorageConfig` to the config union, add the `case "s3"` in `createStorage`:

  ```ts
  case "s3": {
    return new Files(
      s3FetchAdapter({
        accessKeyId: config.accessKeyId,
        bucket: config.bucket,
        endpoint: config.endpoint,
        name: "s3-http-fetch",
        providerLabel: "S3 error",
        region: config.region,
        secretAccessKey: config.secretAccessKey,
        ...(config.forcePathStyle !== undefined && { forcePathStyle: config.forcePathStyle }),
        ...(config.publicBaseUrl && { publicBaseUrl: config.publicBaseUrl }),
      }),
      /* same prefix wrapping as the r2 case — read the existing code */
    );
  }
  ```

  Import `s3FetchAdapter` from `files-sdk/r2`. Keep the `satisfies never` default branch working.

- [ ] **Step 5: Run tests until green; run the whole storage package suite; typecheck** (`pnpm -r typecheck` or repo equivalent — check package.json scripts).

- [ ] **Step 6: Commit** (`feat(storage): add s3 provider backed by files-sdk s3FetchAdapter`).

---

### Task 2: apps/api core — record fields, `resolveStorageConfig`, budget predicate

**Files:**

- Modify: `apps/api/src/workspace.ts` (StorageLaneFields ~:256-268, WorkspaceRecord ~:61-78 — add `endpoint`, `region`, `forcePathStyle`)
- Modify: `apps/api/src/storage.ts` (`resolveStorageConfig` ~:40-113 — allow `"s3"`)
- Modify: `apps/api/src/budget.ts` (`storageBudgetApplies` ~:55-62)
- Test: extend `apps/api/test/byo-storage-budget.test.ts` + the test file covering `resolveStorageConfig` (find it: grep `resolveStorageConfig` under apps/api; add one if none exists as `apps/api/src/storage.test.ts` following sibling conventions)

**Interfaces:**

- Consumes: `S3StorageConfig` / `StorageProvider` from Task 1.
- Produces: `resolveStorageConfig` returns an `S3StorageConfig` for lanes with `provider === "s3"`; throws the existing `storage_misconfigured` ServiceUnavailableError when s3 fields are incomplete (missing endpoint/region/creds/bucket). `storageBudgetApplies(record)` treats `endpoint`-bearing credentialed no-binding records as BYO.

- [ ] **Step 1: Write failing tests.**
  - `resolveStorageConfig` with `{provider:"s3", bucket, endpoint:"https://s3.us-east-1.amazonaws.com", region:"us-east-1", accessKeyId, secretAccessKey (sealed — reuse the sealing helpers the existing tests use)}` → returns provider `"s3"` config with fields threaded through.
  - Missing `region` or `endpoint` → throws `storage_misconfigured` 503.
  - Unknown provider `"gcs"` → still throws (regression).
  - `storageBudgetApplies`: s3 record (no accountId, has endpoint+creds, no binding) → `false` (budget does NOT apply, i.e. BYO); shared record unchanged → `true`. **Read `budget.ts` first** — confirm the boolean sense (the map said BYO ⇒ budget doesn't apply to total, enforcement moves to shared residue) and write tests against actual semantics, not this summary.
- [ ] **Step 2: Run, verify failures.**
- [ ] **Step 3: Implement.** In `storage.ts`, replace the `!== "r2"` guard with a provider switch; the `"s3"` branch validates endpoint/region presence and builds `S3StorageConfig` (creds opened via the existing `openCredentialFields` path — same as r2). In `budget.ts`, adjust the predicate per Contract. In `workspace.ts`, add the three fields with short doc comments matching the file's style.
- [ ] **Step 4: Run apps/api test suite; typecheck.**
- [ ] **Step 5: Commit** (`feat(api): resolve s3 storage lanes and classify them as BYO for budget`).

---

### Task 3: verify pipeline — s3 branch in `storage-verify.ts`

**Files:**

- Modify: `apps/api/src/storage-verify.ts`
- Test: `apps/api/src/storage-verify.test.ts` (extend)

**Interfaces:**

- Consumes: Task 1/2 types.
- Produces: `verifyStorageConfig` accepts candidates with `provider: "s3"` + `endpoint`/`region`/`forcePathStyle`; `defaultStorageClientFactory` builds an s3 `createStorage` config for them. Checks emitted keep the same ids (`shape`, `auth`, `round-trip`, `not-empty`, `public-url`, `embed-cache`).

- [ ] **Step 1: Read the file end-to-end first** (475 lines) — the jurisdiction probe loop (~:358-395), `checkShape` (~:126-160), `checkPublicBaseUrlShape` (~:167-196), seams (~:80-117).
- [ ] **Step 2: Write failing tests** (extend the existing FakeStorageClient pattern at `storage-verify.test.ts:70`):
  - s3 candidate happy path: shape/auth/round-trip pass, no jurisdiction probing (assert `createClient` called exactly once, with the s3 config), result has no `jurisdiction`.
  - shape failures: missing region; endpoint with a path (`https://s3.amazonaws.com/foo`); `http:` endpoint; endpoint host = `169.254.169.254` and `localhost` (SSRF guard); invalid bucket per AWS rule; dots-in-bucket **passes** for s3 but still fails for r2.
  - region `"auto"` passes shape.
  - `public-url` + `embed-cache` behave identically for s3 (one test proving the shared path runs).
  - r2 regression: existing tests untouched and green.
- [ ] **Step 3: Implement.** Branch `checkShape` on `candidate.provider ?? "r2"`. Extract/reuse the internal-host guard from `checkPublicBaseUrlShape` into a shared helper for the endpoint check. In the probe section, s3 takes the single-attempt path (no jurisdiction loop). `defaultStorageClientFactory` builds `{provider:"s3", endpoint, region, forcePathStyle, ...}` for s3 candidates. Auth-failure hint copy for s3: reference "an access key scoped to this bucket" (not "R2 API token") — branch `hintForAuthError`.
- [ ] **Step 4: Run the verify test file + full apps/api suite.**
- [ ] **Step 5: Commit** (`feat(api): verify pipeline supports s3-compatible candidates`).

---

### Task 4: routes — candidate parsing, persistence, projections

**Files:**

- Modify: `apps/api/src/routes/workspace-storage.ts` (`candidateFromBody` ~:244-259, projections ~:44-142, `isByoRecord` ~:32-36)
- Modify: `apps/api/src/routes/workspace-settings.ts` (`storagePutHandler` ~:536-627: provider stamp, dedupe key, persisted fields; `storageBucketsHandler` ~:454-505: reject non-r2 candidates with the existing 400 error convention)
- Test: `apps/api/test/routes-workspace-settings.test.ts` (extend)

**Interfaces:**

- Consumes: Tasks 1–3.
- Produces: PUT body accepts `provider`, `endpoint`, `region`, `forcePathStyle`; persisted s3 lanes carry them (creds sealed via `sealCredentialFieldsStrict`, `storageAccessKeyIdLast4` still stamped); GET status lanes expose `provider`, `endpoint`, `region`; activation re-verify works for s3 lanes (via `laneVerifyCandidate` carrying the new fields).

- [ ] **Step 1: Write failing route tests** (use `setStorageVerifyForTests` to stub verify; mirror existing cases ~:433+):
  - PUT with s3 body persists a lane with `provider:"s3"`, endpoint/region/forcePathStyle, sealed creds, no accountId/jurisdiction.
  - PUT dedupe: same bucket+endpoint replaces the saved s3 lane; same bucket different endpoint creates a second entry only if the lane model allows (match existing r2 dedupe behavior exactly — read it first).
  - GET status projects provider/endpoint/region on the s3 lane; r2 lanes still project accountIdMasked/jurisdiction.
  - Activate on an s3 lane passes the s3 candidate into the (stubbed) verify.
  - POST /storage/buckets with `provider:"s3"` → 400 (unsupported for picker).
- [ ] **Step 2: Run, verify failures.**
- [ ] **Step 3: Implement** per Contract. `laneVerifyCandidate` must thread the new fields so stale-activation re-verify works.
- [ ] **Step 4: Full apps/api suite; typecheck.**
- [ ] **Step 5: Commit** (`feat(api): storage routes accept and project s3 lanes`).

---

### Task 5: web settings form — provider toggle + S3 fields

**Files:**

- Modify: `apps/web/src/pages/account/workspaces/[name]/settings/storage.astro`
- Create: `apps/web/src/lib/s3-endpoint.ts` + `apps/web/src/lib/s3-endpoint.test.ts`
- Modify (maybe): `apps/web/src/lib/storage-health-banner.ts` only if copy hardcodes R2

**Interfaces:**

- Consumes: Task 4's API contract (PUT/GET fields).
- Produces: user-facing S3 connect flow.

- [ ] **Step 1: Read the current form** (1281 lines) and PR #825's one-screen shape; note Tailwind-only styling (scoped `.storage-*` classes are gone — new elements use utility classes; legacy class names are DOM hooks only).
- [ ] **Step 2: Write `s3-endpoint.ts` + failing tests first:**
  ```ts
  export interface ParsedS3Endpoint {
    endpoint: string;
    region?: string;
    bucket?: string;
  }
  export const parseS3Endpoint = (input: string): ParsedS3Endpoint | null => {
    /* … */
  };
  ```
  Cases: `https://s3.us-east-1.amazonaws.com` → region us-east-1; `https://my-bucket.s3.eu-west-2.amazonaws.com` → bucket + region + canonical endpoint `https://s3.eu-west-2.amazonaws.com`; bare `s3.us-east-1.amazonaws.com` (no scheme) → https assumed; non-AWS host (`https://minio.example.com`) → endpoint only, region undefined; junk → null. Mirror `r2-endpoint.test.ts` style.
- [ ] **Step 3: Implement the form.** Provider toggle at the top of the connect form (radio group, default "Cloudflare R2"; second option "Other S3-compatible"). S3 mode: swap the "Account ID or endpoint URL" field for "Endpoint URL" (wired to `parseS3Endpoint`, auto-fills the Region input and Bucket when derivable), add "Region" text input (placeholder `us-east-1`), plain Bucket text input (no picker lookup — do not call /storage/buckets in s3 mode), keep keys + Public base URL (required client-side, same as R2 mode). Submit body includes `provider:"s3"`, endpoint, region (and `forcePathStyle` only if you add an "advanced" checkbox — optional, skip if it clutters; server defaults false). Saved-lane card + status rows: for s3 lanes show Endpoint and Region rows instead of Account ID/Jurisdiction; keep health badge/actions identical. Copy: "S3-compatible" phrasing; the Cloudflare `<details>` setup walkthrough stays R2-only (hide it in s3 mode).
- [ ] **Step 4: Run web tests + typecheck; `pnpm --filter @uploads/ui build` only if you touched packages/ui (you shouldn't).**
- [ ] **Step 5: Verify in browser IF a dev stack is cheap to bring up** (memory: stack-raw recipe; apps/auth/.dev.vars needs BETTER_AUTH_SECRET). If the stack fights you for more than ~15 minutes, skip — flag it in your report so the orchestrator screenshots later.
- [ ] **Step 6: Commit** (`feat(web): S3-compatible provider option in storage settings`).

---

### Task 6: docs sweep

**Files:**

- Modify: `apps/web/src/content/docs/byo-bucket.mdx` (add an "Other S3-compatible providers" section: fields, region note, path-style note, public-base-URL expectations, embed-cache tip is Cloudflare-specific — say CDN-equivalent for S3)
- Modify: `AGENTS.md`, `README.md`, `PRODUCT.md`, `VISION.md`, `docs/roadmap.md`, `docs/workspaces.md`, `CONTRIBUTING.md` — update the "R2 only" assertions found at AGENTS.md:4,47-49, CONTRIBUTING.md:210, PRODUCT.md:87, VISION.md:95,109-110, README.md:188, docs/roadmap.md:10-12, docs/workspaces.md:114 (verify each line still says that before editing)

**Interfaces:** none.

- [ ] **Step 1: Load the `docs-page-style` skill** (`skills/docs-page-style` per repo convention) before editing byo-bucket.mdx; follow the softened-STE100 writing rules in AGENTS.md.
- [ ] **Step 2: Edit; keep the existing page structure; docs edits to an existing page need no sitemap change.**
- [ ] **Step 3: Commit** (`docs: cover S3-compatible BYO buckets`).

---

### Task 7: integration review + full suite + PR

- [ ] Run the full root `pnpm test` and typecheck; fix anything cross-task.
- [ ] Adversarial code review pass (subagent) over the whole diff: SSRF guard on endpoint, sealed creds never logged/projected, r2 regressions, dedupe semantics, budget predicate sense.
- [ ] Push branch, open PR against main referencing #595; PR body: what/why, the files-sdk patch rationale (workerd + non-exported s3FetchAdapter, upstream FR to file), test strategy (no live AWS — injected-fetch signing tests; live smoke deferred until Zach supplies a bucket), and remaining follow-ups (bucket picker for s3, live smoke, upstream files-sdk export).
- [ ] Request CodeRabbit review (`coderabbit:review` label) — auth/SSRF-adjacent change, warranted.
