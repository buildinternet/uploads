/**
 * By page filter bar: path input with autocomplete (Cmd/Ctrl-K, "/") that
 * also matches `screen` names, then Filters (Type, Device, Project, Merged
 * only) and a Grouped / Newest first icon toggle.
 */
import { Input } from "@uploads/ui";
import { LayoutGridIcon, Rows3Icon } from "lucide-react";
import { Kbd } from "@uploads/ui/components/ui/kbd";
import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { PathCatalogEntry } from "../../lib/api-client";
import type { SinceFilter } from "../../lib/files-view-state";
import {
  formatShotCount,
  pathSuggestions,
  type GroupBy,
  type RecentView,
} from "../../lib/workspace-screenshots";
import {
  FilterBar,
  FilterSection,
  MergedOnlyCheckbox,
  ScopeSelect,
  SinceSection,
  TypeSections,
  sinceChips,
  typeChips,
  type FilterChip,
  type TypeFilter,
} from "./FilterControls";

const LAYOUT_OPTIONS: { sort: RecentView; label: string; Icon: typeof Rows3Icon }[] = [
  { sort: "grouped", label: "Grouped by page", Icon: Rows3Icon },
  { sort: "recent", label: "Newest first", Icon: LayoutGridIcon },
];

export function PathFilterBar({
  project,
  q,
  path,
  sort,
  type,
  since,
  merged,
  projects,
  catalog,
  onProject,
  onQuery,
  onSort,
  onType,
  onSince,
  onPickPath,
  onMerged,
}: {
  project: string;
  q: string;
  /** Exact drill-in path, shown in the input so editing it widens the filter. */
  path: string;
  sort: RecentView;
  type: TypeFilter;
  since: SinceFilter | null;
  /** "Merged only" toggle (persisted PR merge-state tagging). */
  merged: boolean;
  projects: string[];
  /** Path catalog backing the input's autocomplete suggestions. */
  catalog: PathCatalogEntry[];
  onProject: (project: string) => void;
  onQuery: (q: string) => void;
  onSort: (sort: RecentView) => void;
  onType: (type: TypeFilter) => void;
  onSince: (since: SinceFilter | null) => void;
  onPickPath: (picked: { path: string; by: GroupBy }) => void;
  onMerged: (merged: boolean) => void;
}) {
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const value = path || q;
  // Exact drill-in state means the value already IS a suggestion — nothing
  // useful to offer until the user edits it back into a query.
  const suggestions = path ? [] : pathSuggestions(catalog, { project, q });
  const open = suggestOpen && suggestions.length > 0;
  // "Ctrl K" is the deterministic default so the server's render and the
  // client's first render agree bit-for-bit (no `navigator` at SSR time) —
  // corrected to "⌘K" after mount, once hydration has already reconciled.
  const [modKbd, setModKbd] = useState("Ctrl K");
  useEffect(() => {
    if (/Mac|iPhone|iPad|iPod/.test(navigator.userAgent)) setModKbd("⌘K");
  }, []);

  const pick = (picked: { path: string; by: GroupBy }) => {
    setSuggestOpen(false);
    setActive(-1);
    onPickPath(picked);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (!open) {
      if (event.key === "ArrowDown" && suggestions.length > 0) {
        event.preventDefault();
        setSuggestOpen(true);
        setActive(0);
      }
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => (i + 1) % suggestions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
    } else if (event.key === "Enter" && active >= 0 && suggestions[active]) {
      event.preventDefault();
      pick(suggestions[active]);
    } else if (event.key === "Escape") {
      setSuggestOpen(false);
      setActive(-1);
    }
  };

  const chips: FilterChip[] = [
    ...typeChips(type, onType),
    ...sinceChips(since, onSince),
    ...(project ? [{ key: "project", label: project, onRemove: () => onProject("") }] : []),
    ...(merged ? [{ key: "merged", label: "Merged only", onRemove: () => onMerged(false) }] : []),
  ];

  return (
    <FilterBar
      chips={chips}
      search={
        <div className="wsp-filter__qwrap relative flex flex-1 min-w-0">
          <Input
            id="wsp-path-filter"
            type="search"
            className={`wsp-filter__q flex-1 min-w-0 min-h-9 px-3 py-1.5 text-base sm:text-[13px] rounded-[6px] box-border${value === "" ? " sm:pr-14" : ""}`}
            aria-label="Filter by path or screen"
            aria-keyshortcuts="Meta+K Control+K Slash"
            aria-expanded={open}
            aria-controls="wsp-path-suggest"
            aria-activedescendant={active >= 0 ? `wsp-path-suggest-${active}` : undefined}
            role="combobox"
            placeholder="Search paths and screens"
            value={value}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            onChange={(event) => {
              setSuggestOpen(true);
              setActive(-1);
              onQuery(event.target.value);
            }}
            onFocus={() => setSuggestOpen(true)}
            onBlur={() => {
              // Delay so a mousedown on an option can land first.
              window.setTimeout(() => setSuggestOpen(false), 120);
            }}
            onKeyDown={onKeyDown}
          />
          {value === "" && (
            <Kbd className="max-sm:hidden absolute top-1/2 right-2.5 -translate-y-1/2">
              {modKbd}
            </Kbd>
          )}
          {open && (
            <ul
              className="wsp-suggest absolute top-[calc(100%+4px)] left-0 right-0 z-30 m-0 max-h-[280px] list-none overflow-y-auto rounded-[6px] border border-line bg-panel p-1 shadow-[0_8px_24px_rgb(0_0_0_/_0.25)]"
              id="wsp-path-suggest"
              role="listbox"
              aria-label="Paths"
            >
              {suggestions.map((entry, index) => (
                <li key={`${entry.by}\0${entry.path}`} role="presentation">
                  <button
                    type="button"
                    role="option"
                    id={`wsp-path-suggest-${index}`}
                    aria-selected={index === active}
                    className={`wsp-suggest__opt flex w-full items-baseline gap-3 rounded-sm border-0 bg-none px-2 py-1.5 text-left font-[inherit] text-inherit cursor-pointer ${index === active ? "is-active bg-bg" : ""}`}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      pick(entry);
                    }}
                    onMouseEnter={() => setActive(index)}
                  >
                    <span className="wsp-suggest__path text-[13px] font-semibold [overflow-wrap:anywhere]">
                      {entry.path}
                      {entry.by === "screen" && (
                        <span className="ml-2 text-[11px] font-normal text-muted-foreground">
                          screen
                        </span>
                      )}
                    </span>
                    <span className="wsp-suggest__count ml-auto text-[12px] whitespace-nowrap text-muted-foreground">
                      {formatShotCount(entry.count)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      }
      trailing={
        <div
          className="wsp-toggle flex flex-none items-stretch overflow-hidden rounded-[6px] border border-line box-border"
          role="group"
          aria-label="Layout"
        >
          {LAYOUT_OPTIONS.map(({ sort: option, label, Icon }) => (
            <button
              key={option}
              type="button"
              className="wsp-toggle__opt flex w-9 items-center justify-center border-0 bg-none text-muted-foreground cursor-pointer [&+&]:border-l [&+&]:border-line aria-pressed:bg-panel aria-pressed:text-fg hover:text-fg focus-visible:text-fg"
              aria-pressed={sort === option}
              aria-label={label}
              title={label}
              onClick={() => onSort(option)}
            >
              <Icon className="size-4" aria-hidden="true" />
            </button>
          ))}
        </div>
      }
    >
      <TypeSections value={type} onChange={onType} />
      {projects.length > 0 || project ? (
        <ScopeSelect
          label="Project"
          allLabel="All projects"
          value={project}
          options={projects}
          onChange={onProject}
        />
      ) : null}
      <SinceSection value={since} onChange={onSince} />
      {/* Persisted PR merge-state tagging: filters both the drill-in
          (meta.gh.merged=true) and the grouped overview (?merged=1). */}
      <FilterSection label="Pull requests">
        <MergedOnlyCheckbox checked={merged} onChange={onMerged} />
      </FilterSection>
    </FilterBar>
  );
}
