/**
 * Server-side "attach an already-uploaded object" (issue #702): generalizes
 * `github-promote.ts`'s copy machinery from "sweep this branch's staged
 * prefix" to "copy this one explicit source key" — the source can be ANY
 * object already in the calling workspace's own bucket, not just a
 * branch-staged one. Same destination layout as promote (plain
 * `gh/<owner>/<name>/<pull|issues>/<num>/<filename>`, or the randomized
 * `gh/private/<id>/...` layout when the repo resolves to private mode), same
 * idempotent-overwrite contract, same "never leak internal error detail"
 * doctrine on copy failure.
 *
 * Metadata merge is ADDITIVE (preserve mode, PR #157's contract) rather than
 * promote's full replace: the source object's own D1 queryable metadata
 * rides along onto the destination, with `gh.repo`/`gh.kind`/`gh.number`/
 * `gh.ref` stamped fresh on top. This is deliberately different from
 * `github-promote.ts`'s `putObject({ metadata: {...} })` full-replace call
 * (which only ever inherits a staged file's own `gh.*` tags, never arbitrary
 * caller metadata) — an attach source can be any object with any metadata
 * (a bare `f/` upload's `path`/`viewport`/`state`, a prior attachment's own
 * `gh.*` tags, etc.), and all of it is worth preserving on the copy.
 *
 * Comment sync is the caller's job (`github-attach-service.ts` wires it in,
 * same "service composes route + comment sync" shape `promote --pr` already
 * uses at the CLI layer, just moved server-side so one API call does both).
 */
import { NotFoundError, ValidationError } from "@uploads/errors";
import { resolveEmbedBaseUrl, type Files, type StorageConfig } from "@uploads/storage";
import type { GhTargetKind } from "@uploads/comment-render";
import { ghKeyPrefix, ghPrivateAttachmentKey, sanitizeKeySegment } from "@uploads/comment-render";
import {
  badKey,
  deleteObject,
  filePageUrl,
  putObject,
  putOptsFromStoredObject,
  sanitizeKeyBasename,
} from "./files-core";
import { getFileMetadata, setFileMetadata } from "./file-metadata";
import { resolveGhKeyContextSafe } from "./github-private-prefix-service";
import { storage, storageConfig } from "./storage";
import { webOrigin } from "./web-url";
import type { WorkspaceRecord } from "./workspace";
import { dbFor } from "./db-session";

/** Single-key call to `Files["download"]` — pulled out so its return type
 * (the single-key `StoredFile` overload) is inferred rather than spelled out. */
async function downloadOne(store: Files, key: string) {
  return store.download(key);
}

export interface AttachTarget {
  /** "owner/name", already validated by the caller. */
  repo: string;
  kind: GhTargetKind;
  num: number;
}

export interface AttachExistingRequest {
  /** Object key, or an uploads.sh URL (storage host, embed host, or /f/ page) resolving to one. */
  source: string;
  target: AttachTarget;
  /** Delete the source after a successful copy. Defaults to false (copy, not move). */
  move?: boolean;
  /** Override the destination filename; defaults to the source key's basename. */
  filename?: string;
}

export interface AttachExistingResult {
  key: string;
  url: string | null;
  embedUrl: string | null;
  pageUrl?: string;
  moved: boolean;
  source: { key: string };
}

/**
 * Resolves `input` (a raw object key, or one of the three uploads.sh URL
 * spellings) to a key in the CALLING workspace's own bucket. Cross-workspace
 * URLs (a different `/f/<workspace>/` segment, or a URL that doesn't match
 * this workspace's storage/embed host at all) are rejected — attach only
 * ever reads from the caller's own workspace, same posture as every other
 * `files:write` route in this API.
 */
export async function resolveAttachSourceKey(
  env: Env,
  cfg: StorageConfig,
  workspaceName: string,
  input: string,
): Promise<string> {
  const trimmed = input.trim();
  if (!trimmed) throw new ValidationError("source must not be empty.", { code: "invalid_source" });

  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    // Not a URL — treat as a raw key.
    if (badKey(trimmed))
      throw new ValidationError("invalid source key.", { code: "invalid_source" });
    return trimmed;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ValidationError("source is not a valid URL.", { code: "invalid_source" });
  }

  const stripBase = (base: string | null): string | null => {
    if (!base) return null;
    let baseUrl: URL;
    try {
      baseUrl = new URL(base);
    } catch {
      return null;
    }
    if (url.origin !== baseUrl.origin) return null;
    const basePath = baseUrl.pathname.endsWith("/") ? baseUrl.pathname : `${baseUrl.pathname}/`;
    if (!url.pathname.startsWith(basePath)) return null;
    return url.pathname
      .slice(basePath.length)
      .split("/")
      .map((seg) => decodeURIComponent(seg))
      .join("/");
  };

  // Storage host — full public key including the workspace prefix, so strip
  // `cfg.prefix` back off after matching the base.
  const fromStorage = stripBase(cfg.publicBaseUrl ?? null);
  if (fromStorage !== null) {
    const prefix = cfg.prefix ?? "";
    if (prefix && fromStorage.startsWith(prefix)) return fromStorage.slice(prefix.length);
    if (!prefix) return fromStorage;
    throw new ValidationError("source URL does not belong to this workspace.", {
      code: "invalid_source",
    });
  }

  // Embed host twin of the storage host, same key shape.
  const embedBase = resolveEmbedBaseUrl(cfg.publicBaseUrl ?? undefined, undefined);
  const fromEmbed = stripBase(embedBase);
  if (fromEmbed !== null) {
    const prefix = cfg.prefix ?? "";
    if (prefix && fromEmbed.startsWith(prefix)) return fromEmbed.slice(prefix.length);
    if (!prefix) return fromEmbed;
    throw new ValidationError("source URL does not belong to this workspace.", {
      code: "invalid_source",
    });
  }

  // /f/<workspace>/<key> page URL — workspace segment must be THIS workspace.
  const webBase = `${webOrigin(env)}/f/${encodeURIComponent(workspaceName)}`;
  const fromPage = stripBase(webBase);
  if (fromPage !== null) return fromPage;

  throw new ValidationError("source URL does not resolve to an object in this workspace.", {
    code: "invalid_source",
  });
}

/**
 * Copy `req.source` (already resolved to a key by the caller — see
 * `resolveAttachSourceKey`) into `req.target`'s attachment prefix. Additive
 * metadata merge: the source's own D1 metadata rides along, `gh.repo`/
 * `gh.kind`/`gh.number`/`gh.ref` are stamped fresh on top. Idempotent —
 * re-attaching the same source to the same target overwrites the
 * destination key in place, same as promote.
 */
export async function attachExistingObject(
  env: Env,
  ws: WorkspaceRecord,
  workspaceName: string,
  req: AttachExistingRequest,
): Promise<AttachExistingResult> {
  const cfg = await storageConfig(env, ws);
  const sourceKey = await resolveAttachSourceKey(env, cfg, workspaceName, req.source);
  if (badKey(sourceKey))
    throw new ValidationError("invalid source key.", { code: "invalid_source" });

  const store = await storage(env, ws);
  let source: Awaited<ReturnType<typeof downloadOne>>;
  try {
    source = await downloadOne(store, sourceKey);
  } catch {
    throw new NotFoundError("source object not found.", { code: "source_not_found" });
  }

  const [owner, name] = req.target.repo.split("/");
  const sourceSegments = sourceKey.split("/").filter(Boolean);
  const sourceBasename = sourceSegments[sourceSegments.length - 1] ?? sourceKey;
  const filename = sanitizeKeyBasename(req.filename ?? sourceBasename);

  const mode = await resolveGhKeyContextSafe(
    env,
    workspaceName,
    { repo: req.target.repo, target: { kind: req.target.kind, num: req.target.num } },
    "attach",
  );

  const destKey =
    mode.mode === "private"
      ? ghPrivateAttachmentKey(mode.prefixId, req.target, filename)
      : `${ghKeyPrefix(req.target)}${sanitizeKeySegment(filename)}`;

  const sourceMeta = await getFileMetadata(dbFor(env), workspaceName, sourceKey);
  const bytes = new Uint8Array(await source.arrayBuffer());
  const ref = `${owner}/${name}#${req.target.num}`.toLowerCase();
  const nowIso = new Date().toISOString();

  const put = await putObject(env, ws, destKey, bytes, workspaceName, {
    ...putOptsFromStoredObject(source),
    surface: "attach",
  });

  // Additive merge (PR #157 preserve mode): the source's existing metadata
  // rides along unchanged, gh.* is stamped fresh on top and always wins.
  await setFileMetadata(dbFor(env), workspaceName, destKey, {
    ...sourceMeta,
    "gh.repo": `${owner}/${name}`.toLowerCase(),
    "gh.kind": req.target.kind,
    "gh.number": String(req.target.num),
    "gh.ref": ref,
    "gh.attached-at": nowIso,
  });

  if (req.move) {
    try {
      await deleteObject(env, ws, sourceKey, workspaceName);
    } catch (err) {
      // The copy already succeeded and is the object of record — a failed
      // source delete is reported by leaving `moved: false`, never by
      // failing the whole call (mirrors promote's "copy succeeded is final"
      // doctrine).
      console.error(
        JSON.stringify({
          message: "attach: move requested but source delete failed",
          sourceKey,
          destKey,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      return {
        key: destKey,
        url: put.url,
        embedUrl: put.embedUrl,
        ...(put.url && ws.name ? { pageUrl: filePageUrl(env, ws.name, destKey) } : {}),
        moved: false,
        source: { key: sourceKey },
      };
    }
  }

  return {
    key: destKey,
    url: put.url,
    embedUrl: put.embedUrl,
    ...(put.url && ws.name ? { pageUrl: filePageUrl(env, ws.name, destKey) } : {}),
    moved: req.move === true,
    source: { key: sourceKey },
  };
}
