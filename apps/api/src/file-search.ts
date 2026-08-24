/**
 * Filename + metadata search shared by the session-authed `/me/.../files/search`
 * route, the token-authed `GET /v1/:workspace/files` route, and the hosted MCP
 * `find_files` tool (issue #528).
 *
 * Two paths: with metadata filters the D1 index is selective and a name term
 * narrows those rows in memory; name alone walks storage via files-sdk
 * `search()` (substring, never glob/regex). `truncated` is derived from the
 * underlying query's own cap — not the post-name-filter match count — so a
 * D1 window that has been fully consumed still reports truncated even when
 * no surviving rows match the name term (see 070f5cf6).
 */
import { ValidationError } from "@uploads/errors";
import {
  findObjectsByMetadata,
  getMetadataForKeys,
  validateMetadataFilters,
} from "./file-metadata";
import { storage } from "./storage";
import type { WorkspaceRecord } from "./workspace";
import { dbFor } from "./db-session";

/** Max characters accepted in a `?name=` / `name` filename search term. */
export const SEARCH_NAME_MAX = 128;

/** Default page size for token-route / MCP search (matches findObjectsByMetadata). */
export const FILE_SEARCH_DEFAULT_LIMIT = 50;
/** Hard cap on search page size. */
export const FILE_SEARCH_MAX_LIMIT = 500;

/**
 * Validate and normalize a filename search term. Lowercased here so the
 * substring comparison against object keys needs no per-row casing work.
 * Always passed to files-sdk as a `substring` pattern, never `glob` or
 * `regex`: glob would make `*` and `?` silently meaningful in a box where
 * people type filenames, and a user-supplied regex would be a
 * denial-of-service vector.
 */
export function normalizeSearchName(raw: string): string {
  const term = raw.trim();
  if (term.length === 0 || term.length > SEARCH_NAME_MAX) {
    throw new ValidationError("name must be 1–128 characters", {
      code: "file_search_invalid_name",
    });
  }
  return term.toLowerCase();
}

/** Clamp a caller-supplied limit into the allowed search page-size range. */
export function clampSearchLimit(limit: number | undefined): number {
  return Math.max(1, Math.min(limit ?? FILE_SEARCH_DEFAULT_LIMIT, FILE_SEARCH_MAX_LIMIT));
}

/**
 * Parse `meta.<key>=value` query params into a filters map. Duplicate-param
 * detection is query-string-specific (repeated same key), so it lives here
 * rather than in `validateMetadataFilters`; count cap + key format are
 * shared with MCP via that helper. Empty when no `meta.*` params.
 */
export function parseMetaQueryFilters(
  query: Record<string, string>,
  multiValues: (param: string) => string[] | undefined,
): Record<string, string> {
  const metaParamKeys = Object.keys(query).filter((k) => k.startsWith("meta."));
  const filters: Record<string, string> = {};
  for (const param of metaParamKeys) {
    const key = param.slice("meta.".length);
    const values = multiValues(param) ?? [];
    if (values.length > 1) {
      throw new ValidationError(`repeated metadata filter for key: ${key}`, {
        code: "file_metadata_duplicate_filter",
        details: { key },
      });
    }
    filters[key] = values[0] ?? query[param]!;
  }
  if (Object.keys(filters).length > 0) validateMetadataFilters(filters);
  return filters;
}

export interface FileSearchMatch {
  key: string;
  metadata: Record<string, string>;
}

/**
 * Which of the two search mechanics produced a cursor. A cursor minted on the
 * metadata path means "resume the D1 keyset scan"; one minted on the storage
 * walk means "resume the walk". Replaying one against the other would silently
 * change what the page means, so the path rides inside the cursor and is
 * checked on decode (issue #829 §4).
 */
export type FileSearchPath = "meta" | "name";

/** Cursor envelope version — bumped if the payload shape ever changes. */
const CURSOR_VERSION = 1;

/**
 * Cap on keys the storage walk may skip while resuming from a cursor. The
 * files-sdk `search()` iterator has no `startAfter`, so the name-only path
 * resumes with a bounded re-walk: it pages the bucket listing from the start of
 * the (optional) prefix and drops keys at or before the cursor key without
 * hydrating them. The skip is listing-only work, but it is O(offset), so it is
 * bounded here rather than left to grow with the page number. Callers that
 * need deeper pagination should narrow with `prefix` or a `meta.*` filter,
 * which routes to the D1 keyset path and has no such bound.
 */
export const SEARCH_WALK_RESUME_MAX_SKIP = 20_000;

interface CursorPayload {
  v: number;
  p: FileSearchPath;
  k: string;
}

function base64UrlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(text: string): string {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** Mint an opaque continuation cursor for the last key of a page. */
export function encodeSearchCursor(path: FileSearchPath, lastKey: string): string {
  const payload: CursorPayload = { v: CURSOR_VERSION, p: path, k: lastKey };
  return base64UrlEncode(JSON.stringify(payload));
}

/**
 * Decode a caller-supplied cursor, rejecting anything that is not a cursor this
 * service minted for `expectedPath`. Opaque to clients: the only supported use
 * is handing back the `cursor` a previous page returned, unchanged.
 */
export function decodeSearchCursor(raw: string, expectedPath: FileSearchPath): string {
  const invalid = () =>
    new ValidationError("cursor is not valid for this search", {
      code: "file_search_invalid_cursor",
    });
  let payload: CursorPayload;
  try {
    payload = JSON.parse(base64UrlDecode(raw)) as CursorPayload;
  } catch {
    throw invalid();
  }
  if (
    payload === null ||
    typeof payload !== "object" ||
    payload.v !== CURSOR_VERSION ||
    typeof payload.k !== "string" ||
    payload.k.length === 0
  ) {
    throw invalid();
  }
  // A metadata-path cursor replayed against the name-only walk (or vice versa)
  // is rejected rather than reinterpreted.
  if (payload.p !== expectedPath) throw invalid();
  return payload.k;
}

/** Which path a given request will take — callers need it to decode a cursor. */
export function searchPathFor(filters: Record<string, string> | undefined): FileSearchPath {
  return filters !== undefined && Object.keys(filters).length > 0 ? "meta" : "name";
}

/**
 * Run the two-path name/metadata search. Callers must ensure at least one of
 * non-empty `filters` or `nameTerm` is set; this function does not re-check
 * that precondition. Always over-fetches by one so `truncated` is exact on
 * both the D1 and storage-walk paths (name filtering can drop rows, so the
 * probe sits on the source query, not the post-filter count).
 *
 * `cursor` (opaque, from a previous page's `cursor`) resumes where that page
 * stopped. The returned `cursor` is non-null exactly when `truncated` is true,
 * and always points at the last key of the *source* window — not the last
 * surviving match — so a window whose rows were all dropped by the name term
 * still advances instead of replaying itself forever.
 */
export async function searchFilesByNameAndMeta(
  env: Env,
  record: WorkspaceRecord,
  workspaceName: string,
  opts: {
    filters?: Record<string, string>;
    nameTerm?: string;
    prefix?: string;
    pageSize: number;
    /** Drop promoted branch originals — the screenshots drill-in (see the
     * `files/search?collapse=promoted` route). Only affects the metadata path. */
    collapsePromotedShadows?: boolean;
    /** Opaque continuation from a previous page's `cursor`. */
    cursor?: string;
  },
): Promise<{ matches: FileSearchMatch[]; truncated: boolean; cursor: string | null }> {
  const { nameTerm, pageSize, prefix } = opts;
  const filters = opts.filters;
  const path = searchPathFor(filters);
  const hasMeta = path === "meta";
  const fetchLimit = pageSize + 1;
  const after = opts.cursor === undefined ? undefined : decodeSearchCursor(opts.cursor, path);

  if (hasMeta) {
    const found = await findObjectsByMetadata(dbFor(env), workspaceName, filters!, {
      prefix,
      limit: fetchLimit,
      collapsePromotedShadows: opts.collapsePromotedShadows,
      ...(after !== undefined ? { after } : {}),
    });
    // Truncation is about the D1 window, not the post-name-filter count —
    // a name term can drop every row in the window while more matching-meta
    // keys still sit beyond the ORDER BY object_key LIMIT.
    const truncated = found.length > pageSize;
    // The window this page consumes is the first `pageSize` rows — the extra
    // row is only a truncation probe. Name-filtering the consumed window (not
    // the probe row) is what keeps `cursor` and `items` in step: the cursor
    // points at the last consumed row, so nothing is served twice and nothing
    // between two pages is skipped.
    const window = found.slice(0, pageSize);
    const narrowed = nameTerm
      ? window.filter((match) => match.key.toLowerCase().includes(nameTerm))
      : window;
    // Continue from the last key of the window that was actually consumed, so
    // a name term that drops the whole window still moves the scan forward.
    const lastConsumed = truncated ? window[window.length - 1]!.key : undefined;
    return {
      matches: narrowed,
      truncated,
      cursor: lastConsumed === undefined ? null : encodeSearchCursor("meta", lastConsumed),
    };
  }

  // Name alone — walk storage. `maxResults` stops as soon as the cap is hit.
  // Resuming has to be done client-side of the iterator: files-sdk's `search()`
  // exposes `prefix`/`limit`/`maxResults` but no `startAfter`, so a continued
  // page re-walks the listing and drops keys at or before the cursor key. Those
  // skipped keys cost a listing page each and no metadata hydration, but the
  // work is still proportional to how deep the cursor sits — capped at
  // SEARCH_WALK_RESUME_MAX_SKIP. Ordering assumption: the walk yields keys in
  // lexicographic order (true for the R2/S3 listing this runs on), which is the
  // same order the D1 path uses.
  const store = await storage(env, record);
  const keys: string[] = [];
  let skipped = 0;
  for await (const file of store.search(nameTerm!, {
    match: "substring",
    caseInsensitive: true,
    ...(after === undefined ? { maxResults: fetchLimit } : {}),
    ...(prefix ? { prefix } : {}),
  })) {
    if (after !== undefined && file.key <= after) {
      skipped += 1;
      if (skipped > SEARCH_WALK_RESUME_MAX_SKIP) {
        throw new ValidationError("search cursor is too deep to resume", {
          code: "file_search_cursor_too_deep",
        });
      }
      continue;
    }
    keys.push(file.key);
    if (keys.length >= fetchLimit) break;
  }
  const truncated = keys.length > pageSize;
  const pageKeys = keys.slice(0, pageSize);
  const metaByKey = await getMetadataForKeys(dbFor(env), workspaceName, pageKeys);
  const lastKey = truncated ? pageKeys[pageKeys.length - 1] : undefined;
  return {
    matches: pageKeys.map((key) => ({ key, metadata: metaByKey.get(key) ?? {} })),
    truncated,
    cursor: lastKey === undefined ? null : encodeSearchCursor("name", lastKey),
  };
}
