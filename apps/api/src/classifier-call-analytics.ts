/**
 * Analytics Engine write side for classifier spend (dataset
 * `uploads_classifier_calls`). One point per OpenRouter Decisions call that
 * came back ok, with the `usage` block the response carries. The operator
 * classifier view (`/admin/classifier`) reads it back per day through
 * `fetchClassifierCostSeries` in analytics-engine.ts.
 *
 * Only the model id and the usage numbers are written, never a workspace,
 * key, or image. An absent binding is a silent no-op, and a write never
 * throws, same contract as `writeSlowOpPoint`.
 */
import { reportHandledError } from "@uploads/observability";

/**
 * Blob and double positions are a contract with the SQL read path. Append
 * new fields at the end; never reorder or remove.
 */
export const CLASSIFIER_CALL_BLOB_ORDER = ["model"] as const;
export const CLASSIFIER_CALL_DOUBLE_ORDER = ["cost", "inputTokens"] as const;

export interface ClassifierCallUsage {
  /** USD, or -1 when the response did not carry a cost. */
  cost: number;
  /** Jev bills input only, so input tokens are what the estimate scales by. */
  inputTokens: number;
}

function usageNumber(usage: Record<string, unknown>, ...names: string[]): number | undefined {
  for (const name of names) {
    const value = usage[name];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return undefined;
}

/** Cost and input tokens from the Decisions `usage` block, camelCase or snake_case. */
export function decisionsUsage(result: unknown): ClassifierCallUsage {
  const raw = (result as { usage?: unknown } | null)?.usage;
  const usage = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    cost: usageNumber(usage, "cost") ?? -1,
    inputTokens: usageNumber(usage, "inputTokens", "input_tokens", "prompt_tokens") ?? 0,
  };
}

export function writeClassifierCallPoint(env: Env, model: string, result: unknown): void {
  const analytics = (env as { CLASSIFIER_CALLS?: AnalyticsEngineDataset }).CLASSIFIER_CALLS;
  if (!analytics) return;
  try {
    const usage = decisionsUsage(result);
    analytics.writeDataPoint({
      indexes: [model],
      blobs: [model],
      doubles: [usage.cost, usage.inputTokens],
    });
  } catch (err) {
    reportHandledError(err);
  }
}
