/**
 * Suggestion rows for the workspace files filter bar's typeahead.
 *
 * All of the menu's decisions live here rather than in `WorkspaceFileTable`,
 * because the repo's test environment is node-only (no jsdom, no
 * @testing-library/react) — a component cannot be rendered in a test, but a
 * pure function can. Same split as `workspace-file-row.ts` and
 * `workspace-search-url.ts`.
 */
import type { FacetKey, FacetValue } from "./api-client";

export type Suggestion =
  /** Search filenames for the raw draft text. */
  | { kind: "name"; term: string }
  /** Select a metadata key, which then loads its values. */
  | { kind: "key"; key: string; count: number; distinctValues: number }
  /** Commit `key=value` as a filter. */
  | { kind: "value"; key: string; value: string; count: number }
  /** Non-selectable footer teaching the `key=value` syntax. */
  | { kind: "hint" }
  /** Non-selectable row shown when the workspace carries no metadata at all. */
  | { kind: "empty-facets" }
  /** Non-selectable row shown while a selected key's values are still loading. */
  | { kind: "loading" };

/**
 * Split a `key=value` draft. Only the first `=` separates, so values may
 * contain `=`. Returns null for bare text (no separator) or an empty key,
 * which is what routes the draft to filename search instead.
 */
export function parseDraft(draft: string): { key: string; value: string } | null {
  const eq = draft.indexOf("=");
  if (eq < 0) return null;
  const key = draft.slice(0, eq).trim();
  if (key.length === 0) return null;
  return { key, value: draft.slice(eq + 1).trim() };
}

export interface SuggestionInput {
  /** Raw input value. */
  draft: string;
  /** Workspace facet keys; `null` when the facets request failed or is in flight. */
  facets: FacetKey[] | null;
  /** Values for `selectedKey`; `null` when not loaded yet. */
  values: FacetValue[] | null;
  /** The key whose values are being browsed, when the draft is `key=…`. */
  selectedKey: string | null;
  /** Keys already committed as filters — never offered twice. */
  activeKeys: string[];
}

/**
 * Ordering is not this function's job: keys and values are returned in
 * whatever order they arrive in `facets`/`values`, which the `/files/facets`
 * route guarantees is `count DESC, name ASC`. This function preserves that
 * input order rather than re-sorting.
 */
export function buildSuggestions(input: SuggestionInput): Suggestion[] {
  const { draft, facets, values, selectedKey, activeKeys } = input;
  const trimmed = draft.trim();

  // `key=…` — browsing one key's values.
  if (selectedKey) {
    const parsed = parseDraft(draft);
    const partial = parsed?.value.toLowerCase() ?? "";
    if (!values) return [{ kind: "loading" }];
    return values
      .filter((row) => row.value.toLowerCase().includes(partial))
      .map((row) => ({
        kind: "value" as const,
        key: selectedKey,
        value: row.value,
        count: row.count,
      }));
  }

  // Facets unavailable — the bar still works, so teach the syntax and stop.
  if (facets === null) return [{ kind: "hint" }];
  if (facets.length === 0) return [{ kind: "empty-facets" }];

  const available = facets.filter((row) => !activeKeys.includes(row.key));
  const needle = trimmed.toLowerCase();
  const keyRows = (
    needle ? available.filter((row) => row.key.toLowerCase().includes(needle)) : available
  ).map((row) => ({
    kind: "key" as const,
    key: row.key,
    count: row.count,
    distinctValues: row.distinctValues,
  }));

  // Bare text: filename search leads, matching keys follow. No trailing hint —
  // the user is mid-thought and the row set already shows both options.
  if (trimmed) return [{ kind: "name", term: trimmed }, ...keyRows];

  // Empty input: the workspace's keys, plus the syntax hint as a footer.
  return [...keyRows, { kind: "hint" }];
}
