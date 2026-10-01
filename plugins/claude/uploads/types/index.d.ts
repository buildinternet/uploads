export type Binding = "self" | "none" | "other" | "unknown";

/** One staged file as the expanded band links it. */
export type FileRef = {
  name: string;
  /** The uploads.sh file page, or null when the CLI gave no URL. */
  url: string | null;
  size: number | null;
};

/**
 * One row of the expanded band: a before/after pair under its shared name
 * (by the attachments comment's pairing rule; either half may be missing),
 * or a file that is neither.
 */
export type BandRow =
  | { kind: "pair"; label: string; before: FileRef | null; after: FileRef | null }
  | { kind: "file"; file: FileRef };

/** What `uploads staged --format json` reported for one branch. */
export type Staged = {
  repo: string;
  branch: string;
  count: number;
  /** The first few rows; `count` is the full number of files. */
  rows: BandRow[];
  binding: Binding;
  autoAttach: boolean;
};

/** The last PR this session opened that had staged files waiting for it. */
export type Attached = {
  repo: string;
  branch: string;
  pr: number;
  count: number;
  via: "app" | "cli";
};

declare module "claude-code" {
  interface PluginState {
    uploads: {
      staged: Staged | null;
      attached: Attached | null;
      /** Whether the band lists the staged files under its header. */
      isExpanded: boolean;
    };
  }
}
