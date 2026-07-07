# Admin Token Minting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an authenticated admin HTTP endpoint that mints one or more upload tokens for an existing workspace, defaulting to the `default` workspace.

**Architecture:** A workspace record's single `tokenHash` becomes a list of token objects; `workspaceAuth` matches a presented token against any hash in the list (legacy `tokenHash` still honored on read). A new `adminAuth` middleware gates `POST /admin/tokens`, which appends a freshly minted token to a workspace's record and returns it once.

**Tech Stack:** Cloudflare Workers, Hono, TypeScript, Workers KV (`REGISTRY`), `wrangler dev` for local verification.

## Global Constraints

- Throwaway proof-of-concept — to be replaced by a real auth system. No listing/revoking/expiry/scopes.
- **Never edit `.env` or `.dev.vars`** — only `*.example` template files. The user sets real secret values.
- Token format: `up_<workspace>_<base64url(24 random bytes)>`.
- Workspace name regex (existing): `/^[a-z0-9][a-z0-9-]{1,62}$/`.
- Auth failures return uniform `401 { error: "unauthorized" }`; the admin route **fails closed** if `ADMIN_TOKEN` is unset.
- No unit-test harness exists in this repo. Verification = `pnpm --filter @uploads/api typecheck` + `curl` against `wrangler dev`. All `pnpm` commands run from repo root unless noted.
- Do not sensationalize copy in commits/docs.

---

### Task 1: Multi-token record schema + auth

**Files:**

- Modify: `apps/api/src/workspace.ts` (schema `WorkspaceRecord`; `workspaceAuth` hash-list compare)
- Create: `apps/api/src/env.d.ts` (type `ADMIN_TOKEN` onto `Env`)

**Interfaces:**

- Produces:
  - `interface WorkspaceRecord` gains `tokens?: { hash: string; label?: string; createdAt: string }[]` and marks `tokenHash?` optional/legacy.
  - `export function workspaceTokenHashes(record: WorkspaceRecord): string[]` — returns `record.tokens?.map(t => t.hash) ?? (record.tokenHash ? [record.tokenHash] : [])`. Reused by Task 2's endpoint.
  - `export async function sha256Hex(value: string): Promise<string>` — already exists, unchanged.
- Consumes: nothing new.

- [ ] **Step 1: Add `ADMIN_TOKEN` to the Env type**

Create `apps/api/src/env.d.ts`:

```ts
// ADMIN_TOKEN is a runtime Worker secret (see .dev.vars.example), not declared
// in wrangler.jsonc, so `wrangler types` does not generate it. Augment Env here.
interface Env {
  ADMIN_TOKEN?: string;
}
```

- [ ] **Step 2: Update `WorkspaceRecord` and add `workspaceTokenHashes`**

In `apps/api/src/workspace.ts`, replace the `tokenHash` field in the `WorkspaceRecord` interface:

```ts
  /** Public custom domain for this workspace's bucket. */
  publicBaseUrl?: string;
  /** Bearer tokens valid for this workspace. */
  tokens?: { hash: string; label?: string; createdAt: string }[];
  /** @deprecated legacy single-token field; still honored on read. */
  tokenHash?: string;
```

Add an exported helper directly below the `sha256Hex` function:

```ts
/** All valid token hashes for a workspace (new list + legacy single field). */
export function workspaceTokenHashes(record: WorkspaceRecord): string[] {
  return record.tokens?.map((t) => t.hash) ?? (record.tokenHash ? [record.tokenHash] : []);
}
```

- [ ] **Step 3: Match against any hash in `workspaceAuth`**

Replace the compare block (the `const providedHash` / `expectedHash` / `ok` section) in `workspaceAuth` with a candidate-list match that keeps a constant-ish work profile:

```ts
const providedHash = await sha256Hex(token);
const providedBytes = hexToBytes(providedHash);
const candidates = record ? workspaceTokenHashes(record) : [];
// Always compare at least once so unknown workspaces cost the same.
const toCheck = candidates.length > 0 ? candidates : [providedHash.replace(/./g, "0")];
let matched = false;
for (const hash of toCheck) {
  if (crypto.subtle.timingSafeEqual(providedBytes, hexToBytes(hash))) matched = true;
}
const ok = record !== null && token.length > 0 && candidates.length > 0 && matched;

if (!ok || !record || !name) return c.json({ error: "unauthorized" }, 401);
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @uploads/api typecheck`
Expected: PASS (no errors).

- [ ] **Step 5: Verify existing (legacy) token still authenticates**

Seed a local legacy-format record and confirm auth still works. From `apps/api`:

```bash
node scripts/add-workspace.mjs default --bucket uploads-default --binding UPLOADS_DEFAULT --local
# copy the printed token into $TOK, then in another shell run `pnpm --filter @uploads/api dev`
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $TOK" http://localhost:8787/v1/default/files
```

Expected: `200`. (This record is still legacy-format because Task 3 hasn't run yet — proving back-compat.)

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/workspace.ts apps/api/src/env.d.ts
git commit -m "Support multiple bearer tokens per workspace"
```

---

### Task 2: Admin auth middleware + mint endpoint

**Files:**

- Create: `apps/api/src/admin.ts` (adminAuth middleware)
- Create: `apps/api/src/routes/admin.ts` (POST /admin/tokens)
- Modify: `apps/api/src/index.ts` (mount the route)

**Interfaces:**

- Consumes: `sha256Hex`, `workspaceTokenHashes`, `WorkspaceRecord` from `./workspace` (Task 1).
- Produces:
  - `export const adminAuth: MiddlewareHandler<{ Bindings: Env }>` — 401 unless `Authorization: Bearer <ADMIN_TOKEN>` matches the secret; fails closed if the secret is unset.
  - `export const admin: Hono` — mounted at `/admin`; `POST /tokens`.

- [ ] **Step 1: Write the admin auth middleware**

Create `apps/api/src/admin.ts`:

```ts
import type { MiddlewareHandler } from "hono";
import { sha256Hex } from "./workspace";

/**
 * Gates /admin/* on the ADMIN_TOKEN secret. Fails closed: if the secret is
 * unset/empty, every request is 401. Compares SHA-256 digests in constant time.
 */
export const adminAuth: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const secret = c.env.ADMIN_TOKEN ?? "";
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";

  const providedHash = await sha256Hex(token);
  const expectedHash = secret ? await sha256Hex(secret) : providedHash.replace(/./g, "0");
  const bytes = (hex: string) => {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
  };
  const ok =
    secret.length > 0 &&
    token.length > 0 &&
    crypto.subtle.timingSafeEqual(bytes(providedHash), bytes(expectedHash));

  if (!ok) return c.json({ error: "unauthorized" }, 401);
  await next();
};
```

- [ ] **Step 2: Write the mint route**

Create `apps/api/src/routes/admin.ts`:

```ts
import { Hono } from "hono";
import { adminAuth } from "../admin";
import { sha256Hex, type WorkspaceRecord } from "../workspace";

const WS_NAME_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

export const admin = new Hono<{ Bindings: Env }>()
  .use("/*", adminAuth)

  // Mint a bearer token for an existing workspace (defaults to "default").
  .post("/tokens", async (c) => {
    const body = await c.req.json<{ workspace?: string; label?: string }>().catch(() => ({}));
    const name = body.workspace?.trim() || "default";
    const label = body.label?.trim() || undefined;
    if (!WS_NAME_RE.test(name)) return c.json({ error: "invalid workspace" }, 400);

    const record = await c.env.REGISTRY.get<WorkspaceRecord>(`ws:${name}`, { type: "json" });
    if (!record) return c.json({ error: "workspace not found" }, 404);

    const token = `up_${name}_${btoa(
      String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")}`;
    const entry = { hash: await sha256Hex(token), label, createdAt: new Date().toISOString() };

    const tokens =
      record.tokens ??
      (record.tokenHash ? [{ hash: record.tokenHash, createdAt: entry.createdAt }] : []);
    tokens.push(entry);
    const { tokenHash: _drop, ...rest } = record;
    await c.env.REGISTRY.put(`ws:${name}`, JSON.stringify({ ...rest, tokens }));

    return c.json({ workspace: name, token, label: label ?? null }, 201);
  });
```

- [ ] **Step 3: Mount the route in `index.ts`**

Modify `apps/api/src/index.ts` — add the import and the `.route(...)` line:

```ts
import { Hono } from "hono";
import { workspaceAuth, type WorkspaceVars } from "./workspace";
import { files } from "./routes/files";
import { admin } from "./routes/admin";

const app = new Hono<WorkspaceVars>()
  .get("/health", (c) => c.json({ ok: true }))
  .route("/admin", admin)
  .use("/v1/:workspace/*", workspaceAuth)
  .route("/v1/:workspace/files", files)
  .onError((err, c) => {
    console.error(JSON.stringify({ message: err.message, stack: err.stack }));
    return c.json({ error: "internal error" }, 500);
  })
  .notFound((c) => c.json({ error: "not found" }, 404));

export default app;
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @uploads/api typecheck`
Expected: PASS.

- [ ] **Step 5: Verify end-to-end against `wrangler dev`**

Add `ADMIN_TOKEN=dev-admin-secret` to `apps/api/.dev.vars` — **the user does this**, then runs `pnpm --filter @uploads/api dev`. With a `default` workspace already seeded (Task 1 Step 5), from another shell:

```bash
# mint for default (no body)
curl -s -XPOST -H "Authorization: Bearer dev-admin-secret" http://localhost:8787/admin/tokens
# → {"workspace":"default","token":"up_default_...","label":null}  (201)

# the minted token authenticates
NEW=up_default_...   # paste from above
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $NEW" http://localhost:8787/v1/default/files   # 200

# a second mint yields a different token; BOTH still work (append, not replace)
# wrong admin token → 401
curl -s -o /dev/null -w "%{http_code}\n" -XPOST -H "Authorization: Bearer nope" http://localhost:8787/admin/tokens   # 401
# unknown workspace → 404
curl -s -w "\n%{http_code}\n" -XPOST -H "Authorization: Bearer dev-admin-secret" \
  -H "Content-Type: application/json" -d '{"workspace":"ghost"}' http://localhost:8787/admin/tokens   # 404
```

Expected: mint `201`; minted token `200`; both tokens `200`; wrong admin `401`; unknown workspace `404`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/admin.ts apps/api/src/routes/admin.ts apps/api/src/index.ts
git commit -m "Add admin endpoint to mint workspace tokens"
```

---

### Task 3: Emit the new token format from `add-workspace.mjs`

**Files:**

- Modify: `apps/api/scripts/add-workspace.mjs` (write `tokens: [...]` instead of `tokenHash`)

**Interfaces:**

- Consumes: nothing new. Produces records in the Task 1 `tokens[]` shape.

- [ ] **Step 1: Write the `tokens` list instead of `tokenHash`**

In `apps/api/scripts/add-workspace.mjs`, replace the `tokenHash:` line inside the `record` object:

```js
  tokens: [{
    hash: crypto.createHash("sha256").update(token).digest("hex"),
    label: "initial",
    createdAt: new Date().toISOString(),
  }],
```

(Leave the rest of the record and the "Store the token now" output unchanged.)

- [ ] **Step 2: Verify a freshly created workspace authenticates**

From `apps/api` (with `pnpm --filter @uploads/api dev` running):

```bash
node scripts/add-workspace.mjs demo --bucket uploads-default --binding UPLOADS_DEFAULT --local
DEMO=up_demo_...   # paste printed token
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $DEMO" http://localhost:8787/v1/demo/files
```

Expected: `200`. Confirm the KV value is list-format:

```bash
pnpm exec wrangler kv key get ws:demo --binding REGISTRY --local
```

Expected: JSON containing `"tokens":[{...}]` and no `"tokenHash"`.

- [ ] **Step 3: Commit**

```bash
git add apps/api/scripts/add-workspace.mjs
git commit -m "Emit list-format token from add-workspace script"
```

---

### Task 4: Docs + env templates

**Files:**

- Modify: `README.md` (active-development callout + "Minting tokens" section)
- Modify: `apps/api/.dev.vars.example` (add `ADMIN_TOKEN`)
- Modify: `.env.example` (note the admin mint flow)

**Interfaces:** none (docs only).

- [ ] **Step 1: Add the active-development callout to `README.md`**

Immediately under the top-level title/intro of `README.md`, add:

```markdown
> **Active development — not production-ready.** uploads.sh is being built in
> the open and its APIs (including auth) will change without notice. Don't rely
> on it for anything you can't afford to lose or re-key.
```

- [ ] **Step 2: Add a "Minting tokens" section to `README.md`**

Add a section (near the existing workspace/curl docs):

````markdown
### Minting upload tokens

Tokens are minted by an admin endpoint guarded by the `ADMIN_TOKEN` secret.
Set it once per environment:

```bash
# local: add ADMIN_TOKEN=... to apps/api/.dev.vars
# production:
cd apps/api && pnpm exec wrangler secret put ADMIN_TOKEN
```

Then mint a token (defaults to the `default` workspace):

```bash
curl -XPOST https://api.uploads.sh/admin/tokens \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# → { "workspace": "default", "token": "up_default_…", "label": null }

# a specific workspace, with an optional label:
curl -XPOST https://api.uploads.sh/admin/tokens \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"workspace":"acme","label":"ci"}'
```

The token is shown once. Minting appends — a workspace can hold several valid
tokens. The workspace must already exist (`pnpm workspace:add …`); this endpoint
issues tokens, it does not create workspaces. There is no revoke endpoint yet —
remove a token by editing its `ws:<name>` record in KV.
````

- [ ] **Step 3: Add `ADMIN_TOKEN` to `apps/api/.dev.vars.example`**

Append to `apps/api/.dev.vars.example`:

```
# Gates the /admin/* endpoints (e.g. POST /admin/tokens to mint upload tokens).
# Any non-empty string works locally. In production set it with:
#   cd apps/api && pnpm exec wrangler secret put ADMIN_TOKEN
# If unset, /admin/* rejects every request (fails closed).
ADMIN_TOKEN=
```

- [ ] **Step 4: Note the mint flow in `.env.example`**

In `.env.example`, extend the comment above `UPLOADS_TOKEN=` so readers know the second way to get a token. Replace the existing `UPLOADS_TOKEN` comment block with:

```
# Bearer token for that workspace. Two ways to get one:
#   - create a workspace (mints its first token, shown once):
#       cd apps/api && node scripts/add-workspace.mjs <workspace> --bucket <bucket> --binding <BINDING>
#   - mint an additional token for an existing workspace via the admin endpoint:
#       curl -XPOST $UPLOADS_API_URL/admin/tokens -H "Authorization: Bearer $ADMIN_TOKEN"
# Local dev (--local) tokens are a separate store from production — they only
# work against localhost.
UPLOADS_TOKEN=
```

- [ ] **Step 5: Verify docs render and templates are consistent**

Run:

```bash
grep -n "ADMIN_TOKEN" README.md apps/api/.dev.vars.example .env.example
```

Expected: matches in all three files. Visually confirm the README callout and mint section read correctly.

- [ ] **Step 6: Commit**

```bash
git add README.md apps/api/.dev.vars.example .env.example
git commit -m "Document token minting and admin secret"
```

---

## Self-Review

**Spec coverage:**

- Multi-token schema + legacy read → Task 1. ✓
- Auth matches any hash → Task 1 Step 3. ✓
- `adminAuth` secret, fails closed → Task 2 Step 1. ✓
- `POST /admin/tokens`, default→`default`, append, 404 on missing, 201 once → Task 2 Step 2. ✓
- `add-workspace.mjs` emits list format → Task 3. ✓
- README active-dev callout + public mint docs → Task 4 Steps 1–2. ✓
- All `*.example` env files updated → Task 4 Steps 3–4. ✓
- Out-of-scope (list/revoke/expiry) → not implemented. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code. ✓

**Type consistency:** `workspaceTokenHashes` (Task 1) consumed in Task 2; `tokens: { hash; label?; createdAt }[]` shape identical across Tasks 1–3; `sha256Hex` reused unchanged. ✓

**Note:** No automated test harness in this repo — verification is typecheck + `curl` against `wrangler dev`, consistent with the existing codebase and the throwaway-PoC scope. Steps requiring `.dev.vars`/`.env` edits are explicitly the user's to perform.
