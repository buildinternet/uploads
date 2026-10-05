/**
 * By page filter bar: project select, path input with autocomplete
 * (Cmd/Ctrl-K, "/"), Grouped/Recent, Merged only. Moved from
 * ScreenshotsByPath.tsx. The Type select leads the bar.
 */
import type { FileTypeClass } from "@uploads/comment-render/scope";
import { Input, Select } from "@uploads/ui";
import { Kbd } from "@uploads/ui/components/ui/kbd";
import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { PathCatalogEntry } from "../../lib/api-client";
import { formatShotCount, pathSuggestions, type RecentView } from "../../lib/workspace-screenshots";
import { TypeSelect } from "./FilterControls";

export function PathFilterBar({
  project,
  q,
  path,
  sort,
  type,
  merged,
  projects,
  catalog,
  onProject,
  onQuery,
  onSort,
  onType,
  onPickPath,
  onMerged,
}: {
  project: string;
  q: string;
  /** Exact drill-in path, shown in the input so editing it widens the filter. */
  path: string;
  sort: RecentView;
  type: FileTypeClass | null;
  /** "Merged only" toggle (persisted PR merge-state tagging). */
  merged: boolean;
  projects: string[];
  /** Path catalog backing the input's autocomplete suggestions. */
  catalog: PathCatalogEntry[];
  onProject: (project: string) => void;
  onQuery: (q: string) => void;
  onSort: (sort: RecentView) => void;
  onType: (type: FileTypeClass | null) => void;
  onPickPath: (path: string) => void;
  onMerged: (merged: boolean) => void;
}) {
  const options = project && !projects.includes(project) ? [...projects, project] : projects;
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

  const pick = (picked: string) => {
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
      pick(suggestions[active].path);
    } else if (event.key === "Escape") {
      setSuggestOpen(false);
      setActive(-1);
    }
  };

  return (
    <div className="wsp-filter flex flex-wrap items-stretch gap-2">
      <TypeSelect value={type} onChange={onType} />
      <Select
        className="ul-select--sm wsp-filter__project flex-[0_1_16rem] min-w-[12rem] max-w-full min-h-9 text-base sm:text-[13px] box-border"
        aria-label="Filter by project"
        value={project}
        onChange={(event) => onProject(event.target.value)}
      >
        <option value="">All projects</option>
        {options.map((label) => (
          <option key={label} value={label}>
            {label}
          </option>
        ))}
      </Select>
      <div className="wsp-filter__qwrap relative flex flex-[1_1_16rem] min-w-0">
        <Input
          id="wsp-path-filter"
          type="search"
          className={`wsp-filter__q flex-1 min-w-0 min-h-9 px-3 py-1.5 text-base sm:text-[13px] rounded-[6px] box-border${value === "" ? " pr-14" : ""}`}
          aria-label="Filter by path"
          aria-keyshortcuts="Meta+K Control+K Slash"
          aria-expanded={open}
          aria-controls="wsp-path-suggest"
          aria-activedescendant={active >= 0 ? `wsp-path-suggest-${active}` : undefined}
          role="combobox"
          placeholder="Filter path  e.g. /catalog"
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
          <Kbd className="absolute top-1/2 right-2.5 -translate-y-1/2">{modKbd}</Kbd>
        )}
        {open && (
          <ul
            className="wsp-suggest absolute top-[calc(100%+4px)] left-0 right-0 z-30 m-0 max-h-[280px] list-none overflow-y-auto rounded-[6px] border border-line bg-panel p-1 shadow-[0_8px_24px_rgb(0_0_0_/_0.25)]"
            id="wsp-path-suggest"
            role="listbox"
            aria-label="Paths"
          >
            {suggestions.map((entry, index) => (
              <li key={entry.path} role="presentation">
                <button
                  type="button"
                  role="option"
                  id={`wsp-path-suggest-${index}`}
                  aria-selected={index === active}
                  className={`wsp-suggest__opt flex w-full items-baseline gap-3 rounded-sm border-0 bg-none px-2 py-1.5 text-left font-[inherit] text-inherit cursor-pointer ${index === active ? "is-active bg-bg" : ""}`}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    pick(entry.path);
                  }}
                  onMouseEnter={() => setActive(index)}
                >
                  <span className="wsp-suggest__path text-[13px] font-semibold [overflow-wrap:anywhere]">
                    {entry.path}
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
      {/* One flex item so the two toggle groups wrap together as a cluster —
          separately they wrap independently and "Merged only" ends up
          orphaned on its own row. */}
      <div className="wsp-filter__toggles flex flex-none items-stretch gap-2">
        <div
          className="wsp-toggle flex items-stretch overflow-hidden rounded-[6px] border border-line box-border"
          role="group"
          aria-label="Layout"
        >
          <button
            type="button"
            className="wsp-toggle__opt min-h-[34px] whitespace-nowrap border-0 bg-none px-3 text-[13px] text-muted-foreground cursor-pointer first:border-l-0 [&+&]:border-l [&+&]:border-line aria-pressed:bg-panel aria-pressed:text-fg hover:text-fg focus-visible:text-fg"
            aria-pressed={sort === "grouped"}
            onClick={() => onSort("grouped")}
          >
            Grouped
          </button>
          <button
            type="button"
            className="wsp-toggle__opt min-h-[34px] whitespace-nowrap border-0 bg-none px-3 text-[13px] text-muted-foreground cursor-pointer [&+&]:border-l [&+&]:border-line aria-pressed:bg-panel aria-pressed:text-fg hover:text-fg focus-visible:text-fg"
            aria-pressed={sort === "recent"}
            onClick={() => onSort("recent")}
          >
            Recent
          </button>
        </div>
        {/* Persisted PR merge-state tagging: filters both the drill-in
            (meta.gh.merged=true) and the grouped overview (?merged=1). */}
        <div
          className="wsp-toggle flex items-stretch overflow-hidden rounded-[6px] border border-line box-border"
          role="group"
          aria-label="Merge filter"
        >
          <button
            type="button"
            className="wsp-toggle__opt min-h-[34px] whitespace-nowrap border-0 bg-none px-3 text-[13px] text-muted-foreground cursor-pointer aria-pressed:bg-panel aria-pressed:text-fg hover:text-fg focus-visible:text-fg"
            aria-pressed={merged}
            onClick={() => onMerged(!merged)}
          >
            Merged only
          </button>
        </div>
      </div>
    </div>
  );
}
