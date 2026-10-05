/**
 * The Files filter vocabulary (spec: "Files views"): Type, Repo, PR state.
 * Each view composes the controls it needs; values live in the URL.
 */
import { Select } from "@uploads/ui";
import type { FileTypeClass } from "@uploads/comment-render/scope";
import {
  FILE_TYPE_LABELS,
  parseFileTypeParam,
  parsePrStateParam,
  type PrStateFilter,
} from "../../lib/files-view-state";

const SELECT_CLASS = "ul-select--sm min-h-9 max-w-full text-base sm:text-[13px] box-border";
const FILE_TYPE_ORDER: FileTypeClass[] = ["screenshot", "video", "other"];

export function TypeSelect({
  value,
  onChange,
}: {
  value: FileTypeClass | null;
  onChange: (type: FileTypeClass | null) => void;
}) {
  return (
    <Select
      className={`${SELECT_CLASS} flex-[0_1_10rem] min-w-[9rem]`}
      aria-label="Filter by type"
      value={value ?? ""}
      onChange={(event) => onChange(parseFileTypeParam(event.target.value))}
    >
      <option value="">All types</option>
      {FILE_TYPE_ORDER.map((type) => (
        <option key={type} value={type}>
          {FILE_TYPE_LABELS[type]}
        </option>
      ))}
    </Select>
  );
}

export function RepoSelect({
  value,
  options,
  onChange,
}: {
  value: string;
  options: string[];
  onChange: (repo: string) => void;
}) {
  const all = value && !options.includes(value) ? [...options, value] : options;
  return (
    <Select
      className={`${SELECT_CLASS} flex-[0_1_16rem] min-w-[12rem]`}
      aria-label="Filter by repo"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">All repos</option>
      {all.map((repo) => (
        <option key={repo} value={repo}>
          {repo}
        </option>
      ))}
    </Select>
  );
}

export function PrStateSelect({
  value,
  onChange,
}: {
  value: PrStateFilter | null;
  onChange: (state: PrStateFilter | null) => void;
}) {
  return (
    <Select
      className={`${SELECT_CLASS} flex-[0_1_9rem] min-w-[8rem]`}
      aria-label="Filter by pull request state"
      value={value ?? ""}
      onChange={(event) => onChange(parsePrStateParam(event.target.value))}
    >
      <option value="">Any state</option>
      <option value="open">Open</option>
      <option value="merged">Merged</option>
      <option value="closed">Closed</option>
    </Select>
  );
}
