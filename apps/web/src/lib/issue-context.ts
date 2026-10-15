/**
 * Worker-only bridge for Issues request context.
 *
 * `auth-client.ts` parses sessions for both the browser and SSR. It must not
 * import `cloudflare:workers` (that breaks the client bundle). The worker
 * entry registers `setIssueContext` here before it handles a request. In the
 * browser the sink stays unset and this is a no-op.
 */
export interface IssueContextInput {
  userId?: string | null;
  workspace?: string | null;
  sessionId?: string | null;
}

let sink: ((ctx: IssueContextInput) => void) | undefined;

export function registerIssueContextSink(fn: (ctx: IssueContextInput) => void): void {
  sink = fn;
}

export function emitIssueContext(ctx: IssueContextInput): void {
  sink?.(ctx);
}
