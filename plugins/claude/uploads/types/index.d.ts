export type Binding = "self" | "none" | "other" | "unknown";

/** One staged file as the expanded band links it. */
export type FileRef = {
  /** The full object key, what `uploads delete` takes. */
  key: string;
  name: string;
  /** The uploads.sh file page, or null when the CLI gave no URL. */
  url: string | null;
  /** The storage URL, a thumbnail's source; null when the CLI gave no URL. */
  src: string | null;
  size: number | null;
  /** ISO time the file was staged, when the CLI reported it. */
  stagedAt: string | null;
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
  /** Every staged file's row; `count` is the number of files. */
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
      /** Desktop: storage URL to a small JPEG data URI; "" when the fetch failed. */
      thumbs: Record<string, string>;
      /** Desktop: storage URL to a larger JPEG data URI for the pane's detail view. */
      large: Record<string, string>;
      /** The row the pane's detail view shows; null shows the grid. */
      preview: BandRow | null;
      /** The open PR for the session branch, if any. */
      openPr: { number: number; url: string } | null;
      /** The PR's live feed URL once created. */
      feedUrl: string | null;
      /** The staged set the desktop band is hidden for; a change shows it again. */
      dismissed: string | null;
    };
  }
}
