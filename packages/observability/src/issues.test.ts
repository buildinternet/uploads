import { afterEach, describe, expect, it, vi } from "vitest";
import { __setIssueSpan, __setIssueSpanExplode } from "./cloudflare-workers-stub";
import { reportHandledError } from "./index";
import { setIssueContext } from "./issues";

afterEach(() => {
  __setIssueSpan(undefined);
  __setIssueSpanExplode(false);
});

describe("setIssueContext", () => {
  it("does nothing when there is no active span", () => {
    expect(() => setIssueContext({ userId: "user_1", workspace: "acme" })).not.toThrow();
  });

  it("does nothing when getActiveSpan throws", () => {
    __setIssueSpanExplode(true);
    expect(() => setIssueContext({ userId: "user_1" })).not.toThrow();
  });

  it("sets user, workspace, and session ids on the active span", () => {
    const setAttribute = vi.fn();
    __setIssueSpan({ setAttribute });
    setIssueContext({ userId: "user_1", workspace: "acme", sessionId: "sess_1" });
    expect(setAttribute).toHaveBeenCalledWith("user.id", "user_1");
    expect(setAttribute).toHaveBeenCalledWith("account.id", "acme");
    expect(setAttribute).toHaveBeenCalledWith("tenant.id", "acme");
    expect(setAttribute).toHaveBeenCalledWith("session.id", "sess_1");
  });

  it("skips ids that are missing and drops emails, tokens, and blanks", () => {
    const setAttribute = vi.fn();
    __setIssueSpan({ setAttribute });
    setIssueContext({
      userId: "ada@example.com",
      workspace: "  ",
      sessionId: "up_acme_secret",
    });
    setIssueContext({
      userId: "user_1",
      sessionId: "aaa.bbb.ccc",
    });
    expect(setAttribute).toHaveBeenCalledTimes(1);
    expect(setAttribute).toHaveBeenCalledWith("user.id", "user_1");
  });
});

describe("reportHandledError", () => {
  it("logs the Error object itself", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("db down");
    reportHandledError(error);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBe(error);
    spy.mockRestore();
  });

  it("wraps a non-Error so Issues still receives an Error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    reportHandledError("storage lane skipped");
    const logged = spy.mock.calls[0]?.[0];
    expect(logged).toBeInstanceOf(Error);
    expect((logged as Error).message).toBe("storage lane skipped");
    spy.mockRestore();
  });
});
