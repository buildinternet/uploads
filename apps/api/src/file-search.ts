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
 * Run the two-path name/metadata search. Callers must ensure at least one of
 * non-empty `filters` or `nameTerm` is set; this function does not re-check
 * that precondition. Always over-fetches by one so `truncated` is exact on
 * both the D1 and storage-walk paths (name filtering can drop rows, so the
 * probe sits on the source query, not the post-filter count).
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
  },
): Promise<{ matches: FileSearchMatch[]; truncated: boolean }> {
  const { nameTerm, pageSize, prefix } = opts;
  const filters = opts.filters;
  const hasMeta = filters !== undefined && Object.keys(filters).length > 0;
  const fetchLimit = pageSize + 1;

  if (hasMeta) {
    const found = await findObjectsByMetadata(env.DB, workspaceName, filters, {
      prefix,
      limit: fetchLimit,
      collapsePromotedShadows: opts.collapsePromotedShadows,
    });
    // Truncation is about the D1 window, not the post-name-filter count —
    // a name term can drop every row in the window while more matching-meta
    // keys still sit beyond the ORDER BY object_key LIMIT.
    const truncated = found.length > pageSize;
    const narrowed = nameTerm
      ? found.filter((match) => match.key.toLowerCase().includes(nameTerm))
      : found;
    return { matches: narrowed.slice(0, pageSize), truncated };
  }

  // Name alone — walk storage. `maxResults` stops as soon as the cap is hit.
  const store = await storage(env, record);
  const keys: string[] = [];
  for await (const file of store.search(nameTerm!, {
    match: "substring",
    caseInsensitive: true,
    maxResults: fetchLimit,
    ...(prefix ? { prefix } : {}),
  })) {
    keys.push(file.key);
  }
  const truncated = keys.length > pageSize;
  const pageKeys = keys.slice(0, pageSize);
  const metaByKey = await getMetadataForKeys(env.DB, workspaceName, pageKeys);
  return {
    matches: pageKeys.map((key) => ({ key, metadata: metaByKey.get(key) ?? {} })),
    truncated,
  };
}
