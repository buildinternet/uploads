import type { Context } from "hono";

/**
 * Run best-effort `task` after the response via `waitUntil`. Awaits it when
 * there is no ExecutionContext (vitest `app.request` supplies none).
 */
export async function afterResponse(c: Context, task: Promise<unknown>): Promise<void> {
  try {
    c.executionCtx.waitUntil(task);
    return;
  } catch {
    // No ExecutionContext: fall through and await.
  }
  await task;
}
