/**
 * The Files filter vocabulary (spec: "Files views"): Type, Device, Repo/Project,
 * PR state, Merged only. Every view shows one bar: optional search, one
 * Filters button (with a count) that opens a popover of sections, optional
 * trailing controls, and the active filters as removable chips below.
 * Values live in the URL.
 */
import { Select } from "@uploads/ui";
import { Checkbox } from "@uploads/ui/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@uploads/ui/components/ui/popover";
import { SlidersHorizontalIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";
import { FILE_SURFACES, type FileSurface, type FileTypeClass } from "@uploads/comment-render/scope";
import {
  FILE_SURFACE_LABELS,
  FILE_TYPE_LABELS,
  SINCE_FILTERS,
  SINCE_LABELS,
  type PrStateFilter,
  type SinceFilter,
} from "../../lib/files-view-state";

const FILE_TYPE_ORDER: FileTypeClass[] = ["screenshot", "video", "other"];
const PR_STATE_LABELS: Record<PrStateFilter, string> = {
  open: "Open",
  merged: "Merged",
  closed: "Closed",
};

export interface TypeFilter {
  type: FileTypeClass | null;
  surface: FileSurface | null;
}

export interface FilterChip {
  key: string;
  label: string;
  onRemove: () => void;
}

export function FilterBar({
  search,
  trailing,
  chips,
  children,
}: {
  search?: ReactNode;
  trailing?: ReactNode;
  /** Active filters; their count badges the Filters button. */
  chips: FilterChip[];
  /** Popover body: FilterSection blocks. */
  children: ReactNode;
}) {
  return (
    <div className="wsp-filter grid gap-2">
      <div className="flex items-stretch gap-2">
        {search}
        <Popover>
          <PopoverTrigger
            render={
              <button
                type="button"
                aria-label={chips.length > 0 ? `Filters, ${chips.length} active` : "Filters"}
                className={`flex min-h-9 flex-none items-center gap-2 rounded-[6px] border px-3 text-[13px] cursor-pointer box-border hover:text-fg ${chips.length > 0 ? "border-primary/50 bg-primary/10 text-fg" : "border-line bg-transparent text-muted-foreground"}`}
              />
            }
          >
            <SlidersHorizontalIcon className="size-4" aria-hidden="true" />
            <span className="hidden sm:inline">Filters</span>
            {chips.length > 0 && (
              <span className="rounded-full bg-primary px-1.5 text-[11px] leading-[18px] text-primary-foreground tabular-nums">
                {chips.length}
              </span>
            )}
          </PopoverTrigger>
          <PopoverContent align="end" className="w-[min(18rem,calc(100vw-2rem))] gap-3 p-3">
            {children}
          </PopoverContent>
        </Popover>
        {trailing}
      </div>
      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" aria-label="Active filters">
          {chips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              className="flex h-[26px] items-center gap-1 rounded-full border border-line bg-panel px-2.5 text-[12px] text-fg cursor-pointer hover:border-fg/40"
              aria-label={`Remove filter: ${chip.label}`}
              onClick={chip.onRemove}
            >
              {chip.label}
              <XIcon className="size-3 text-muted-foreground" aria-hidden="true" />
            </button>
          ))}
          {chips.length > 1 && (
            <button
              type="button"
              className="text-btn ml-1 text-[12px]"
              onClick={() => {
                for (const chip of chips) chip.onRemove();
              }}
            >
              Clear
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function FilterSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <div className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}

/** Single choice as pills; pressing the active pill clears it. */
function ChoicePills<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T | null;
  onChange: (next: T | null) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          className="rounded-full border border-line px-2.5 py-1 text-[13px] text-muted-foreground cursor-pointer hover:text-fg aria-pressed:border-primary aria-pressed:bg-primary/10 aria-pressed:text-fg"
          onClick={() => onChange(value === option.value ? null : option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

const TYPE_OPTIONS = FILE_TYPE_ORDER.map((type) => ({
  value: type,
  label: FILE_TYPE_LABELS[type],
}));
const SURFACE_OPTIONS = FILE_SURFACES.map((surface) => ({
  value: surface,
  label: FILE_SURFACE_LABELS[surface],
}));
const STATE_OPTIONS = (["open", "merged", "closed"] as const).map((state) => ({
  value: state,
  label: PR_STATE_LABELS[state],
}));

/** Type (by extension) and Device (the classifier's `ai.surface`); they combine. */
export function TypeSections({
  value,
  onChange,
}: {
  value: TypeFilter;
  onChange: (next: TypeFilter) => void;
}) {
  return (
    <>
      <FilterSection label="Type">
        <ChoicePills
          label="Filter by type"
          options={TYPE_OPTIONS}
          value={value.type}
          onChange={(type) => onChange({ ...value, type })}
        />
      </FilterSection>
      <FilterSection label="Device">
        <ChoicePills
          label="Filter by device"
          options={SURFACE_OPTIONS}
          value={value.surface}
          onChange={(surface) => onChange({ ...value, surface })}
        />
      </FilterSection>
    </>
  );
}

export function typeChips(value: TypeFilter, onChange: (next: TypeFilter) => void): FilterChip[] {
  const chips: FilterChip[] = [];
  if (value.type) {
    chips.push({
      key: "type",
      label: FILE_TYPE_LABELS[value.type],
      onRemove: () => onChange({ ...value, type: null }),
    });
  }
  if (value.surface) {
    chips.push({
      key: "surface",
      label: FILE_SURFACE_LABELS[value.surface],
      onRemove: () => onChange({ ...value, surface: null }),
    });
  }
  return chips;
}

const SINCE_OPTIONS = SINCE_FILTERS.map((since) => ({ value: since, label: SINCE_LABELS[since] }));

/** Upload-time window; the API reads it as `?since=`. */
export function SinceSection({
  value,
  onChange,
}: {
  value: SinceFilter | null;
  onChange: (since: SinceFilter | null) => void;
}) {
  return (
    <FilterSection label="Uploaded">
      <ChoicePills
        label="Filter by upload date"
        options={SINCE_OPTIONS}
        value={value}
        onChange={onChange}
      />
    </FilterSection>
  );
}

export function sinceChips(
  value: SinceFilter | null,
  onChange: (since: SinceFilter | null) => void,
): FilterChip[] {
  return value
    ? [{ key: "since", label: SINCE_LABELS[value], onRemove: () => onChange(null) }]
    : [];
}

/** Repo (PR view) or project (By page) picker; "" means all. */
export function ScopeSelect({
  label,
  allLabel,
  value,
  options,
  onChange,
}: {
  label: string;
  allLabel: string;
  value: string;
  options: string[];
  onChange: (next: string) => void;
}) {
  const all = value && !options.includes(value) ? [...options, value] : options;
  return (
    <FilterSection label={label}>
      <Select
        className="ul-select--sm min-h-9 w-full text-base sm:text-[13px] box-border"
        aria-label={`Filter by ${label.toLowerCase()}`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{allLabel}</option>
        {all.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </Select>
    </FilterSection>
  );
}

export function PrStateSection({
  value,
  onChange,
}: {
  value: PrStateFilter | null;
  onChange: (state: PrStateFilter | null) => void;
}) {
  return (
    <FilterSection label="State">
      <ChoicePills
        label="Filter by pull request state"
        options={STATE_OPTIONS}
        value={value}
        onChange={onChange}
      />
    </FilterSection>
  );
}

export function prStateLabel(state: PrStateFilter): string {
  return PR_STATE_LABELS[state];
}

export function MergedOnlyCheckbox({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-[13px] cursor-pointer">
      <Checkbox checked={checked} onCheckedChange={(next) => onChange(next === true)} />
      Merged only
    </label>
  );
}
