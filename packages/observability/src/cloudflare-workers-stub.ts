/**
 * Vitest stand-in for `cloudflare:workers`. Plain Node cannot resolve that
 * specifier. Packages that import `@uploads/observability/issues` or
 * `/tracing` alias the module here (apps/auth keeps its own stub, which also
 * exports `tracing`).
 *
 * `enterSpan` runs the callback with a throwaway span by default, so every
 * test that crosses a `withSpan` exercises the traced path. Tests that care
 * install a recorder with `__setEnterSpan`.
 */
type IssueSpan = {
  setAttribute(key: string, value?: boolean | number | string): void;
  setAttributes?(attributes: Record<string, unknown>): unknown;
  updateName?(name: string): unknown;
};

type StubSpan = {
  setAttributes(attributes: Record<string, unknown>): unknown;
  recordException?(exception: unknown): void;
  setStatus?(status: { code: string; message?: string }): unknown;
};

type EnterSpan = <T>(name: string, callback: (span: StubSpan) => T) => T;

const QUIET_SPAN: StubSpan = { setAttributes() {} };
const defaultEnterSpan: EnterSpan = (_name, callback) => callback(QUIET_SPAN);

let span: IssueSpan | undefined;
let explode = false;
let enterSpanImpl: EnterSpan | undefined = defaultEnterSpan;

export const tracing = {
  getActiveSpan(): IssueSpan | undefined {
    if (explode) throw new Error("tracing unavailable");
    return span;
  },
  get enterSpan(): EnterSpan | undefined {
    return enterSpanImpl;
  },
};

export function __setIssueSpan(next: IssueSpan | undefined): void {
  span = next;
}

export function __setIssueSpanExplode(next: boolean): void {
  explode = next;
}

/** `undefined` removes `enterSpan`, like a runtime without custom spans. */
export function __setEnterSpan(next: EnterSpan | undefined | "default"): void {
  enterSpanImpl = next === "default" ? defaultEnterSpan : next;
}
