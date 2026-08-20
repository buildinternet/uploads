/**
 * Query-param sync for the account file browser's metadata search mode:
 *   /account/workspaces/<workspace>?meta.gh.repo=owner/name&meta.app=web
 *   /account/workspaces/<workspace>?name=screenshot
 *
 * Sibling to workspace-browse-url.ts (which owns folder `path`). Search mode
 * replaces `path` with a `name` term and/or one or more `meta.*` pairs.
 * Validation mirrors the API's META_KEY_RE / META_VALUE_MAX / SEARCH_NAME_MAX
 * so bad input is caught before a request.
 */
import { isBrowseWorkspace, workspaceFromPathname } from "./workspace-browse-url";

export interface MetaFilter {
  key: string;
  value: string;
}

/** Mirrors apps/api's META_KEY_RE (file-metadata.ts). */
const META_KEY_RE = /^[a-z][a-z0-9._-]{0,63}$/;
/** Mirrors apps/api's META_VALUE_MAX. */
const META_VALUE_MAX = 512;
/** Mirrors apps/api's META_MAX_KEYS — caps a hand-crafted deep link at the API's own limit. */
const META_MAX_FILTERS = 24;
/** Mirrors apps/api's SEARCH_NAME_MAX (routes/me.ts) — same 1–128 char cap the API enforces. */
const SEARCH_NAME_MAX = 128;

export function isValidMetaKey(key: string): boolean {
  return META_KEY_RE.test(key);
}

export function isValidMetaValue(value: string): boolean {
  if (value.length < 1 || value.length > META_VALUE_MAX) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return false; // printable ASCII only
  }
  return true;
}

/** Mirrors the API's normalizeSearchName length check: 1–128 chars after trimming. */
export function isValidSearchName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed.length <= SEARCH_NAME_MAX;
}

/** Parse `meta.*` params; first value wins per key, invalid pairs dropped. */
export function readSearchFilters(search: string): MetaFilter[] {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  const params = new URLSearchParams(raw);
  const seen = new Set<string>();
  const out: MetaFilter[] = [];
  for (const [param, value] of params) {
    if (out.length >= META_MAX_FILTERS) break;
    if (!param.startsWith("meta.")) continue;
    const key = param.slice("meta.".length);
    if (seen.has(key)) continue;
    seen.add(key);
    if (isValidMetaKey(key) && isValidMetaValue(value)) out.push({ key, value });
  }
  return out;
}

/** Parse the `name` param; missing, empty/whitespace-only, or overlong values are dropped. */
export function readSearchName(search: string): string | undefined {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  const params = new URLSearchParams(raw);
  const name = params.get("name");
  if (name === null) return undefined;
  return isValidSearchName(name) ? name : undefined;
}

/** Serialize filters (and an optional name term) to `meta.key=value&…` (no leading `?`). */
export function buildSearchQuery(filters: MetaFilter[], name?: string): string {
  const params = new URLSearchParams();
  if (name !== undefined && isValidSearchName(name)) params.set("name", name);
  for (const { key, value } of filters) params.set(`meta.${key}`, value);
  return params.toString();
}

/**
 * Write `name` and `meta.*` into the address bar (no history entry). Clears
 * `path` (search and folder-browse are mutually exclusive) and all prior
 * `name`/`meta.*` params. Workspace identity prefers the path-based route;
 * legacy `?ws=` is stripped when the pathname already carries the slug.
 */
export function replaceSearchLocation(
  workspace: string,
  filters: MetaFilter[],
  name?: string,
): void {
  if (typeof window === "undefined") return;
  const next = new URL(window.location.href);
  for (const param of Array.from(next.searchParams.keys())) {
    if (param.startsWith("meta.")) next.searchParams.delete(param);
  }
  next.searchParams.delete("name");
  next.searchParams.delete("path");
  const ws = isBrowseWorkspace(workspace) ? workspace : "";
  if (ws) {
    const filesPath = `/account/workspaces/${encodeURIComponent(ws)}/files`;
    if (next.pathname !== filesPath) {
      next.pathname = filesPath;
    }
    next.searchParams.delete("ws");
  } else {
    next.searchParams.delete("ws");
  }
  if (name !== undefined && isValidSearchName(name)) next.searchParams.set("name", name);
  for (const { key, value } of filters) {
    if (isValidMetaKey(key) && isValidMetaValue(value)) next.searchParams.set(`meta.${key}`, value);
  }
  const target = `${next.pathname}${next.search}${next.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (target !== current) window.history.replaceState(window.history.state, "", target);
}
