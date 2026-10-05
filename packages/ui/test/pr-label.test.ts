import { describe, expect, it } from "vitest";
import { asPrState, isSafePrHref, prLabelParts, prLabelSrText } from "../src/lib/pr-label";

describe("prLabelParts", () => {
  it("renders number and title when the title is known", () => {
    expect(prLabelParts({ ghRef: "acme/web#123", title: "Fix login", state: "open" })).toEqual({
      number: "#123",
      repo: "acme/web",
      title: "Fix login",
      text: "#123 Fix login",
      fallback: false,
      state: "open",
      ariaLabel: "Pull request #123 in acme/web: Fix login (open)",
    });
  });

  it("falls back to owner/repo #n when the title is missing", () => {
    expect(prLabelParts({ ghRef: "acme/web#123" })).toEqual({
      number: "#123",
      repo: "acme/web",
      title: null,
      text: "acme/web #123",
      fallback: true,
      state: null,
      ariaLabel: "Pull request #123 in acme/web",
    });
  });

  it("treats a blank title as missing and trims a real one", () => {
    expect(prLabelParts({ ghRef: "acme/web#9", title: "   " }).text).toBe("acme/web #9");
    expect(prLabelParts({ ghRef: "acme/web#9", title: "  Ship it  " }).text).toBe("#9 Ship it");
  });

  it("keeps dots, dashes, underscores, and case in the repo", () => {
    const parts = prLabelParts({ ghRef: "Foo.Bar/My-Repo_x#7" });
    expect(parts.repo).toBe("Foo.Bar/My-Repo_x");
    expect(parts.text).toBe("Foo.Bar/My-Repo_x #7");
  });

  it("handles a bare #n ref with no repo", () => {
    expect(prLabelParts({ ghRef: "#7" })).toMatchObject({
      number: "#7",
      repo: "",
      text: "#7",
      ariaLabel: "Pull request #7",
    });
  });

  it("passes an unparseable ref through as text", () => {
    expect(prLabelParts({ ghRef: "not a ref" })).toMatchObject({
      number: "",
      repo: "",
      text: "not a ref",
      fallback: true,
      ariaLabel: "Pull request not a ref",
    });
  });

  it("names issues as issues", () => {
    expect(
      prLabelParts({ ghRef: "acme/web#3", title: "Crash", state: "closed", kind: "issue" })
        .ariaLabel,
    ).toBe("Issue #3 in acme/web: Crash (closed)");
  });

  it("drops a state outside open/closed/merged", () => {
    expect(prLabelParts({ ghRef: "acme/web#3", state: "draft" as never }).state).toBeNull();
  });
});

describe("asPrState", () => {
  it("narrows only the three known states", () => {
    expect(asPrState("open")).toBe("open");
    expect(asPrState("merged")).toBe("merged");
    expect(asPrState("closed")).toBe("closed");
    expect(asPrState("OPEN")).toBeNull();
    expect(asPrState(undefined)).toBeNull();
  });
});

describe("isSafePrHref", () => {
  it("allows http(s) and root-relative links only", () => {
    expect(isSafePrHref("https://github.com/acme/web/pull/1")).toBe(true);
    expect(isSafePrHref("http://127.0.0.1:4321/x")).toBe(true);
    expect(isSafePrHref("/account/workspaces/acme/files")).toBe(true);
    expect(isSafePrHref("//evil.example/x")).toBe(false);
    expect(isSafePrHref("//evil.example")).toBe(false);
    expect(isSafePrHref("/\\evil.example")).toBe(false);
    expect(isSafePrHref("/account/x")).toBe(true);
    expect(isSafePrHref("javascript:alert(1)")).toBe(false);
    expect(isSafePrHref("JavaScript:alert(1)")).toBe(false);
    expect(isSafePrHref("")).toBe(false);
  });
});

describe("prLabelSrText", () => {
  it("names the kind and state", () => {
    expect(prLabelSrText({ ghRef: "a/b#1", state: "open" })).toBe(" (pull request, open)");
    expect(prLabelSrText({ ghRef: "a/b#1", kind: "issue", state: "closed" })).toBe(
      " (issue, closed)",
    );
  });

  it("omits the state when unknown", () => {
    expect(prLabelSrText({ ghRef: "a/b#1" })).toBe(" (pull request)");
  });

  it("gives the full label when compact", () => {
    expect(prLabelSrText({ ghRef: "a/b#1", title: "Fix", state: "open" }, true)).toBe(
      " (Pull request #1 in a/b: Fix (open))",
    );
  });
});
