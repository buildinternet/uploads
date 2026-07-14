/**
 * Query-param sync for the account file browser's metadata search mode:
 *   /account/workspaces?ws=<workspace>&meta.gh.repo=owner/name&meta.app=web
 *
 * Sibling to workspace-browse-url.ts (which owns `ws` + `path`). Search mode
 * replaces `path` with one or more `meta.*` pairs. Validation mirrors the
 * API's META_KEY_RE / META_VALUE_MAX so bad input is caught before a request.
 */
import { isBrowseWorkspace } from "./workspace-browse-url";

export interface MetaFilter {
  key: string;
  value: string;
}

/** Mirrors apps/api's META_KEY_RE (file-metadata.ts). */
const META_KEY_RE = /^[a-z][a-z0-9._-]{0,63}$/;
/** Mirrors apps/api's META_VALUE_MAX. */
const META_VALUE_MAX = 512;

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

/** Parse `meta.*` params; first value wins per key, invalid pairs dropped. */
export function readSearchFilters(search: string): MetaFilter[] {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  const params = new URLSearchParams(raw);
  const seen = new Set<string>();
  const out: MetaFilter[] = [];
  for (const [param, value] of params) {
    if (!param.startsWith("meta.")) continue;
    const key = param.slice("meta.".length);
    if (seen.has(key)) continue;
    seen.add(key);
    if (isValidMetaKey(key) && isValidMetaValue(value)) out.push({ key, value });
  }
  return out;
}

/** Serialize filters to `meta.key=value&…` (no leading `?`). */
export function buildSearchQuery(filters: MetaFilter[]): string {
  const params = new URLSearchParams();
  for (const { key, value } of filters) params.set(`meta.${key}`, value);
  return params.toString();
}

/**
 * Write `ws` + `meta.*` into the address bar (no history entry). Clears
 * `path` (search and folder-browse are mutually exclusive) and all prior
 * `meta.*` params. Empty filters + empty workspace clears search entirely.
 */
export function replaceSearchLocation(workspace: string, filters: MetaFilter[]): void {
  if (typeof window === "undefined") return;
  const next = new URL(window.location.href);
  for (const param of Array.from(next.searchParams.keys())) {
    if (param.startsWith("meta.")) next.searchParams.delete(param);
  }
  next.searchParams.delete("path");
  const ws = isBrowseWorkspace(workspace) ? workspace : "";
  if (ws) next.searchParams.set("ws", ws);
  else next.searchParams.delete("ws");
  for (const { key, value } of filters) {
    if (isValidMetaKey(key) && isValidMetaValue(value)) next.searchParams.set(`meta.${key}`, value);
  }
  const target = `${next.pathname}${next.search}${next.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (target !== current) window.history.replaceState(window.history.state, "", target);
}
