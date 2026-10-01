export type Binding = "self" | "none" | "other" | "unknown";

/** One staged file as the expanded band lists it. */
export type StagedFile = {
  name: string;
  /** The uploads.sh file page, or null when the CLI gave no URL. */
  url: string | null;
  size: number | null;
};

/** What `uploads staged --format json` reported for one branch. */
export type Staged = {
  repo: string;
  branch: string;
  count: number;
  /** The first few staged files; `count` is the full total. */
  files: StagedFile[];
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
      /** The branch the band was hidden on; a new branch shows it again. */
      hiddenBranch: string | null;
      /** Whether the band lists the staged files under its header. */
      isExpanded: boolean;
    };
  }
}
