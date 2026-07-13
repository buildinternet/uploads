/**
 * Remote MCP tool set — the hosted subset of the CLI's stdio tools (put,
 * list, delete, health). Everything is scoped to the workspace resolved by
 * `workspaceAuth`; token scopes are enforced inside handlers, where a throw
 * becomes an isError tool result rather than a JSON-RPC error. Tools needing
 * a filesystem or the gh CLI (attach, comment, doctor) stay stdio-only.
 */
import { buildMarkdown, buildScreenshotKey } from "@buildinternet/uploads";
import {
  optPosInt,
  optString,
  optStringRecord,
  usage,
  type McpTool,
} from "@buildinternet/uploads/mcp";
import { badKey } from "@uploads/api/files";
import { validateMetadataEntries } from "@uploads/api/file-metadata";
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
          title: { type: "string", description: "Gallery title (1–120 characters)." },
          description: { type: "string", description: "Optional public gallery description." },
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
        properties: { galleryId: { type: "string", description: "Opaque gallery ID." } },
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
          objectKey: { type: "string", description: "Existing public object key to add." },
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
          provider: { type: "string", description: "External provider (currently github)." },
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
          provider: { type: "string", description: "External provider (currently github)." },
          coordinate: {
            type: "string",
            description: "Provider-native external reference coordinate.",
          },
          limit: { type: "number", description: "Page size (default 50, max 100)." },
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
        "Upload base64-encoded content to the workspace and get a public URL plus GitHub-ready embed markdown (the returned `markdown` is ready to paste into a PR or issue). The key defaults to <prefix>/<repo>/<ref>/<name>-<hash>.<ext>; pass `key` for an explicit path instead. Uploads are public regardless of GitHub repository visibility; explicit predictable keys must contain only non-sensitive media. The stored content type is sniffed from the bytes and restricted to the workspace's allowlist (images plus mp4/webm by default).",
      inputSchema: {
        type: "object",
        properties: {
          contentBase64: {
            type: "string",
            description: "Base64-encoded file content to upload (must be non-empty).",
          },
          filename: {
            type: "string",
            description: "Filename for the content (drives the key and content type).",
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
          alt: { type: "string", description: "Alt text for the markdown (default: filename)." },
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
        required: ["contentBase64", "filename"],
        additionalProperties: false,
      },
      async handler(args) {
        requireScope("files:write");
        await requireWriteBudget();
        const contentBase64 = optString(args, "contentBase64");
        const filename = optString(args, "filename");
        if (!contentBase64) usage("contentBase64 is required");
        if (!filename) usage("filename is required");

        const metadata = optStringRecord(args, "metadata");
        if (metadata) {
          try {
            validateMetadataEntries(metadata);
          } catch (err) {
            usage(err instanceof Error ? err.message : String(err));
          }
        }

        const explicitKey = optString(args, "key");
        const prefix = optString(args, "prefix");
        const repo = optString(args, "repo");
        const ref = optString(args, "ref");
        if (explicitKey && (prefix ?? repo ?? ref) !== undefined) {
          usage("key cannot be combined with prefix/repo/ref");
        }

        const bytes = decodeBase64(contentBase64, resolveUploadPolicy(workspace).maxBytes);

        const key =
          explicitKey ??
          // deriveRepoFromGit: false — no git (or child_process) on a worker.
          (await buildScreenshotKey({
            filename,
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
        const result = await putObject(
          env,
          workspace,
          key,
          bytes,
          workspaceName,
          metadata !== undefined ? { metadata } : undefined,
        );
        const markdown =
          result.url === null
            ? undefined
            : buildMarkdown(result.url, {
                alt: optString(args, "alt") ?? filename,
                width: optPosInt(args, "width"),
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
          limit: { type: "number", description: "Page size (default 100, max 1000)." },
          cursor: { type: "string", description: "Pagination cursor from a previous call." },
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
      name: "usage",
      description:
        "Workspace storage and monthly upload counters (and remaining headroom when budgets are configured).",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
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
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
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
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
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
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async handler() {
        return { ok: true };
      },
    },
  ];
}
