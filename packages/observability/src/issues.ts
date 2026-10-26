/**
 * Request context for Workers Issues.
 *
 * Issues reads attributes on the active trace span (`tracing.getActiveSpan()`
 * from `cloudflare:workers`). Call this after auth resolves, with the ids
 * that request actually has. A missing span (tracing off, or a runtime
 * without `getActiveSpan`) is a no-op.
 *
 * Attributes are ids only: `user.id`, `account.id` and `tenant.id` (both the
 * workspace slug), and `session.id`. Never pass a token, a session cookie,
 * a secret, or an email — those values are dropped.
 */
import { tracing } from "cloudflare:workers";

export interface IssueContext {
  userId?: string | null;
  /** Workspace slug. Written as both `account.id` and `tenant.id`. */
  workspace?: string | null;
  /** Better Auth session row id. Never the session token. */
  sessionId?: string | null;
}

interface IssueSpan {
  setAttribute(key: string, value?: boolean | number | string): void;
}

const MAX_ID_LENGTH = 128;

function issueAttributeValue(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_ID_LENGTH) return undefined;
  if (trimmed.includes("@") || /\s/.test(trimmed)) return undefined;
  if (/^(?:up_|ups_|bearer\b)/i.test(trimmed)) return undefined;
  // header.payload.signature — an access token, not an id.
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(trimmed)) return undefined;
  return trimmed;
}

function activeSpan(): IssueSpan | undefined {
  try {
    const getActiveSpan = (tracing as { getActiveSpan?: () => IssueSpan | undefined })
      .getActiveSpan;
    if (typeof getActiveSpan !== "function") return undefined;
    return getActiveSpan() ?? undefined;
  } catch {
    return undefined;
  }
}

export function setIssueContext(ctx: IssueContext): void {
  const span = activeSpan();
  if (!span) return;
  const userId = issueAttributeValue(ctx.userId);
  const workspace = issueAttributeValue(ctx.workspace);
  const sessionId = issueAttributeValue(ctx.sessionId);
  if (userId) span.setAttribute("user.id", userId);
  if (workspace) {
    span.setAttribute("account.id", workspace);
    span.setAttribute("tenant.id", workspace);
  }
  if (sessionId) span.setAttribute("session.id", sessionId);
}
