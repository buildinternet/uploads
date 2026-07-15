/** Type declarations for backfill-gh-metadata.mjs, consumed by test/backfill-gh-metadata.test.ts. */

export const GH_KEY_RE: RegExp;

export interface GhMetadataPlan {
  key: string;
  metadata: {
    "gh.repo": string;
    "gh.kind": "pull" | "issue";
    "gh.number": string;
    "gh.ref": string;
  };
}

export function planForKey(key: string): GhMetadataPlan | null;

export interface ParseArgsResult {
  dryRun: boolean;
  workspace: string | undefined;
}

export function parseArgs(argv: string[]): ParseArgsResult;

export interface RunBackfillSummary {
  matched: number;
  patched: number;
  skipped: number;
  errors: number;
}

/** Minimal fetch-Response shape the loop consumes — real `fetch` and test stubs both satisfy it. */
export interface FetchLikeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<FetchLikeResponse>;

export interface RunBackfillOptions {
  apiUrl: string;
  workspace: string;
  token: string;
  dryRun?: boolean;
  prefix?: string;
  fetchImpl?: FetchLike;
  log?: (message: string) => void;
}

export function runBackfill(options: RunBackfillOptions): Promise<RunBackfillSummary>;
