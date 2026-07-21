/**
 * Remote MCP tool set — the hosted subset of the CLI's stdio tools (put,
 * list, delete, health). Everything is scoped to the workspace resolved by
 * `workspaceAuth`; token scopes are enforced inside handlers, where a throw
 * becomes an isError tool result rather than a JSON-RPC error. Tools needing
 * a filesystem or the gh CLI (attach, comment, doctor) stay stdio-only.
 */
import { buildMarkdown, buildScreenshotKey } from "@buildinternet/uploads";
import {
  METADATA_DESCRIPTION,
  ToolBatchError,
  batchFailureMessage,
  mapBounded,
  metadataProp,
  optPosInt,
  optString,
  optStringArray,
  optStringRecord,
  usage,
  type McpTool,
} from "@buildinternet/uploads/mcp";
import { AppError, NotFoundError } from "@uploads/errors";
import { badKey } from "@uploads/api/files";
import {
  findObjectsByMetadata,
  getFileMetadata,
  META_MAX_KEYS,
  setFileMetadata,
  validateMetadataEntries,
  validateMetadataFilters,
} from "@uploads/api/file-metadata";
import { hasGithubTags, uploaderTags } from "@uploads/api/uploader-identity";
import {
  addExternalReference,
  addGalleryItem,
  createGallery,
  findGalleriesByReference,
  getGallery,
  listGalleryItems,
} from "@uploads/api/galleries";
import {
  encodeGalleryCursor,
  gallerySummary,
  hydrateOwnerGallery,
  referenceDto,
  unwrapMutation,
} from "@uploads/api/gallery-service";
import { parseExternalReference } from "@uploads/api/external-references";
import { publicUrl, storage, storageConfig } from "@uploads/api/storage";
import { deleteObject, listObjects, putObject } from "@uploads/api/files";
import { allowWrite, resolveUploadPolicy } from "@uploads/api/guards";
import { usageWithLimits } from "@uploads/api/budget";
import { reconcileWorkspaceUsage } from "@uploads/api/reconcile";
import { purgeExpiredObjects } from "@uploads/api/retention";
import { getWorkspaceUsage } from "@uploads/api/usage";
import type { FileScope, WorkspaceRecord } from "@uploads/api/workspace";

export interface RemoteToolContext {
  env: Env;
  workspace: WorkspaceRecord;
  workspaceName: string;
  authScopes: readonly FileScope[];
  /**
   * Better Auth user id behind the presented credential (OAuth JWT's `sub`,
   * or an `up_` token's `minting_user_id`) — same id the REST API's
   * `mintingUserId` context var carries. `null` for legacy/enrollment tokens
   * or JWTs with no `sub`. Threaded into `uploaderTags()` for uploader
   * attribution parity with the REST path (#340/#344, #345).
   */
  mintingUserId: string | null;
}

function decodeBase64(value: string, maxBytes: number): Uint8Array {
  // Pre-decode size gate: base64 encodes 3 bytes per 4 chars, so a string
  // longer than this cannot decode to a within-limit payload. Rejecting here
  // avoids materializing an oversized body in isolate memory; putObject's
  // inspectUpload remains the authoritative post-decode check.
  if (value.length > Math.ceil(maxBytes / 3) * 4 + 4) {
    usage(`contentBase64 exceeds the workspace upload limit (${maxBytes} bytes)`);
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    usage("contentBase64 must be valid base64");
  }
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

/** Max items per multi-file put call — bounds decoded bytes held in isolate memory. */
export const MAX_PUT_FILES = 20;
/** Bounded parallelism for batch writes (each is a D1 budget check + R2 put). */
const PUT_CONCURRENCY = 5;

interface PutFileItem {
  filename: string;
  contentBase64: string;
  alt?: string;
}

/** Validate the multi-file `files` argument shape (content, not paths — no filesystem here). */
function optPutFileItems(args: Record<string, unknown>): PutFileItem[] | undefined {
  const v = args.files;
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) usage("files must be an array of { filename, contentBase64 } objects");
  return v.map((entry, i) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      usage(`files[${i}] must be an object with filename and contentBase64`);
    }
    const rec = entry as Record<string, unknown>;
    for (const key of Object.keys(rec)) {
      if (!["filename", "contentBase64", "alt"].includes(key)) {
        usage(`files[${i}].${key} is not a valid property`);
      }
    }
    const { filename, contentBase64, alt } = rec;
    if (typeof filename !== "string" || !filename) usage(`files[${i}].filename is required`);
    if (typeof contentBase64 !== "string" || !contentBase64) {
      usage(`files[${i}].contentBase64 is required`);
    }
    if (alt !== undefined && typeof alt !== "string") usage(`files[${i}].alt must be a string`);
    return {
      filename,
      contentBase64,
      ...(typeof alt === "string" ? { alt } : {}),
    };
  });
}

/** Per-item failure detail, same shape as the CLI/stdio `failures[]` entries. */
function errorDetail(err: unknown): {
  message: string;
  code?: string;
  status?: number;
} {
  if (err instanceof AppError) {
    return { message: err.message, code: String(err.code), status: err.status };
  }
  return { message: err instanceof Error ? err.message : String(err) };
}

export function createRemoteTools(ctx: RemoteToolContext): McpTool[] {
  const { env, workspace, workspaceName } = ctx;

  function requireScope(scope: FileScope): void {
    // Authorization failure, not a usage error — no (USAGE) suffix in the tool result.
    if (!ctx.authScopes.includes(scope)) throw new Error(`forbidden: requires ${scope} scope`);
  }

  async function requireWriteBudget(): Promise<void> {
    // Mirrors the REST API's writeRateLimit middleware (guards.ts): plain
    // Error, not usage() — over-budget is not a caller mistake.
    if (!(await allowWrite(env, workspaceName))) throw new Error("rate limit exceeded");
  }

  function requiredString(args: Record<string, unknown>, name: string): string {
    const value = optString(args, name);
    if (!value) usage(name + " is required");
    return value;
  }

  /** Key format + object existence (shared by get_metadata / set_metadata). */
  async function requireExistingObjectKey(args: Record<string, unknown>): Promise<string> {
    const key = requiredString(args, "key");
    if (badKey(key)) usage("invalid key");
    const store = await storage(env, workspace);
    if (!(await store.exists(key))) throw new NotFoundError("object not found");
    return key;
  }

  async function ownerGallery(id: string) {
    const record = await getGallery(env.DB, workspaceName, id);
    if (!record) throw new Error("gallery not found");
    return hydrateOwnerGallery(
      env,
      workspace,
      record,
      await listGalleryItems(env.DB, workspaceName, id),
    );
  }

  return [
    {
      name: "gallery_create",
      description:
        "Create a public ordered media gallery in this workspace. The returned canonical URL is suitable for an agent response, but anyone who knows it can view the gallery and its media.",
      inputSchema: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Gallery title (1–120 characters).",
          },
          description: {
            type: "string",
            description: "Optional public gallery description.",
          },
        },
        required: ["title"],
        additionalProperties: false,
      },
      async handler(args) {
        requireScope("files:write");
        await requireWriteBudget();
        const result = unwrapMutation(
          await createGallery(env.DB, {
            workspace: workspaceName,
            title: requiredString(args, "title"),
            description: optString(args, "description"),
          }),
        );
        return ownerGallery(result.value.id);
      },
    },
    {
      name: "gallery_get",
      description:
        "Get a workspace-owned gallery, including its ordered media and canonical public URL. Gallery media is public to anyone with the URL.",
      inputSchema: {
        type: "object",
        properties: {
          galleryId: { type: "string", description: "Opaque gallery ID." },
        },
        required: ["galleryId"],
        additionalProperties: false,
      },
      async handler(args) {
        requireScope("files:read");
        return ownerGallery(requiredString(args, "galleryId"));
      },
    },
    {
      name: "gallery_add",
      description:
        "Add one existing, publicly served workspace object to a gallery. The tool reads the current version before writing and does not upload or delete the object.",
      inputSchema: {
        type: "object",
        properties: {
          galleryId: { type: "string", description: "Opaque gallery ID." },
          objectKey: {
            type: "string",
            description: "Existing public object key to add.",
          },
          caption: { type: "string", description: "Optional public caption." },
          altText: { type: "string", description: "Optional public alt text." },
        },
        required: ["galleryId", "objectKey"],
        additionalProperties: false,
      },
      async handler(args) {
        requireScope("files:write");
        await requireWriteBudget();
        const id = requiredString(args, "galleryId");
        const objectKey = requiredString(args, "objectKey");
        if (badKey(objectKey)) usage("invalid key");
        const gallery = await getGallery(env.DB, workspaceName, id);
        if (!gallery) throw new Error("gallery not found");
        const existing = (await listGalleryItems(env.DB, workspaceName, id)).find(
          (item) => item.object_key === objectKey,
        );
        if (existing) {
          const item = (await ownerGallery(id)).items.find((entry) => entry.id === existing.id);
          if (!item) throw new Error("gallery item not found");
          return item;
        }
        try {
          const [store, config] = await Promise.all([
            storage(env, workspace),
            storageConfig(env, workspace),
          ]);
          if (!(await store.exists(objectKey))) throw new Error("object not found");
          if (publicUrl(config, objectKey) === null) throw new Error("object has no public URL");
        } catch (err) {
          if (
            err instanceof Error &&
            ["object not found", "object has no public URL"].includes(err.message)
          ) {
            throw err;
          }
          throw new Error("gallery storage unavailable");
        }
        const result = unwrapMutation(
          await addGalleryItem(env.DB, workspaceName, id, {
            expectedVersion: gallery.version,
            objectKey,
            caption: optString(args, "caption"),
            altText: optString(args, "altText"),
          }),
        );
        const item = (await ownerGallery(id)).items.find((entry) => entry.id === result.value.id);
        if (!item) throw new Error("gallery item not found");
        return item;
      },
    },
    {
      name: "gallery_link",
      description:
        "Link a gallery to an external reference. Uses provider-neutral fields; github currently accepts owner/repo#number or a strict GitHub issue/PR URL. No GitHub credentials or API calls are used.",
      inputSchema: {
        type: "object",
        properties: {
          galleryId: { type: "string", description: "Opaque gallery ID." },
          provider: {
            type: "string",
            description: "External provider (currently github).",
          },
          coordinate: {
            type: "string",
            description: "Provider-native external reference coordinate.",
          },
        },
        required: ["galleryId", "provider", "coordinate"],
        additionalProperties: false,
      },
      async handler(args) {
        requireScope("files:write");
        await requireWriteBudget();
        const id = requiredString(args, "galleryId");
        const gallery = await getGallery(env.DB, workspaceName, id);
        if (!gallery) throw new Error("gallery not found");
        const parsed = parseExternalReference(args.provider, args.coordinate);
        if (!parsed.ok) usage(parsed.message);
        const result = unwrapMutation(
          await addExternalReference(env.DB, workspaceName, id, {
            expectedVersion: gallery.version,
            ...parsed.value,
          }),
        );
        return referenceDto(result.value);
      },
    },
    {
      name: "gallery_find_by_reference",
      description:
        "Find galleries in this workspace linked to an external reference. Returns canonical public gallery URLs without contacting the provider.",
      inputSchema: {
        type: "object",
        properties: {
          provider: {
            type: "string",
            description: "External provider (currently github).",
          },
          coordinate: {
            type: "string",
            description: "Provider-native external reference coordinate.",
          },
          limit: {
            type: "number",
            description: "Page size (default 50, max 100).",
          },
        },
        required: ["provider", "coordinate"],
        additionalProperties: false,
      },
      async handler(args) {
        requireScope("files:read");
        const parsed = parseExternalReference(args.provider, args.coordinate);
        if (!parsed.ok) usage(parsed.message);
        const page = await findGalleriesByReference(
          env.DB,
          workspaceName,
          parsed.value.normalizedKey,
          {
            limit: optPosInt(args, "limit"),
          },
        );
        return {
          galleries: page.galleries.map((gallery) => gallerySummary(env, gallery)),
          nextCursor: page.nextCursor ? encodeGalleryCursor(page.nextCursor) : null,
        };
      },
    },
    {
      name: "put",
      description:
        "Upload base64-encoded content to the workspace and get a public URL plus GitHub-ready embed markdown (the returned `markdown` is ready to paste into a PR or issue). Single file: pass `contentBase64` + `filename` (flat result). Multiple files: pass `files` (uploaded in parallel; returns `uploads` + `failures`, one bad item does not abort the rest). The key defaults to <prefix>/<repo>/<ref>/<name>-<hash>.<ext>; pass `key` for an explicit path instead (single-file only). Uploads are public regardless of GitHub repository visibility; explicit predictable keys must contain only non-sensitive media. The stored content type is sniffed from the bytes and restricted to the workspace's allowlist (images plus mp4/webm by default).",
      inputSchema: {
        type: "object",
        properties: {
          contentBase64: {
            type: "string",
            description:
              "Base64-encoded file content to upload (must be non-empty). Exactly one of contentBase64 or files is required.",
          },
          filename: {
            type: "string",
            description: "Filename for the content (drives the key and content type).",
          },
          files: {
            type: "array",
            items: {
              type: "object",
              properties: {
                filename: {
                  type: "string",
                  description: "Filename for this item (drives the key and content type).",
                },
                contentBase64: {
                  type: "string",
                  description: "Base64-encoded content for this item (must be non-empty).",
                },
                alt: {
                  type: "string",
                  description:
                    "Per-item alt text override (default: top-level alt, then filename).",
                },
              },
              required: ["filename", "contentBase64"],
              additionalProperties: false,
            },
            description: `Multiple files to upload in one call (max ${MAX_PUT_FILES} items). Cannot be combined with contentBase64, filename, or key; prefix/repo/ref/width/metadata apply to every item. Returns { uploads, failures } with per-item results.`,
          },
          key: {
            type: "string",
            description:
              "Explicit object key (default: <prefix>/<repo>/<ref>/<name>-<hash>.<ext>). Cannot be combined with prefix/repo/ref.",
          },
          prefix: {
            type: "string",
            description: "Key prefix for the default key layout (default: screenshots).",
          },
          repo: {
            type: "string",
            description: "owner/name repo segment for the default key layout (default: misc).",
          },
          ref: {
            type: "string",
            description: "PR/issue/branch key segment for the default key layout (default: today).",
          },
          alt: {
            type: "string",
            description: "Alt text for the markdown (default: filename).",
          },
          width: {
            type: "number",
            description: "Emit <img width=…> markdown instead of a plain image embed.",
          },
          metadata: {
            type: "object",
            additionalProperties: { type: "string" },
            description:
              "Queryable custom metadata (key→value), separate from provenance. Omit to leave any metadata already stored for this key untouched; pass an object (even {}) to fully replace it. Keys: lowercase, ^[a-z][a-z0-9._-]{0,63}$. Values: 1-512 printable ASCII characters. Caps: at most 24 keys, at most 8192 total key+value bytes. Suggested keys: app, url, page, device, resolution, commit, branch. `gh.*` is reserved by convention for GitHub PR/issue attachment context (repo/kind/number/ref), normally system-managed by the attach flow.",
          },
        },
        additionalProperties: false,
      },
      async handler(args) {
        requireScope("files:write");
        // One limiter hit per tool call, single or batch — the batch's cost
        // ceiling is bounded by MAX_PUT_FILES instead.
        await requireWriteBudget();
        const contentBase64 = optString(args, "contentBase64");
        const filename = optString(args, "filename");
        const items = optPutFileItems(args);
        const multi = items !== undefined;
        if (multi) {
          if (contentBase64 !== undefined || filename !== undefined) {
            usage("contentBase64/filename cannot be combined with files");
          }
          if (items.length === 0) usage("files must be a non-empty array");
          if (items.length > MAX_PUT_FILES) {
            usage(`files supports at most ${MAX_PUT_FILES} items per call`);
          }
          if (optString(args, "key")) usage("key cannot be combined with files");
        } else {
          if (!contentBase64) usage("contentBase64 is required");
          if (!filename) usage("filename is required");
        }

        let metadata = optStringRecord(args, "metadata");
        if (metadata) {
          try {
            validateMetadataEntries(metadata);
          } catch (err) {
            usage(err instanceof Error ? err.message : String(err));
          }
        }
        // Uploader attribution (issue #345, parity with the REST PUT hook in
        // apps/api/src/routes/files.ts): gh.*-tagged uploads get server-derived
        // `gh.uploader`/`gh.uploader-id` stamped from the OAuth JWT's (or
        // up_ token's) minting user, spread AFTER the tool-supplied pairs so
        // a caller can't spoof those keys. Applied once for the whole call —
        // metadata (like prefix/repo/ref) applies to every item in a batch.
        if (metadata && hasGithubTags(metadata)) {
          const uploader = await uploaderTags(env, ctx.mintingUserId);
          if (uploader) {
            // Never let attribution break an upload that was valid without
            // it: drop the server tags if the merge would exceed the cap.
            const merged = { ...metadata, ...uploader };
            if (Object.keys(merged).length <= META_MAX_KEYS) metadata = merged;
          }
        }

        const explicitKey = optString(args, "key");
        const prefix = optString(args, "prefix");
        const repo = optString(args, "repo");
        const ref = optString(args, "ref");
        if (explicitKey && (prefix ?? repo ?? ref) !== undefined) {
          usage("key cannot be combined with prefix/repo/ref");
        }

        const policy = resolveUploadPolicy(workspace);
        // Pre-decode gate uses the policy ceiling (video caps can exceed
        // maxBytes); putObject's inspectUpload enforces the content-specific
        // limit after sniffing, so an over-cap image still fails per item.
        const maxBytes = Math.max(policy.maxBytes, policy.maxVideoBytes);
        const alt = optString(args, "alt");
        const width = optPosInt(args, "width");
        const putOpts = metadata !== undefined ? { metadata } : undefined;

        if (multi) {
          // Decode (and size-gate) every item before any write, so a
          // structurally invalid batch fails whole with a usage error
          // instead of leaving partial writes behind.
          const decoded = items.map((item, i) => {
            try {
              return decodeBase64(item.contentBase64, maxBytes);
            } catch (err) {
              usage(
                `files[${i}] (${item.filename}): ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          });
          // Keys are deterministic (sanitized name + content hash), so two
          // items can collide — e.g. the same file listed twice. Reject
          // before any write: concurrent same-key puts would double-count
          // the usage ledger and report more uploads than stored objects.
          const keys = await Promise.all(
            decoded.map((bytes, i) =>
              buildScreenshotKey({
                filename: items[i]!.filename,
                fileBytes: bytes,
                prefix,
                repo,
                ref,
                deriveRepoFromGit: false,
              }),
            ),
          );
          const firstIndexByKey = new Map<string, number>();
          keys.forEach((key, i) => {
            const first = firstIndexByKey.get(key);
            if (first === undefined) {
              firstIndexByKey.set(key, i);
              return;
            }
            usage(
              `files[${i}] (${items[i]!.filename}) resolves to the same key as files[${first}] (${items[first]!.filename}): ${key}`,
            );
          });
          type Slot =
            | { ok: true; upload: Record<string, unknown> }
            | { ok: false; file: string; err: unknown };
          const slots: Slot[] = await mapBounded(items, PUT_CONCURRENCY, async (item, i) => {
            try {
              const result = await putObject(
                env,
                workspace,
                keys[i]!,
                decoded[i]!,
                workspaceName,
                putOpts,
              );
              const markdown =
                result.url === null
                  ? undefined
                  : buildMarkdown(result.url, {
                      alt: item.alt ?? alt ?? item.filename,
                      width,
                    });
              return {
                ok: true,
                upload: { file: item.filename, ...result, markdown },
              };
            } catch (err) {
              return { ok: false, file: item.filename, err };
            }
          });
          const uploads = slots.flatMap((slot) => (slot.ok ? [slot.upload] : []));
          const failures = slots.flatMap((slot) =>
            slot.ok ? [] : [{ file: slot.file, error: errorDetail(slot.err) }],
          );
          if (uploads.length === 0 && failures.length > 0) {
            // Total failure → isError with structuredContent, same as stdio.
            throw new ToolBatchError(batchFailureMessage(failures), {
              workspace: workspaceName,
              uploads,
              failures,
            });
          }
          return { workspace: workspaceName, uploads, failures };
        }

        const bytes = decodeBase64(contentBase64!, maxBytes);

        const key =
          explicitKey ??
          // deriveRepoFromGit: false — no git (or child_process) on a worker.
          (await buildScreenshotKey({
            filename: filename!,
            fileBytes: bytes,
            prefix,
            repo,
            ref,
            deriveRepoFromGit: false,
          }));

        // Key/body validation and the size/type guardrails live in putObject,
        // shared with the REST API — the stored content type is sniffed there.
        // metadata is undefined when omitted (leave existing D1 rows
        // untouched); passing opts only when defined preserves that.
        const result = await putObject(env, workspace, key, bytes, workspaceName, putOpts);
        const markdown =
          result.url === null
            ? undefined
            : buildMarkdown(result.url, {
                alt: alt ?? filename!,
                width,
              });
        return { workspace: workspaceName, ...result, markdown };
      },
    },
    {
      name: "list",
      description:
        "List uploaded objects in the workspace, optionally filtered by key prefix. Paginate with cursor; each item includes its public URL when the workspace has one.",
      inputSchema: {
        type: "object",
        properties: {
          prefix: { type: "string", description: "Key prefix filter." },
          limit: {
            type: "number",
            description: "Page size (default 100, max 1000).",
          },
          cursor: {
            type: "string",
            description: "Pagination cursor from a previous call.",
          },
        },
        additionalProperties: false,
      },
      async handler(args) {
        requireScope("files:read");
        return listObjects(env, workspace, {
          prefix: optString(args, "prefix"),
          limit: optPosInt(args, "limit"),
          cursor: optString(args, "cursor"),
        });
      },
    },
    {
      name: "delete",
      description: "Delete an uploaded object in the workspace by key.",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "Object key to delete." },
        },
        required: ["key"],
        additionalProperties: false,
      },
      async handler(args) {
        requireScope("files:delete");
        await requireWriteBudget();
        const key = optString(args, "key");
        if (!key) usage("key is required");
        return deleteObject(env, workspace, key, workspaceName);
      },
    },
    {
      name: "get_metadata",
      description:
        "Read an object's queryable custom metadata (D1 key-value pairs, not R2 provenance). Returns `{ metadata }` (empty when none). Object must exist. Same as `uploads meta get`.",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "Object key to inspect." },
        },
        required: ["key"],
        additionalProperties: false,
      },
      async handler(args) {
        requireScope("files:read");
        const key = await requireExistingObjectKey(args);
        return { metadata: await getFileMetadata(env.DB, workspaceName, key) };
      },
    },
    {
      name: "set_metadata",
      description:
        "Merge-set and/or delete an object's queryable custom metadata (D1 key-value pairs, not R2 provenance). `set` wins over `delete` for the same key. " +
        METADATA_DESCRIPTION +
        " Requires at least one of `set` or `delete`. Same as `uploads meta set`.",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "Object key to update." },
          set: {
            ...metadataProp,
            description: "Keys to set/overwrite. " + METADATA_DESCRIPTION,
          },
          delete: {
            type: "array",
            items: { type: "string" },
            description: "Keys to remove.",
          },
        },
        required: ["key"],
        additionalProperties: false,
      },
      async handler(args) {
        requireScope("files:write");
        await requireWriteBudget();
        const set = optStringRecord(args, "set");
        const del = optStringArray(args, "delete");
        if ((!set || Object.keys(set).length === 0) && (!del || del.length === 0)) {
          usage("set_metadata requires set and/or delete");
        }
        const key = await requireExistingObjectKey(args);
        return {
          metadata: await setFileMetadata(env.DB, workspaceName, key, set ?? {}, del ?? []),
        };
      },
    },
    {
      name: "find_files",
      description:
        "Find objects in the workspace whose queryable custom metadata matches ALL of `filters` (ANDed equality). Returns each match's key, public URL, and full metadata map. Same as the CLI/local MCP's `find_files` tool.",
      inputSchema: {
        type: "object",
        properties: {
          filters: {
            ...metadataProp,
            description: "Metadata equality filters (at least one pair). " + METADATA_DESCRIPTION,
          },
          prefix: {
            type: "string",
            description: "Key prefix filter, combinable with filters.",
          },
          limit: {
            type: "number",
            description: "Page size (default 50, max 500).",
          },
        },
        required: ["filters"],
        additionalProperties: false,
      },
      async handler(args) {
        requireScope("files:read");
        const filters = optStringRecord(args, "filters");
        if (!filters || Object.keys(filters).length === 0) {
          usage("filters must have at least one key");
        }
        // Shares the count cap + key-format checks with the REST list endpoint's meta.* filters.
        validateMetadataFilters(filters);
        const [cfg, matches] = await Promise.all([
          storageConfig(env, workspace),
          findObjectsByMetadata(env.DB, workspaceName, filters, {
            prefix: optString(args, "prefix"),
            limit: optPosInt(args, "limit"),
          }),
        ]);
        return {
          items: matches.map((match) => ({
            key: match.key,
            url: publicUrl(cfg, match.key),
            metadata: match.metadata,
          })),
          cursor: null,
        };
      },
    },
    {
      name: "usage",
      description:
        "Workspace storage and monthly upload counters (and remaining headroom when budgets are configured).",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      async handler() {
        requireScope("files:read");
        const snapshot = await getWorkspaceUsage(env.DB, workspaceName);
        return usageWithLimits(snapshot, workspace);
      },
    },
    {
      name: "reconcile",
      description:
        "Rebuild usage ledger bytes/objects from storage (source of truth). Preserves the monthly upload counter. Requires files:write.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      async handler() {
        requireScope("files:write");
        await requireWriteBudget();
        const result = await reconcileWorkspaceUsage(env, workspace, workspaceName);
        return {
          ...result,
          usage: usageWithLimits(result.usage, workspace),
        };
      },
    },
    {
      name: "purge_expired",
      description:
        "Delete objects older than the workspace retentionDays setting, then reconcile. Skips if retention is unset. Requires files:delete.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      async handler() {
        requireScope("files:delete");
        await requireWriteBudget();
        const result = await purgeExpiredObjects(env, workspace, workspaceName);
        if ("skipped" in result) return result;
        return {
          ...result,
          reconcile: {
            ...result.reconcile,
            usage: usageWithLimits(result.reconcile.usage, workspace),
          },
        };
      },
    },
    {
      name: "health",
      description: "Check uploads.sh MCP server liveness. No scope required.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      async handler() {
        return { ok: true };
      },
    },
  ];
}
