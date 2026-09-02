# Non-media file types Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept PDF, zip, gzip, MOV, and four text types (plain, markdown, CSV, JSON) on the hosted upload path, with text validated as declared-plus-plausible and everything else still sniffed.

**Architecture:** The security boundary stays in `apps/api/src/guards.ts`: sniffing gains four magic signatures, and `inspectUpload` gains a declared-type argument used only when sniffing returns null and the declared type is text. `putObject` resolves the declared type from the request header or the key's extension so old CLIs and the hosted MCP work unchanged. Ingest gets an explicit media-only gate. The CLI's MIME map (and its copy inside the comment renderer) learns the new extensions, and the optimizer skips sharp for known non-image extensions. Copy ships in a second PR after prod verification.

**Tech Stack:** TypeScript, Hono on Cloudflare Workers, vitest, pnpm workspaces, changesets.

**Spec:** `docs/superpowers/specs/2026-09-02-non-media-file-types-design.md`

## Global Constraints

- Accepted additions, exactly: `application/pdf`, `application/zip`, `application/gzip`, `video/quicktime`, `text/plain`, `text/markdown`, `text/csv`, `application/json`.
- Never accept `text/html`, `image/svg+xml`, XML, or JavaScript types.
- No new billing limit field: non-media uses `maxBytes`; `video/quicktime` uses `maxVideoBytes`.
- Ingest (`github-ingest.ts`) mirrors only `image/*` and `VIDEO_TYPES`.
- `packages/uploads/src/comment-render.generated.ts` is generated; regenerate with `node packages/uploads/scripts/inline-shared.mjs`, never hand-edit.
- Changeset header must be exactly `"@buildinternet/uploads": minor`.
- Commit messages: no attribution lines, no words like "comprehensive".
- Work from the worktree root `/Users/zachdunn/Code/uploads/.claude/worktrees/serene-newton-d2d0e1` on branch `claude/issue-925-planning-13dccd`.
- Run `pnpm run check` (lint + format) before each commit of `.ts` files; the pre-commit hook also runs `pnpm types`.

---

## PR 1: platform + client

### Task 1: Sniff PDF, zip, gzip, and MOV; widen the default allowlist

**Files:**

- Modify: `apps/api/src/guards.ts:20-38` (allowlist, `VIDEO_TYPES`), `apps/api/src/guards.ts:94-116` (`detectContentType`)
- Test: `apps/api/test/guards.test.ts`

**Interfaces:**

- Produces: `DEFAULT_ALLOWED_CONTENT_TYPES` (15 entries), `VIDEO_TYPES` includes `video/quicktime`, new exported `TEXT_CONTENT_TYPES: ReadonlySet<string>`, `detectContentType` returns the four new types.

- [ ] **Step 1: Write the failing tests**

Add to the `detectContentType` describe block in `apps/api/test/guards.test.ts` (fixtures next to the existing `PNG`/`JPEG` constants at the top of the file):

```ts
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // %PDF-1.7
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
const ZIP_EMPTY = new Uint8Array([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0]);
const GZIP = new Uint8Array([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0]);
```

```ts
it("recognizes the non-media binary types and MOV from their magic bytes", () => {
  expect(detectContentType(PDF)).toBe("application/pdf");
  expect(detectContentType(ZIP)).toBe("application/zip");
  expect(detectContentType(ZIP_EMPTY)).toBe("application/zip");
  expect(detectContentType(GZIP)).toBe("application/gzip");
  expect(detectContentType(ftyp("qt  "))).toBe("video/quicktime");
  // MP4 brands still map to mp4, not quicktime.
  expect(detectContentType(ftyp("isom"))).toBe("video/mp4");
});

it("does not sniff text: plain ASCII and UTF-8 bodies return null", () => {
  expect(detectContentType(new TextEncoder().encode("hello world\n"))).toBeNull();
  expect(detectContentType(new TextEncoder().encode('{"ok":true}'))).toBeNull();
});
```

Add to the `resolveUploadPolicy` describe block:

```ts
it("default allowlist includes the non-media families and quicktime", () => {
  const { allowed } = resolveUploadPolicy({});
  for (const t of [
    "application/pdf",
    "application/zip",
    "application/gzip",
    "video/quicktime",
    "text/plain",
    "text/markdown",
    "text/csv",
    "application/json",
  ]) {
    expect(allowed.has(t), t).toBe(true);
  }
  expect(allowed.has("text/html")).toBe(false);
  expect(allowed.has("image/svg+xml")).toBe(false);
});
```

Update the existing test `rejects a disallowed sniffed type with 415` (zip is now allowed by default) to use a restricted policy:

```ts
it("rejects a disallowed sniffed type with 415", () => {
  const imagesOnly = resolveUploadPolicy({ allowedContentTypes: ["image/png"] });
  const result = inspectUpload(ZIP, imagesOnly);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.status).toBe(415);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @uploads/api test guards`
Expected: the three new tests FAIL (`detectContentType` returns null for PDF; allowlist lacks `application/pdf`).

- [ ] **Step 3: Implement**

In `apps/api/src/guards.ts`, replace the allowlist block (lines 20-38) with:

```ts
/**
 * Intended payloads: static images, the short gif/video clips embedded in
 * GitHub repos, and the non-media artifacts agents produce (reports, logs,
 * JSON, archives). Deliberately excludes `image/svg+xml` and `text/html` —
 * storage.uploads.sh is a bare R2 custom domain with no Worker in front of
 * it, so the stored content type is the only control, and either of those
 * served inline can carry script (stored XSS on our own origin). Everything
 * below renders as inert text, opens in a sandboxed viewer (PDF), or has no
 * inline handler at all (zip/gzip).
 */
export const DEFAULT_ALLOWED_CONTENT_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "application/pdf",
  "application/zip",
  "application/gzip",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
];

const DEFAULT_ALLOWED_SET = new Set(DEFAULT_ALLOWED_CONTENT_TYPES);

/** Video content types the upload path (and poster generation) accepts. */
export const VIDEO_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime"]);

/**
 * Types with no magic bytes. Accepted only when the client declares one of
 * them and the body passes `looksLikeText` — see `inspectUpload`.
 */
export const TEXT_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
]);
```

In `detectContentType`, before the `return null;`, add:

```ts
// %PDF-
if (matches(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
// PK\x03\x04 (local file header), PK\x05\x06 (empty archive), PK\x07\x08 (spanned)
if (
  matches(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
  matches(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
  matches(bytes, [0x50, 0x4b, 0x07, 0x08])
) {
  return "application/zip";
}
// gzip member header
if (matches(bytes, [0x1f, 0x8b])) return "application/gzip";
```

And inside the existing `ftyp` branch, before `return "video/mp4";`:

```ts
if (brand === "qt  ") return "video/quicktime";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @uploads/api test guards`
Expected: PASS. Also run `pnpm --filter @uploads/api test` to catch the routes test `rejects a non-image payload with 415` (it sends zip bytes, now allowed). Fix that test in Task 4; for now note it fails.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/guards.ts apps/api/test/guards.test.ts
git commit -m "feat(api): sniff pdf, zip, gzip, and mov; widen the default allowlist"
```

### Task 2: `looksLikeText`, `contentTypeFromKey`, and `resolveDeclaredContentType`

**Files:**

- Modify: `apps/api/src/guards.ts` (new exports after `detectContentType`)
- Test: `apps/api/test/guards.test.ts`

**Interfaces:**

- Produces:
  - `looksLikeText(bytes: Uint8Array): boolean`
  - `contentTypeFromKey(key: string): string | undefined` (only the eight new types plus the existing media map; `undefined` for unknown extensions)
  - `resolveDeclaredContentType(header: string | undefined, key: string): string | undefined` (normalized header when specific, else key extension)

- [ ] **Step 1: Write the failing tests**

Add a new describe block in `apps/api/test/guards.test.ts` and extend the import list with `looksLikeText, contentTypeFromKey, resolveDeclaredContentType`:

```ts
describe("looksLikeText", () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  it("accepts ASCII and UTF-8 bodies", () => {
    expect(looksLikeText(enc("plain log line\n"))).toBe(true);
    expect(looksLikeText(enc("héllo — ünïcode ✓"))).toBe(true);
  });

  it("rejects NUL bytes and invalid UTF-8", () => {
    expect(looksLikeText(new Uint8Array([0x61, 0x00, 0x62]))).toBe(false);
    expect(looksLikeText(new Uint8Array([0xe9, 0x74, 0xe9]))).toBe(false); // Latin-1 "été"
    expect(looksLikeText(new Uint8Array(0))).toBe(false);
  });

  it("does not fail on a multibyte sequence cut by the 8 KiB sample boundary", () => {
    // 8190 ASCII bytes, then a 3-byte character straddling offset 8192.
    const body = enc("a".repeat(8190) + "€" + "tail".repeat(50));
    expect(looksLikeText(body)).toBe(true);
  });

  it("only samples the head: a NUL after 8 KiB is not inspected", () => {
    const body = new Uint8Array(9000).fill(0x61);
    body[8500] = 0;
    expect(looksLikeText(body)).toBe(true);
  });
});

describe("contentTypeFromKey", () => {
  it("maps the accepted non-media extensions", () => {
    expect(contentTypeFromKey("gh/o/r/pull/1/build.log")).toBe("text/plain");
    expect(contentTypeFromKey("a/notes.TXT")).toBe("text/plain");
    expect(contentTypeFromKey("a/out.jsonl")).toBe("text/plain");
    expect(contentTypeFromKey("a/config.yaml")).toBe("text/plain");
    expect(contentTypeFromKey("a/README.md")).toBe("text/markdown");
    expect(contentTypeFromKey("a/data.csv")).toBe("text/csv");
    expect(contentTypeFromKey("a/report.json")).toBe("application/json");
    expect(contentTypeFromKey("a/report.pdf")).toBe("application/pdf");
    expect(contentTypeFromKey("a/bundle.zip")).toBe("application/zip");
    expect(contentTypeFromKey("a/bundle.tgz")).toBe("application/gzip");
    expect(contentTypeFromKey("a/clip.mov")).toBe("video/quicktime");
    expect(contentTypeFromKey("a/shot.png")).toBe("image/png");
  });

  it("returns undefined for unknown or missing extensions and never maps html/svg", () => {
    expect(contentTypeFromKey("a/blob")).toBeUndefined();
    expect(contentTypeFromKey("a/page.html")).toBeUndefined();
    expect(contentTypeFromKey("a/icon.svg")).toBeUndefined();
    expect(contentTypeFromKey("a/dir.v2/")).toBeUndefined();
  });
});

describe("resolveDeclaredContentType", () => {
  it("prefers a specific header, normalized", () => {
    expect(resolveDeclaredContentType("Text/Plain; charset=utf-8", "a/x.json")).toBe("text/plain");
  });

  it("falls back to the key extension when the header is absent or octet-stream", () => {
    expect(resolveDeclaredContentType(undefined, "a/build.log")).toBe("text/plain");
    expect(resolveDeclaredContentType("application/octet-stream", "a/build.log")).toBe(
      "text/plain",
    );
    expect(resolveDeclaredContentType("", "a/build.log")).toBe("text/plain");
  });

  it("is undefined when neither source is specific", () => {
    expect(resolveDeclaredContentType(undefined, "a/blob")).toBeUndefined();
    expect(resolveDeclaredContentType("application/octet-stream", "a/blob")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @uploads/api test guards`
Expected: FAIL with "does not provide an export named looksLikeText" (or similar).

- [ ] **Step 3: Implement**

Add to `apps/api/src/guards.ts` directly after `detectContentType`:

```ts
/** Bytes inspected by `looksLikeText`. Enough to catch binaries; cheap on a 25 MB log. */
const TEXT_SAMPLE_BYTES = 8 * 1024;

/**
 * Plausibility check for declared text uploads (text has no magic bytes):
 * the first 8 KiB must contain no NUL and decode as UTF-8. A multibyte
 * sequence cut by the sample boundary is tolerated via streaming decode.
 */
export function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.byteLength === 0) return false;
  const sample = bytes.subarray(0, Math.min(bytes.byteLength, TEXT_SAMPLE_BYTES));
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return false;
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample, {
      stream: sample.length < bytes.byteLength,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Extension → content type for the key-extension fallback in
 * `resolveDeclaredContentType`. Mirrors `inferContentType` in
 * packages/uploads/src/embed.ts; keep the two in step. html/svg are absent on
 * purpose — they must never become a declared type.
 */
const CONTENT_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  pdf: "application/pdf",
  zip: "application/zip",
  gz: "application/gzip",
  tgz: "application/gzip",
  txt: "text/plain",
  text: "text/plain",
  log: "text/plain",
  jsonl: "text/plain",
  ndjson: "text/plain",
  yaml: "text/plain",
  yml: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  json: "application/json",
};

/** Content type implied by a key's extension, or undefined when unknown. */
export function contentTypeFromKey(key: string): string | undefined {
  const base = key.slice(key.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return undefined;
  return CONTENT_TYPE_BY_EXTENSION[base.slice(dot + 1).toLowerCase()];
}

/** Normalize a client Content-Type for allowlist compare (type/subtype only, lowercased). */
export function normalizeDeclaredContentType(raw: string): string {
  const beforeParams = raw.split(";", 1)[0] ?? raw;
  return beforeParams.trim().toLowerCase();
}

/**
 * The type a client *claims* for an upload: its Content-Type header when
 * specific, else the key's extension. Only consulted by `inspectUpload` for
 * text types (everything else is sniffed). `application/octet-stream` and an
 * empty header count as unspecified so older CLIs (which send octet-stream
 * for `.log`) and the hosted MCP (which sends no type) still resolve via the
 * key.
 */
export function resolveDeclaredContentType(
  header: string | undefined,
  key: string,
): string | undefined {
  const normalized = header ? normalizeDeclaredContentType(header) : "";
  if (normalized && normalized !== "application/octet-stream") return normalized;
  return contentTypeFromKey(key);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @uploads/api test guards`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/guards.ts apps/api/test/guards.test.ts
git commit -m "feat(api): text plausibility check and key-extension content-type fallback"
```

### Task 3: `inspectUpload` accepts declared text types

**Files:**

- Modify: `apps/api/src/guards.ts:194-252` (`UploadInspection`, `tooLarge`, `inspectUpload`)
- Test: `apps/api/test/guards.test.ts`, `apps/api/test/guards-video.test.ts`

**Interfaces:**

- Consumes: `TEXT_CONTENT_TYPES`, `looksLikeText`, `VIDEO_TYPES` from Tasks 1-2.
- Produces: `inspectUpload(bytes: Uint8Array, policy: UploadPolicy, declaredType?: string): UploadInspection`. The 413 `kind` is now `"image" | "video" | "file"`. The 415 error `details` is `{ allowed: string[]; declared?: string }`.

- [ ] **Step 1: Write the failing tests**

Add to the `inspectUpload` describe block in `apps/api/test/guards.test.ts`:

```ts
const text = new TextEncoder().encode("line one\nline two\n");

it("accepts a declared text type when the body is plausible text", () => {
  expect(inspectUpload(text, policy, "text/plain")).toEqual({
    ok: true,
    contentType: "text/plain",
  });
  expect(inspectUpload(new TextEncoder().encode('{"a":1}'), policy, "application/json")).toEqual({
    ok: true,
    contentType: "application/json",
  });
});

it("sniffed bytes win over a declared text type", () => {
  expect(inspectUpload(PNG, policy, "text/plain")).toEqual({ ok: true, contentType: "image/png" });
});

it("rejects declared text with binary bytes, an undeclared body, or a non-text declared type", () => {
  const binary = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
  for (const [bytes, declared] of [
    [binary, "text/plain"],
    [text, undefined],
    [text, "application/octet-stream"],
    [text, "text/html"],
    [text, "image/svg+xml"],
    [text, "application/xml"],
  ] as const) {
    const result = inspectUpload(bytes, policy, declared);
    expect(result.ok, `${declared}`).toBe(false);
    if (!result.ok) expect(result.status).toBe(415);
  }
});

it("honors a workspace allowlist that excludes text", () => {
  const imagesOnly = resolveUploadPolicy({ allowedContentTypes: ["image/png"] });
  const result = inspectUpload(text, imagesOnly, "text/plain");
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.status).toBe(415);
});

it("reports the declared type in the 415 details", () => {
  const result = inspectUpload(text, policy, "text/html");
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.details).toMatchObject({ declared: "text/html" });
    expect(result.error.details).toHaveProperty("allowed");
  }
});

it("caps non-media at maxBytes with kind file, and MOV at maxVideoBytes", () => {
  const tight = resolveUploadPolicy({ maxUploadBytes: 4, maxVideoUploadBytes: 1000 });
  const pdf = inspectUpload(PDF, tight);
  expect(pdf.ok).toBe(false);
  if (!pdf.ok) {
    expect(pdf.status).toBe(413);
    expect(pdf.error.details).toMatchObject({ kind: "file", contentType: "application/pdf" });
  }
  const mov = inspectUpload(ftyp("qt  "), tight);
  expect(mov).toEqual({ ok: true, contentType: "video/quicktime" });
});
```

Check `apps/api/test/guards-video.test.ts` still passes unchanged (it only uses mp4/webm).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @uploads/api test guards`
Expected: the declared-text tests FAIL (current `inspectUpload` ignores the third argument and returns 415 for text).

- [ ] **Step 3: Implement**

Replace `tooLarge`'s `kind` union and `inspectUpload` in `apps/api/src/guards.ts`:

```ts
/** Coarse family for 413 payloads and the optimizer/poster branches. */
export type UploadKind = "image" | "video" | "file";

export function uploadKind(contentType: string): UploadKind {
  if (VIDEO_TYPES.has(contentType)) return "video";
  if (contentType.startsWith("image/")) return "image";
  return "file";
}

/** The shared 413 rejection for both the pre-buffer and post-buffer size checks. */
function tooLarge(
  maxBytes: number,
  extra?: { contentType?: string; kind?: UploadKind },
): UploadRejection {
  return {
    ok: false,
    status: 413,
    error: new PayloadTooLargeError("payload too large", {
      code: "upload_too_large",
      details: { maxBytes, ...extra },
    }),
  };
}
```

```ts
/**
 * Validate a fully-buffered upload body against the policy. Sniffed bytes
 * decide the stored type whenever they can; `declaredType` (from the request
 * header or the key's extension — see `resolveDeclaredContentType`) is
 * consulted only when sniffing finds nothing and the claim is one of the
 * text types, which have no magic. Then the type-specific size cap.
 */
export function inspectUpload(
  bytes: Uint8Array,
  policy: UploadPolicy,
  declaredType?: string,
): UploadInspection {
  const detected = detectContentType(bytes);
  let contentType: string | null = null;
  if (detected !== null) {
    if (policy.allowed.has(detected)) contentType = detected;
  } else if (
    declaredType !== undefined &&
    TEXT_CONTENT_TYPES.has(declaredType) &&
    policy.allowed.has(declaredType) &&
    looksLikeText(bytes)
  ) {
    contentType = declaredType;
  }
  if (contentType === null) {
    return {
      ok: false,
      status: 415,
      error: new UnsupportedMediaTypeError("unsupported media type", {
        details: {
          allowed: [...policy.allowed],
          ...(declaredType !== undefined ? { declared: declaredType } : {}),
        },
      }),
    };
  }
  const maxBytes = maxBytesForContentType(policy, contentType);
  if (bytes.byteLength > maxBytes) {
    return tooLarge(maxBytes, { contentType, kind: uploadKind(contentType) });
  }
  return { ok: true, contentType };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @uploads/api test guards`
Expected: PASS (both `guards.test.ts` and `guards-video.test.ts`).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/guards.ts apps/api/test/guards.test.ts
git commit -m "feat(api): accept declared text types in inspectUpload"
```

### Task 4: Thread the declared type through `putObject` and the PUT route

**Files:**

- Modify: `apps/api/src/files-core.ts:401-478` (`putObject` opts + inspection call)
- Modify: `apps/api/src/routes/files-shared-handlers.ts:30-33` (delete local normalizer), `:65-77` (presign uses the shared one), `:225-232` (PUT `putOpts`)
- Test: `apps/api/test/routes-files.test.ts`

**Interfaces:**

- Consumes: `resolveDeclaredContentType`, `normalizeDeclaredContentType` from Task 2; `inspectUpload(bytes, policy, declared)` from Task 3.
- Produces: `putObject(..., opts: { declaredContentType?: string })`. When omitted, `putObject` still resolves via the key extension.

- [ ] **Step 1: Write the failing tests**

In `apps/api/test/routes-files.test.ts`, inside `describe("PUT /v1/:workspace/files upload guardrails")`, replace the zip-bytes 415 test and add the new cases:

```ts
it("rejects an unrecognized binary payload with 415", async () => {
  const { env } = await makeEnv();
  const res = await putShot(env, { body: new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04]) });
  expect(res.status).toBe(415);
});

it("stores a declared text/plain body as text/plain", async () => {
  const { env, bucket } = await makeEnv();
  const res = await putShot(env, {
    key: "reports/build.log",
    body: new TextEncoder().encode("ok 1\nok 2\n"),
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
  expect(res.status).toBe(201);
  expect((await res.json()).contentType).toBe("text/plain");
  expect(bucket.store.get("default/reports/build.log")?.contentType).toBe("text/plain");
});

it("resolves the text type from the key extension when the header is octet-stream (old CLIs)", async () => {
  const { env, bucket } = await makeEnv();
  const res = await putShot(env, {
    key: "reports/build.log",
    body: new TextEncoder().encode("ok\n"),
    headers: { "Content-Type": "application/octet-stream" },
  });
  expect(res.status).toBe(201);
  expect(bucket.store.get("default/reports/build.log")?.contentType).toBe("text/plain");
});

it("rejects text declared as html, and text under a key with no known extension", async () => {
  const { env } = await makeEnv();
  const html = new TextEncoder().encode("<!doctype html><script>1</script>");
  expect(
    (
      await putShot(env, {
        key: "pages/x.html",
        body: html,
        headers: { "Content-Type": "text/html" },
      })
    ).status,
  ).toBe(415);
  expect(
    (
      await putShot(env, {
        key: "pages/blob",
        body: new TextEncoder().encode("hello"),
        headers: { "Content-Type": "application/octet-stream" },
      })
    ).status,
  ).toBe(415);
});

it("stores a PDF and a zip by their sniffed types regardless of the header", async () => {
  const { env, bucket } = await makeEnv();
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a]);
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
  expect((await putShot(env, { key: "reports/r.pdf", body: pdf })).status).toBe(201);
  expect(bucket.store.get("default/reports/r.pdf")?.contentType).toBe("application/pdf");
  expect(
    (
      await putShot(env, {
        key: "reports/b.zip",
        body: zip,
        headers: { "Content-Type": "text/plain" },
      })
    ).status,
  ).toBe(201);
  expect(bucket.store.get("default/reports/b.zip")?.contentType).toBe("application/zip");
});
```

In `describe("POST /v1/:workspace/files/sign content-type policy")` add:

```ts
it("accepts a declared text/plain on presign", async () => {
  const { env } = await makeEnv();
  const res = await app.request(
    "/v1/default/files/sign",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ key: "reports/build.log", contentType: "text/plain" }),
    },
    env,
  );
  expect(res.status).not.toBe(415);
});
```

(Match the request shape used by the neighboring presign tests in that describe block; copy their body fields exactly.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @uploads/api test routes-files`
Expected: the text/plain PUT returns 415 today; FAIL.

- [ ] **Step 3: Implement**

`apps/api/src/files-core.ts`: add to `putObject`'s `opts` type, after `contentSha256`:

```ts
    /**
     * The client's claimed Content-Type (already normalized to type/subtype)
     * or undefined. Only text types are ever trusted, and only when sniffing
     * finds nothing — see `inspectUpload`. When omitted, the key's extension
     * is the claim, which is what the hosted MCP and older CLIs rely on.
     */
    declaredContentType?: string;
```

Replace the inspection line:

```ts
const declared = resolveDeclaredContentType(opts?.declaredContentType, finalKey);
const inspection = inspectUpload(bytes, resolveUploadPolicy(ws), declared);
if (!inspection.ok) throw inspection.error;
```

and add `resolveDeclaredContentType` to the `./guards` import in that file.

`apps/api/src/routes/files-shared-handlers.ts`: delete the local `normalizePresignContentType` (lines 30-33), import `normalizeDeclaredContentType` from `../guards`, and use it in `signFileHandler` where the local one was called. In `putFileHandler`, change `putOpts`:

```ts
const putOpts = {
  provenance,
  visibility,
  metadata,
  replace: wantReplace,
  surface: "api" as const,
  declaredContentType: c.req.header("Content-Type"),
};
```

(`resolveDeclaredContentType` normalizes, so passing the raw header is correct.) The idempotent path spreads `putOpts`, so it inherits the field.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @uploads/api test`
Expected: PASS across the api project. If `files-core.test.ts` or the MCP tests construct `putObject` opts with exact object equality, add `declaredContentType` there.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/files-core.ts apps/api/src/routes/files-shared-handlers.ts apps/api/test/routes-files.test.ts
git commit -m "feat(api): resolve the declared upload type from the header or key extension"
```

### Task 5: Ingest stays media-only

**Files:**

- Modify: `apps/api/src/github-ingest.ts:244-254`
- Test: `apps/api/src/github-ingest.test.ts`

**Interfaces:**

- Consumes: `uploadKind` from Task 3.

- [ ] **Step 1: Write the failing test**

Add next to the AVIF test in `apps/api/src/github-ingest.test.ts`:

```ts
it("media gate is image/video only: a PDF is a permanent skip even though the upload allowlist accepts it", async () => {
  const { env } = baseEnv();
  const ref: IngestSourceRef = { repo: REPO, kind: "pull", num: 7, source: "body" };
  const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a]);
  const fetchImpl = fakeFetch({
    [ASSET_ID]: () =>
      new Response(PDF, { status: 200, headers: { "content-type": "application/pdf" } }),
  });
  const { putImpl, calls } = spyPut();

  const summary = await reconcileIngestSource(env, ws, WS, ref, `see ${ASSET_URL}`, null, {
    fetchImpl,
    putImpl,
  });

  expect(calls).toHaveLength(0);
  expect(summary.skipped).toEqual([{ url: ASSET_URL, reason: "unsupported_media_type" }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @uploads/api test github-ingest`
Expected: FAIL — the PDF is now in the default allowlist, so `calls` has length 1.

- [ ] **Step 3: Implement**

In `apps/api/src/github-ingest.ts`, update the comment and gate:

```ts
// Media gate: the Screenshots view mirrors images and video only. A type
// must be in the workspace's own upload allowlist (`resolveUploadPolicy(ws)
// .allowed`, guards.ts — no shadow table) AND be an image/video family;
// PDFs and archives pasted into a PR are left on GitHub. Non-sniffable
// bytes or a type outside the gate is the same permanent
// `unsupported_media_type` skip either way.
const policy = resolveUploadPolicy(ws);
const sniffed = detectContentType(bytes);
if (!sniffed || !policy.allowed.has(sniffed) || uploadKind(sniffed) === "file") {
  return { kind: "skip", reason: "unsupported_media_type" };
}
```

Add `uploadKind` to the `./guards` import.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @uploads/api test github-ingest`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/github-ingest.ts apps/api/src/github-ingest.test.ts
git commit -m "fix(ingest): keep GitHub attachment mirroring to images and video"
```

### Task 6: Web recognizes `video/quicktime`

**Files:**

- Modify: `apps/web/src/lib/public-file.ts:62`
- Test: `apps/web/src/lib/public-file.test.ts:238-245`

- [ ] **Step 1: Write the failing test**

Extend the `fileKind` test:

```ts
expect(fileKind("video/quicktime")).toBe("video");
expect(fileKind("text/plain")).toBe("file");
expect(fileKind("application/zip")).toBe("file");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @uploads/web test public-file`
Expected: FAIL on quicktime.

- [ ] **Step 3: Implement**

```ts
const videoTypes = new Set(["video/mp4", "video/webm", "video/quicktime"]);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @uploads/web test public-file`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/public-file.ts apps/web/src/lib/public-file.test.ts
git commit -m "feat(web): treat video/quicktime as video on the file page"
```

### Task 7: CLI MIME map, comment renderer copy, and optimizer skip

**Files:**

- Modify: `packages/uploads/src/embed.ts:3-24`
- Modify: `packages/comment-render/src/index.ts:95-116` (the copied `inferContentType`)
- Regenerate: `packages/uploads/src/comment-render.generated.ts` via `node packages/uploads/scripts/inline-shared.mjs`
- Modify: `packages/uploads/src/optimize.ts:110-145, 210-228` (import `inferContentType`, delete `guessContentType`, early passthrough)
- Create: `packages/uploads/test/embed.test.ts`
- Test: `packages/uploads/test/optimize.test.ts`, `packages/uploads/test/github.test.ts`
- Create: `.changeset/non-media-file-types.md`

**Interfaces:**

- Produces: `inferContentType(filename)` returns the eight new types plus `video/webm`; `optimizeImageForUpload` returns `skippedReason: "not_image"` without touching sharp for a known non-image extension.

- [ ] **Step 1: Write the failing tests**

Create `packages/uploads/test/embed.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { inferContentType } from "../src/embed.js";

describe("inferContentType", () => {
  it("maps media and the accepted non-media extensions", () => {
    expect(inferContentType("shot.png")).toBe("image/png");
    expect(inferContentType("clip.webm")).toBe("video/webm");
    expect(inferContentType("clip.MOV")).toBe("video/quicktime");
    expect(inferContentType("report.pdf")).toBe("application/pdf");
    expect(inferContentType("bundle.zip")).toBe("application/zip");
    expect(inferContentType("bundle.tar.gz")).toBe("application/gzip");
    expect(inferContentType("bundle.tgz")).toBe("application/gzip");
    expect(inferContentType("build.log")).toBe("text/plain");
    expect(inferContentType("notes.txt")).toBe("text/plain");
    expect(inferContentType("events.jsonl")).toBe("text/plain");
    expect(inferContentType("config.yml")).toBe("text/plain");
    expect(inferContentType("README.md")).toBe("text/markdown");
    expect(inferContentType("data.csv")).toBe("text/csv");
    expect(inferContentType("lighthouse.json")).toBe("application/json");
  });

  it("falls back to octet-stream for unknown extensions", () => {
    expect(inferContentType("blob")).toBe("application/octet-stream");
    expect(inferContentType("page.html")).toBe("application/octet-stream");
  });
});
```

Add to `packages/uploads/test/optimize.test.ts`:

```ts
it("passes a known non-image extension through without probing", async () => {
  const bytes = new TextEncoder().encode("not an image");
  const result = await optimizeImageForUpload(bytes, "build.log");
  expect(result.optimized).toBe(false);
  expect(result.skippedReason).toBe("not_image");
  expect(result.contentType).toBe("text/plain");
  expect(result.filename).toBe("build.log");
  expect(result.bytes).toBe(bytes);
});
```

Add to the `attachmentsCommentBody` describe in `packages/uploads/test/github.test.ts`:

```ts
it("renders pdf, json, and zip items as link bullets, never as embeds", () => {
  const body = attachmentsCommentBody([
    { key: "gh/o/r/pull/1/lighthouse.json", url: "https://x.test/lighthouse.json" },
    {
      key: "gh/o/r/pull/1/report.pdf",
      url: "https://x.test/report.pdf",
      pageUrl: "https://uploads.sh/f/w/report.pdf",
    },
    { key: "gh/o/r/pull/1/dist.zip", url: "https://x.test/dist.zip" },
  ]);
  expect(body).toContain("- [lighthouse.json](https://x.test/lighthouse.json)");
  expect(body).toContain("- [report.pdf](https://uploads.sh/f/w/report.pdf)");
  expect(body).toContain("- [dist.zip](https://x.test/dist.zip)");
  expect(body).not.toContain("<img");
});
```

(If the renderer prefers `url` over `pageUrl` for bullets, assert whichever the existing `notes.txt` test shows; the point is the bullet form and no `<img>`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @buildinternet/uploads test embed optimize github`
Expected: `embed.test.ts` FAILS on `.log`/`.pdf`; the optimize test FAILS on `contentType` (currently octet-stream).

- [ ] **Step 3: Implement**

`packages/uploads/src/embed.ts` — replace the `switch`:

```ts
const CONTENT_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  pdf: "application/pdf",
  zip: "application/zip",
  gz: "application/gzip",
  tgz: "application/gzip",
  txt: "text/plain",
  text: "text/plain",
  log: "text/plain",
  jsonl: "text/plain",
  ndjson: "text/plain",
  yaml: "text/plain",
  yml: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  json: "application/json",
};

/**
 * Content type from a filename's extension. Mirrors `CONTENT_TYPE_BY_EXTENSION`
 * in apps/api/src/guards.ts (the server's key-extension fallback); keep the
 * two in step. `svg` stays here only so the optimizer can pass it through —
 * the server rejects it.
 */
export function inferContentType(filename: string): string {
  const ext = filename.includes(".")
    ? filename.slice(filename.lastIndexOf(".") + 1).toLowerCase()
    : "";
  return CONTENT_TYPE_BY_EXTENSION[ext] ?? "application/octet-stream";
}
```

`packages/comment-render/src/index.ts` — replace the copied `inferContentType` body with the same table and function (keep the "Copied from packages/uploads/src/embed.ts" comment). Then run:

```bash
node packages/uploads/scripts/inline-shared.mjs
```

`packages/uploads/src/optimize.ts`:

- `import { inferContentType } from "./embed.js";`
- delete `guessContentType` (lines ~210-228) and replace every `guessContentType(filename)` call with `inferContentType(filename)`.
- after the `looksLikeSvg` passthrough, add:

```ts
// A known non-image extension (log, pdf, zip, video…) never needs sharp.
// Unknown extensions still get probed so an extension-less screenshot is
// optimized as before.
const guessed = inferContentType(filename);
if (guessed !== "application/octet-stream" && !guessed.startsWith("image/")) {
  return passthrough(bytes, filename, guessed, "not_image");
}
```

Create `.changeset/non-media-file-types.md`:

```md
---
"@buildinternet/uploads": minor
---

`put` and `attach` accept non-media files: PDF, zip, gzip, MOV, and text (plain, markdown, CSV, JSON, logs). They upload as-is, skip image optimization, and appear in the managed comment as links. Requires the matching platform release.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @buildinternet/uploads test` and `node packages/uploads/scripts/inline-shared.mjs --check`
Expected: PASS; check exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/uploads/src/embed.ts packages/uploads/src/optimize.ts packages/comment-render/src/index.ts packages/uploads/src/comment-render.generated.ts packages/uploads/test/embed.test.ts packages/uploads/test/optimize.test.ts packages/uploads/test/github.test.ts .changeset/non-media-file-types.md
git commit -m "feat(cli): know the non-media extensions and skip the optimizer for them"
```

### Task 8: Hosted MCP `put` description and CLI help mention the families

**Files:**

- Modify: `apps/mcp/src/tools.ts:602` (description string)
- Modify: `packages/uploads/src/commands.ts:203-206` (put help paragraph)
- Test: `packages/uploads/test/cli-help.test.ts` (only if it snapshots the paragraph; update the snapshot)

- [ ] **Step 1: Edit the strings**

MCP description: append one sentence to the existing `put` description:

```
Accepts images (PNG, JPEG, GIF, WebP, AVIF), video (MP4, WebM, MOV), PDF, zip, gzip, and text (plain, markdown, CSV, JSON). HTML and SVG are rejected.
```

CLI help paragraph (replace the "Still images…" paragraph):

```
Still images (PNG/JPEG/…) are optimized to WebP by default (long edge capped,
high quality; EXIF stripped) so GitHub embeds stay lean. Original bytes are kept
when they are already smaller, animated, or not an image. Use --no-optimize to
upload as-is, or --keep-exif when image metadata matters for the discussion.
Non-media files (PDF, zip, gzip, logs, JSON, CSV, markdown) upload as-is and
show up in the managed comment as links. HTML and SVG are rejected.
```

- [ ] **Step 2: Run the help and MCP tests**

Run: `pnpm --filter @buildinternet/uploads test cli-help` and `pnpm --filter @uploads/mcp test`
Expected: PASS (update any snapshot that pins the old paragraph).

- [ ] **Step 3: Commit**

```bash
git add apps/mcp/src/tools.ts packages/uploads/src/commands.ts packages/uploads/test/cli-help.test.ts
git commit -m "docs: mention the accepted non-media families in put help and the MCP tool"
```

### Task 9: Full verification and PR

- [ ] **Step 1: Run everything**

```bash
pnpm run check && pnpm types && pnpm test
```

Expected: clean. Fix anything that fails before opening the PR.

- [ ] **Step 2: Local end-to-end**

Using the local stack recipe in `AGENTS.md` (dev server via `preview_start`, or `pnpm --filter @uploads/api dev`), PUT a `.log`, `.json`, `.pdf` (any real PDF), `.zip`, and a `.html` and confirm 201/201/201/201/415. Open one `/f/` page for the PDF and confirm the "Open" fallback renders.

- [ ] **Step 3: Open the PR**

Title: `feat: accept non-media uploads (PDF, zip, gzip, MOV, text)`. Body: link `#925`, summarize the decisions from the spec (declared-plus-plausible text, no new cap, ingest media-only, HTML/SVG still out), and list the prod verification steps from PR 2 Task 10 as a checklist. Do not request a CodeRabbit review unless asked; this is a security-relevant guard change, so say in the body that one is warranted and let Zach decide.

## PR 2: copy (after PR 1 is on prod)

### Task 10: Prod verification

- [ ] **Step 1: Confirm the API deploy**

```bash
gh run list --repo buildinternet/uploads --branch main --limit 3
```

- [ ] **Step 2: Upload each family with the released or local CLI**

From the worktree, with a workspace token in the environment:

```bash
printf 'line 1\nline 2\n' > /tmp/verify.log
printf '{"ok":true}' > /tmp/verify.json
pnpm --filter @buildinternet/uploads exec node dist/cli.js put /tmp/verify.log /tmp/verify.json --format json
```

Then one real PDF, one zip, one MOV, and one `.html` (expect `unsupported_media_type`). Open each `/f/` page. Attach the log and PDF to a scratch PR with `--pr` and confirm the managed comment shows link bullets. Note whether the MOV got a poster.

- [ ] **Step 3: Record results in the PR 1 thread**

Comment on PR 1 with the URLs and the MOV poster outcome.

### Task 11: Copy, skills, changelog

**Files:**

- Modify: `apps/web/src/content/docs/limits.mdx:79-80`
- Modify: `apps/web/src/pages/index.astro:785-790`
- Modify: `skills/github-screenshots/SKILL.md:44-46` and the "Use uploads.sh when" list
- Modify: `skills/uploads-cli/SKILL.md`, `docs/cli.md`, `AGENTS.md:209`, `README.md`, `apps/web/public/llms.txt`, `apps/web/public/llms-full.txt`, the docs hub page, `/docs/attach` (grep targets below)
- Create: `apps/web/src/content/changelog/non-media-file-types.md`

- [ ] **Step 1: Find every claim**

```bash
grep -rn "PNG, JPEG\|images and video\|image or video\|any file\|is coming\|More file types\|no SVG" apps/web/src apps/web/public skills docs README.md AGENTS.md VISION.md CONTRIBUTING.md --include='*.md' --include='*.mdx' --include='*.astro' --include='*.txt' --include='*.ts'
```

- [ ] **Step 2: Rewrite each**

`limits.mdx` Formats bullet:

```md
- **Formats:** images (PNG, JPEG, GIF, WebP, AVIF), video (MP4, WebM, MOV), PDF, zip, gzip, and
  text (plain, markdown, CSV, JSON, logs). SVG and HTML are not accepted because either can carry
  script when served inline.
```

`index.astro` feature card:

```html
<div class="feature">
  <h3>More than screenshots</h3>
  <p>
    PDFs, logs, JSON, and zips alongside images and video, so test reports and build output get the
    same stable URLs and land in the PR comment as links.
  </p>
</div>
```

`skills/github-screenshots/SKILL.md` "When gh --attach is enough" bullet:

```md
- The file is an image or video under 10 MB (video up to 100 MB on paid plans).
  `gh --attach` takes media only.
```

and add to "Use uploads.sh when":

```md
- The artifact is not media: a Lighthouse or test report, a log, JSON, a PDF, or
  a zip. `gh --attach` does not take those; `uploads put` does, and the managed
  comment links them.
```

Changelog `apps/web/src/content/changelog/non-media-file-types.md`:

```md
---
title: "Uploads take PDFs, logs, JSON, and zips"
date: 2026-09-0XT00:00:00Z
tags: [platform, cli]
---

The upload allowlist now covers PDF, zip, gzip, MOV, and text files (plain,
markdown, CSV, JSON, logs) alongside images and video. Test reports, Lighthouse
output, build logs, and bundles get the same stable URLs and appear in the PR's
attachments comment as links. Size caps are the plan's file cap; MOV uses the
video cap.

SVG and HTML stay out: served inline they can run script on our storage origin.
```

(Set the date to the merge day.) Follow `skills/docs-page-style` for the `.mdx` edit.

- [ ] **Step 3: Verify the site builds and the pages read right**

```bash
pnpm --filter @uploads/web exec astro check && pnpm run check
```

Open `/docs/limits`, `/`, and `/changelog` in the local preview and screenshot the limits bullet and the feature card for the PR body (use `/github-screenshots`).

- [ ] **Step 4: Commit and open PR 2**

```bash
git add -A apps/web/src skills docs README.md AGENTS.md apps/web/public
git commit -m "docs: say which non-media file types uploads.sh accepts"
```

Title: `docs: non-media file types are live`. Link `#925` and PR 1; close #925 from this PR.
