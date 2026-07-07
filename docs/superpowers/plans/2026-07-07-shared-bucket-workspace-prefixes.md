# Shared-Bucket Workspace Prefixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Default workspaces become per-workspace key prefixes inside the shared `uploads-default` R2 bucket, so creating a workspace is a pure KV write; dedicated-bucket (BYO) workspaces keep working unchanged.

**Architecture:** `WorkspaceRecord` gains an optional `prefix` field. The prefix is applied in exactly one place — `createStorage()` in `packages/storage` — using files-sdk's native instance-level `prefix` option (`new Files({ adapter, prefix })`), which prepends on every operation and strips prefixes from list results. Route code in `apps/api/src/routes/files.ts` is untouched. `add-workspace.mjs` flips its default: no `--bucket` flag now means shared-bucket mode.

**Tech Stack:** TypeScript (strict, ESM), Hono on Cloudflare Workers, files-sdk 2.1.0 (pnpm-patched), Wrangler, pnpm workspaces, vitest (new, added by this plan).

**Spec:** `docs/superpowers/specs/2026-07-07-shared-bucket-workspace-prefixes-design.md`

## Global Constraints

- TypeScript strict, ESM only, `lib: ["ES2022"]` — no DOM types (Workers types own globals).
- All storage access goes through `createStorage()` in `packages/storage`; never import files-sdk adapters or touch R2 bindings from route code.
- Secrets never go in `wrangler.jsonc` or source files.
- Never edit `.env` files — if a `.env` value must change, tell the user and stop.
- No workspace is special-cased in code; `default` is just a registered tenant.
- Shared-bucket constants (exact values): bucket `uploads-default`, binding `UPLOADS_DEFAULT`, public base URL `https://storage.uploads.sh`.
- Prefix convention: `<workspace-name>/` — must end with `/`.
- Run all commands from the repo root unless a task says otherwise. Use `pnpm`, never `npm`/`yarn`.
- `apps/api/wrangler.jsonc` is NOT modified by this plan (both bindings already exist). If you think you need to change it, stop and re-read the task.
- Commit after every task with the exact message given. Do not push.

---

### Task 1: Prefix plumbing in `@uploads/storage` (config, validation, publicUrl) + vitest setup

**Files:**
- Modify: `packages/storage/src/index.ts`
- Modify: `packages/storage/package.json`
- Create: `packages/storage/test/index.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `StorageConfig.prefix?: string` (optional, must match `/^([a-z0-9][a-z0-9._-]*\/)+$/`); `createStorage(config)` returns a `Files` instance whose operations are confined under `config.prefix`; `publicUrl(config, key)` returns `<base>/<prefix><key>` (segments URI-encoded). Task 2 tests behavior; Task 3 passes `prefix` from the workspace record.

- [ ] **Step 1: Add vitest to the storage package**

Run:
```bash
pnpm --filter @uploads/storage add -D vitest
```

Then in `packages/storage/package.json`, add a `test` script alongside the existing `typecheck` script:

```json
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
```

No vitest config file is needed — defaults pick up `test/**/*.test.ts`. Note: `packages/storage/tsconfig.json` has `"include": ["src"]`, so test files are deliberately outside the typecheck surface; vitest transpiles them itself.

- [ ] **Step 2: Write the failing tests**

Create `packages/storage/test/index.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createStorage, publicUrl, type StorageConfig } from "../src/index.js";

const base: StorageConfig = {
  provider: "r2",
  bucket: "shared",
  accountId: "acct",
  accessKeyId: "key",
  secretAccessKey: "secret",
};

describe("createStorage prefix", () => {
  it("applies the prefix to the Files instance (normalized, no trailing slash)", () => {
    const files = createStorage({ ...base, prefix: "myws/" });
    expect(files.prefix).toBe("myws");
  });

  it("has no prefix when the config omits it (BYO mode)", () => {
    const files = createStorage(base);
    expect(files.prefix).toBe("");
  });

  it.each(["/myws/", "myws", "a//b/", "../x/", "./", "MyWS/", " /"])(
    "rejects invalid prefix %j",
    (prefix) => {
      expect(() => createStorage({ ...base, prefix })).toThrow(/invalid storage prefix/);
    },
  );

  it("accepts multi-segment prefixes", () => {
    const files = createStorage({ ...base, prefix: "team/myws/" });
    expect(files.prefix).toBe("team/myws");
  });
});

describe("publicUrl", () => {
  const cfg: StorageConfig = { ...base, publicBaseUrl: "https://storage.uploads.sh" };

  it("includes the prefix in the public URL", () => {
    expect(publicUrl({ ...cfg, prefix: "myws/" }, "dir/a.png")).toBe(
      "https://storage.uploads.sh/myws/dir/a.png",
    );
  });

  it("omits the prefix when not configured (BYO mode)", () => {
    expect(publicUrl(cfg, "dir/a.png")).toBe("https://storage.uploads.sh/dir/a.png");
  });

  it("URI-encodes key segments but not the slashes", () => {
    expect(publicUrl({ ...cfg, prefix: "myws/" }, "dir/a b.png")).toBe(
      "https://storage.uploads.sh/myws/dir/a%20b.png",
    );
  });

  it("returns null without a publicBaseUrl", () => {
    expect(publicUrl({ ...base, prefix: "myws/" }, "a.png")).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @uploads/storage test`
Expected: FAIL on assertions (vitest strips types, so no compile error): `files.prefix` is `""` instead of `"myws"`, the invalid-prefix cases don't throw, and `publicUrl` omits the prefix.

- [ ] **Step 4: Implement prefix support in `packages/storage/src/index.ts`**

Apply these three edits:

(a) Add the field to `StorageConfig` (after the `publicBaseUrl` field):

```ts
  /**
   * Key prefix all operations are confined under (e.g. "myws/"). Must end
   * with "/". Applied via files-sdk's instance prefix; clients never see it.
   */
  prefix?: string;
```

(b) At the top of `createStorage`, before the `switch`, validate and thread the prefix through. Replace the current `return new Files({ adapter });` line — the full function becomes:

```ts
/** Segments of lowercase alphanumerics/._- each ending in "/"; first char alphanumeric (so "." and ".." are impossible). */
const PREFIX_RE = /^([a-z0-9][a-z0-9._-]*\/)+$/;

export function createStorage(config: StorageConfig): Files {
  if (config.prefix !== undefined && !PREFIX_RE.test(config.prefix)) {
    throw new Error(`invalid storage prefix: ${JSON.stringify(config.prefix)}`);
  }
  switch (config.provider) {
    case "r2": {
      const shared = {
        accountId: config.accountId,
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        publicBaseUrl: config.publicBaseUrl,
      };
      // Binding mode (hybrid when HTTP creds are also set) vs pure HTTP mode.
      const adapter = config.r2Binding
        ? r2({ binding: config.r2Binding, bucket: config.bucket, ...shared })
        : r2({ bucket: config.bucket, ...shared });
      return new Files({ adapter, prefix: config.prefix });
    }
    default:
      throw new Error(`Unsupported storage provider: ${config.provider satisfies never}`);
  }
}
```

(c) Include the prefix in `publicUrl` — the full function becomes:

```ts
/** Public URL for a key when the bucket is fronted by a custom domain. Includes the workspace prefix. */
export function publicUrl(config: StorageConfig, key: string): string | null {
  if (!config.publicBaseUrl) return null;
  const base = config.publicBaseUrl.replace(/\/$/, "");
  const fullKey = `${config.prefix ?? ""}${key}`;
  return `${base}/${fullKey.split("/").map(encodeURIComponent).join("/")}`;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @uploads/storage test`
Expected: PASS (all tests).

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @uploads/storage typecheck`
Expected: exit 0, no output.

- [ ] **Step 7: Commit**

```bash
git add packages/storage pnpm-lock.yaml
git commit -m "feat(storage): confine operations under an optional key prefix"
```

---

### Task 2: Behavioral prefix-confinement tests (fake R2 binding)

**Files:**
- Create: `packages/storage/test/fake-r2.ts`
- Create: `packages/storage/test/prefix-confinement.test.ts`

**Interfaces:**
- Consumes: `createStorage` with `prefix` from Task 1.
- Produces: `FakeR2Bucket` (in-memory stand-in for a Workers `R2Bucket` binding, exposing its raw `store: Map<string, ...>` for assertions). Test-only; nothing else depends on it.

These tests prove the spec's isolation guarantee: a workspace cannot read, write, delete, or list outside its prefix, and listed keys come back with the prefix stripped. They exercise our real `createStorage` + files-sdk r2 binding adapter against an in-memory fake binding.

- [ ] **Step 1: Write the fake R2 binding**

Create `packages/storage/test/fake-r2.ts`:

```ts
/**
 * Minimal in-memory stand-in for a Workers R2Bucket binding — just enough
 * surface for the files-sdk r2 adapter's binding-mode I/O. `store` is exposed
 * so tests can assert on the RAW keys actually written to the bucket.
 */
interface StoredObject {
  data: Uint8Array;
  contentType?: string;
}

export class FakeR2Bucket {
  store = new Map<string, StoredObject>();

  private meta(key: string, obj: StoredObject) {
    return {
      key,
      size: obj.data.byteLength,
      etag: "fake-etag",
      httpEtag: '"fake-etag"',
      uploaded: new Date(0),
      version: "1",
      storageClass: "Standard",
      checksums: {},
      httpMetadata: { contentType: obj.contentType },
      customMetadata: {},
      writeHttpMetadata() {},
    };
  }

  async put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | string | ReadableStream<Uint8Array> | null,
    opts?: { httpMetadata?: { contentType?: string } | Headers },
  ) {
    let data: Uint8Array;
    if (typeof value === "string") data = new TextEncoder().encode(value);
    else if (value instanceof ArrayBuffer) data = new Uint8Array(value);
    else if (value && ArrayBuffer.isView(value))
      data = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    else if (value) {
      const chunks: Uint8Array[] = [];
      const reader = value.getReader();
      for (;;) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        chunks.push(chunk);
      }
      data = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
      let offset = 0;
      for (const c of chunks) {
        data.set(c, offset);
        offset += c.byteLength;
      }
    } else data = new Uint8Array(0);

    const httpMetadata = opts?.httpMetadata;
    const contentType =
      httpMetadata instanceof Headers
        ? (httpMetadata.get("content-type") ?? undefined)
        : httpMetadata?.contentType;
    const obj = { data, contentType };
    this.store.set(key, obj);
    return this.meta(key, obj);
  }

  async get(key: string) {
    const obj = this.store.get(key);
    if (!obj) return null;
    const data = obj.data;
    return {
      ...this.meta(key, obj),
      bodyUsed: false,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(data);
          controller.close();
        },
      }),
      async arrayBuffer() {
        return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      },
      async bytes() {
        return data;
      },
      async text() {
        return new TextDecoder().decode(data);
      },
      async json() {
        return JSON.parse(new TextDecoder().decode(data));
      },
      async blob() {
        return new Blob([data as BlobPart]);
      },
    };
  }

  async head(key: string) {
    const obj = this.store.get(key);
    return obj ? this.meta(key, obj) : null;
  }

  async delete(keys: string | string[]) {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.store.delete(k);
  }

  async list(opts?: { prefix?: string; limit?: number; cursor?: string; delimiter?: string }) {
    const prefix = opts?.prefix ?? "";
    const keys = [...this.store.keys()].filter((k) => k.startsWith(prefix)).sort();
    return {
      objects: keys.map((k) => this.meta(k, this.store.get(k)!)),
      truncated: false as const,
      delimitedPrefixes: [] as string[],
    };
  }
}
```

If a test in Step 2 fails with a `TypeError` saying some method is not a function, the files-sdk adapter needs a binding method the fake lacks — add that method to `FakeR2Bucket` following the real `R2Bucket` signature (see `@cloudflare/workers-types`) rather than changing the test.

- [ ] **Step 2: Write the failing confinement tests**

Create `packages/storage/test/prefix-confinement.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { R2Bucket } from "@cloudflare/workers-types";
import { createStorage } from "../src/index.js";
import { FakeR2Bucket } from "./fake-r2.js";

/** Two workspaces sharing one bucket, like default-mode tenants in uploads-default. */
function tenant(bucket: FakeR2Bucket, prefix: string) {
  return createStorage({
    provider: "r2",
    bucket: "uploads-default",
    prefix,
    r2Binding: bucket as unknown as R2Bucket,
  });
}

const body = (s: string) => new TextEncoder().encode(s);

describe("prefix confinement through createStorage", () => {
  it("writes land under the workspace prefix in the raw bucket", async () => {
    const bucket = new FakeR2Bucket();
    await tenant(bucket, "alpha/").upload("dir/a.txt", body("hi"), {
      contentType: "text/plain",
    });
    expect([...bucket.store.keys()]).toEqual(["alpha/dir/a.txt"]);
  });

  it("reads see only the workspace's own objects", async () => {
    const bucket = new FakeR2Bucket();
    const alpha = tenant(bucket, "alpha/");
    const beta = tenant(bucket, "beta/");
    await alpha.upload("secret.txt", body("alpha data"), { contentType: "text/plain" });

    expect(await alpha.exists("secret.txt")).toBe(true);
    expect(await beta.exists("secret.txt")).toBe(false);
    // A tenant also can't reach another tenant's data by naming its prefix:
    // that just becomes a key under its OWN prefix (beta/alpha/secret.txt).
    expect(await beta.exists("alpha/secret.txt")).toBe(false);
  });

  it("list returns only own objects, with the prefix stripped", async () => {
    const bucket = new FakeR2Bucket();
    const alpha = tenant(bucket, "alpha/");
    const beta = tenant(bucket, "beta/");
    await alpha.upload("one.txt", body("1"), { contentType: "text/plain" });
    await alpha.upload("dir/two.txt", body("2"), { contentType: "text/plain" });
    await beta.upload("other.txt", body("3"), { contentType: "text/plain" });

    const result = await alpha.list();
    const keys = result.items.map((i: { key: string }) => i.key).sort();
    expect(keys).toEqual(["dir/two.txt", "one.txt"]);
  });

  it("delete only touches the workspace's own prefix", async () => {
    const bucket = new FakeR2Bucket();
    const alpha = tenant(bucket, "alpha/");
    const beta = tenant(bucket, "beta/");
    await alpha.upload("same-name.txt", body("alpha"), { contentType: "text/plain" });
    await beta.upload("same-name.txt", body("beta"), { contentType: "text/plain" });

    await alpha.delete("same-name.txt");

    expect(bucket.store.has("alpha/same-name.txt")).toBe(false);
    expect(bucket.store.has("beta/same-name.txt")).toBe(true);
  });

  it("an unprefixed instance (BYO mode) sees the whole bucket", async () => {
    const bucket = new FakeR2Bucket();
    await tenant(bucket, "alpha/").upload("a.txt", body("a"), { contentType: "text/plain" });
    const byo = createStorage({
      provider: "r2",
      bucket: "uploads-default",
      r2Binding: bucket as unknown as R2Bucket,
    });
    expect(await byo.exists("alpha/a.txt")).toBe(true);
  });
});
```

- [ ] **Step 3: Run the new tests**

Run: `pnpm --filter @uploads/storage test`
Expected: PASS. (Task 1 already implemented the behavior — these tests pin the guarantee. If any confinement test fails, that is a real defect in the prefix wiring or the fake: debug it, do not weaken assertions. If a `TypeError: ... is not a function` points at the fake, extend `FakeR2Bucket` per Step 1's note.)

- [ ] **Step 4: Commit**

```bash
git add packages/storage/test
git commit -m "test(storage): prove prefix confinement across shared-bucket tenants"
```

---

### Task 3: Thread `prefix` through the API (workspace record → storage config)

**Files:**
- Modify: `apps/api/src/workspace.ts` (the `WorkspaceRecord` interface, around line 9-24)
- Modify: `apps/api/src/storage.ts` (the `storageConfig` return object, around line 13-21)

**Interfaces:**
- Consumes: `StorageConfig.prefix` from Task 1.
- Produces: `WorkspaceRecord.prefix?: string` — read by `storageConfig()`; Task 4 writes it when registering shared-bucket workspaces. Route code is NOT modified.

- [ ] **Step 1: Add `prefix` to `WorkspaceRecord`**

In `apps/api/src/workspace.ts`, add after the `binding` field (line 13):

```ts
  /** Key prefix inside the bucket (e.g. "myws/"). Set for shared-bucket workspaces; all I/O is confined under it. */
  prefix?: string;
```

- [ ] **Step 2: Pass it through in `storageConfig`**

In `apps/api/src/storage.ts`, add one line to the returned object, after `bucket: ws.bucket,`:

```ts
    prefix: ws.prefix,
```

- [ ] **Step 3: Typecheck the API workspace**

Run: `pnpm --filter @uploads/api typecheck`
Expected: exit 0. (This runs `wrangler types` first; that is expected and does not modify `wrangler.jsonc`.)

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/workspace.ts apps/api/src/storage.ts
git commit -m "feat(api): carry workspace key prefix into storage config"
```

---

### Task 4: Flip `add-workspace.mjs` to shared-bucket defaults

**Files:**
- Modify: `apps/api/scripts/add-workspace.mjs`

**Interfaces:**
- Consumes: `WorkspaceRecord.prefix` shape from Task 3 (the script writes raw JSON to KV; it does not import the type).
- Produces: registration behavior — no `--bucket` ⇒ shared-bucket record (`bucket: "uploads-default"`, `binding: "UPLOADS_DEFAULT"`, `prefix: "<name>/"`, `publicBaseUrl: "https://storage.uploads.sh"`); `--bucket <name>` ⇒ BYO record identical to today's output.

Note: the spec mentions "setup wizard defaults" alongside this script. The CLI setup wizard (`packages/uploads/src/commands/config.ts`) configures client-side values only (API URL, workspace name, token) and has no bucket knowledge — there is nothing to change there. Do not modify `packages/uploads`.

- [ ] **Step 1: Update the usage comment**

Replace the usage block in the header comment (the lines starting `* Usage (from apps/api):` through the example command at the end of the comment) with:

```js
 * Usage (from apps/api):
 *   node scripts/add-workspace.mjs <name> \
 *     [--bucket <bucket>]   # omit for shared-bucket mode (uploads-default + "<name>/" prefix)
 *     [--binding UPLOADS] [--public-base-url https://media.example.com] \
 *     [--account-id ...] [--access-key-id ...] [--secret-access-key ...] \
 *     [--local]             # write to wrangler dev's local KV instead of prod
 *
 * Default (no --bucket): the workspace is a "<name>/" prefix in the shared
 * uploads-default bucket, served at https://storage.uploads.sh/<name>/...
 * Creating one is a pure KV write — no bucket, binding, or deploy needed.
 *
 * BYO mode (--bucket): dedicated bucket, today's behavior. Credential flags
 * fall back to R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY, and
 * --public-base-url to R2_PUBLIC_BASE_URL, so you can keep them in the
 * repo-root .env and run:
 *   node --env-file=../../.env scripts/add-workspace.mjs <name> --bucket <bucket>
 * Env fallbacks apply ONLY in BYO mode — shared-mode records never inherit
 * BYO-bucket credentials from the environment.
```

- [ ] **Step 2: Replace the required-bucket check and record construction**

Delete the line:

```js
if (!opts.bucket) fail("--bucket is required");
```

Replace the `const record = { ... }` block (from `const record =` through `Object.keys(record).forEach(...)`) with:

```js
const SHARED = {
  bucket: "uploads-default",
  binding: "UPLOADS_DEFAULT",
  publicBaseUrl: "https://storage.uploads.sh",
};

const tokens = [{
  hash: crypto.createHash("sha256").update(token).digest("hex"),
  label: "initial",
  createdAt: new Date().toISOString(),
}];

const record = opts.bucket
  ? {
      // BYO mode: dedicated bucket, credentials from flags or .env.
      provider: "r2",
      bucket: opts.bucket,
      binding: opts.binding,
      publicBaseUrl: opts["public-base-url"] ?? process.env.R2_PUBLIC_BASE_URL,
      tokens,
      accountId: opts["account-id"] ?? process.env.R2_ACCOUNT_ID,
      accessKeyId: opts["access-key-id"] ?? process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: opts["secret-access-key"] ?? process.env.R2_SECRET_ACCESS_KEY,
    }
  : {
      // Shared mode: a "<name>/" prefix in the shared bucket. No env credential
      // fallback — R2_* env keys are scoped to BYO buckets, and presigning
      // against the shared bucket is deferred (see the design spec).
      provider: "r2",
      bucket: SHARED.bucket,
      binding: opts.binding ?? SHARED.binding,
      prefix: `${name}/`,
      publicBaseUrl: opts["public-base-url"] ?? SHARED.publicBaseUrl,
      tokens,
      accountId: opts["account-id"],
      accessKeyId: opts["access-key-id"],
      secretAccessKey: opts["secret-access-key"],
    };
Object.keys(record).forEach((k) => record[k] === undefined && delete record[k]);
```

- [ ] **Step 3: Verify shared mode against local KV**

Run (from `apps/api`):
```bash
node scripts/add-workspace.mjs planck --local
pnpm exec wrangler kv key get ws:planck --binding REGISTRY --local
```
Expected: the second command prints a JSON record with `"bucket": "uploads-default"`, `"binding": "UPLOADS_DEFAULT"`, `"prefix": "planck/"`, `"publicBaseUrl": "https://storage.uploads.sh"`, a `tokens` array, and NO `accountId`/`accessKeyId`/`secretAccessKey` keys.

- [ ] **Step 4: Verify BYO mode against local KV**

Run (from `apps/api`):
```bash
node scripts/add-workspace.mjs byocheck --bucket custom-bucket --binding UPLOADS --local
pnpm exec wrangler kv key get ws:byocheck --binding REGISTRY --local
```
Expected: JSON with `"bucket": "custom-bucket"`, `"binding": "UPLOADS"`, and NO `prefix` key. (Run without `--env-file`, so no env credentials leak in.)

- [ ] **Step 5: Clean up the local test records**

Run (from `apps/api`):
```bash
pnpm exec wrangler kv key delete ws:planck --binding REGISTRY --local
pnpm exec wrangler kv key delete ws:byocheck --binding REGISTRY --local
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/scripts/add-workspace.mjs
git commit -m "feat(api): default new workspaces to shared-bucket prefix mode"
```

---

### Task 5: Documentation

**Files:**
- Modify: `AGENTS.md` (the "Workspaces (multi-tenant model)" section and the `workspace:add` line in "Commands")
- Modify: `README.md` only if it mentions `--bucket` being required or describes the one-bucket-per-workspace model (check with `grep -n "bucket" README.md`); otherwise leave it.

**Interfaces:**
- Consumes: final behavior from Tasks 1-4.
- Produces: docs matching reality. Nothing depends on this task.

- [ ] **Step 1: Update the Commands section in AGENTS.md**

Replace the line:

```
pnpm workspace:add <name> --bucket <bucket> [--binding X] [--local]
```

with:

```
pnpm workspace:add <name> [--bucket <bucket>] [--binding X] [--local]
```

- [ ] **Step 2: Update the Workspaces section in AGENTS.md**

In the "## Workspaces (multi-tenant model)" section, after the sentence ending "even `default` is just a registered tenant.", insert this paragraph:

```markdown
By default a workspace is a **`<name>/` prefix in the shared `uploads-default`
bucket** (binding `UPLOADS_DEFAULT`, public at `https://storage.uploads.sh`):
the record carries `prefix: "<name>/"` and creating one is a pure KV write.
The prefix is applied in exactly one place — `createStorage()` in
`packages/storage` (files-sdk instance prefix) — so route code and clients
never see it; public URLs are `https://storage.uploads.sh/<name>/<key>`.
Bring-your-own-bucket is the advanced case: register with `--bucket` and the
record points at a dedicated bucket (own binding or S3 credentials, own
`publicBaseUrl`, no prefix) — `buildinternet` on `buildinternet-dev` is the
reference example.
```

- [ ] **Step 3: Check README**

Run: `grep -n "bucket" README.md`
If any line documents `--bucket` as required or one-bucket-per-workspace, update it to match the AGENTS.md wording above. If nothing matches, skip.

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md README.md
git commit -m "docs: describe shared-bucket prefix workspaces"
```

---

## Post-merge production runbook (manual — NOT for implementation agents)

For Zach / the main session after this branch merges and deploys. Do not execute as part of the plan; it touches production KV and re-mints a live token.

1. Re-register `default` as a shared-bucket workspace (overwrites its record and mints a fresh token — the old token stops working):
   ```bash
   cd apps/api && node scripts/add-workspace.mjs default
   ```
2. Update `UPLOADS_TOKEN` in the main checkout's `.env` with the newly printed token (user edits `.env` by hand — agents must not).
3. The old `screenshots/` objects at the root of `uploads-default` (~196 B) predate the prefix model. Either delete them in the dashboard or re-upload them through the API so they land under `default/`.
4. Verify: `curl -H "Authorization: Bearer <token>" https://api.uploads.sh/v1/default/files` lists only prefixed content, and an uploaded file serves at `https://storage.uploads.sh/default/<key>`.
5. `buildinternet` workspace: no action.
