/**
 * Vitest stand-in for `cloudflare:workers`. Plain Node cannot resolve that
 * specifier. Packages that import `@uploads/observability/issues` alias the
 * module here (apps/auth keeps its own stub, which also exports `tracing`).
 */
type IssueSpan = { setAttribute(key: string, value?: boolean | number | string): void };

let span: IssueSpan | undefined;
let explode = false;

export const tracing = {
  getActiveSpan(): IssueSpan | undefined {
    if (explode) throw new Error("tracing unavailable");
    return span;
  },
};

export function __setIssueSpan(next: IssueSpan | undefined): void {
  span = next;
}

export function __setIssueSpanExplode(next: boolean): void {
  explode = next;
}
