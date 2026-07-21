export interface DistStalenessResult {
  stale: boolean;
  checked: boolean;
  reason?: string;
}

export declare function checkDistStaleness(packageRoot: string): DistStalenessResult;
export declare function warnIfDistStale(packageRoot: string): void;
