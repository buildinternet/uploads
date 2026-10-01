export type Binding = "self" | "none" | "other" | "unknown";

/** What `uploads staged --format json` reported for one branch. */
export type Staged = {
  repo: string;
  branch: string;
  count: number;
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
    "uploads": {
      staged: Staged | null;
      attached: Attached | null;
      /** The branch the band was hidden on; a new branch shows it again. */
      hiddenBranch: string | null;
    };
  }
}
