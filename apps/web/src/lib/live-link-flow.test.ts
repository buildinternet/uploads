import { describe, expect, it, vi } from "vitest";
import {
  liveLinkScopeKey,
  liveLinkToast,
  privateConfirmText,
  runCopyLiveLink,
  type CopyLiveLinkDeps,
  type ScopeShareInfo,
} from "./live-link-flow";

const PR = { repo: "acme/web", pr: 7 };
const URL_A = "https://uploads.sh/c/abc";

function deps(
  overrides: Partial<CopyLiveLinkDeps> = {},
  info: ScopeShareInfo | null = { privateCount: 0, liveLink: null },
) {
  return {
    loadShareInfo: vi.fn(async () => info),
    create: vi.fn(async () => ({ kind: "ok" as const, id: "abc", url: URL_A })),
    confirmPrivate: vi.fn(async () => true),
    writeClipboard: vi.fn(async () => true),
    ...overrides,
  };
}

describe("runCopyLiveLink", () => {
  it("creates, copies, and skips the confirm when nothing is private", async () => {
    const d = deps();
    const outcome = await runCopyLiveLink(d, PR, { confirmed: new Set() });
    expect(outcome).toEqual({ kind: "copied", url: URL_A, id: "abc", created: true });
    expect(d.create).toHaveBeenCalledWith(PR);
    expect(d.writeClipboard).toHaveBeenCalledWith(URL_A);
    expect(d.confirmPrivate).not.toHaveBeenCalled();
  });

  it("asks before the first copy when items are private; Cancel creates nothing", async () => {
    const d = deps(
      { confirmPrivate: vi.fn(async () => false) },
      { privateCount: 3, liveLink: null },
    );
    const confirmed = new Set<string>();
    expect(await runCopyLiveLink(d, PR, { confirmed })).toEqual({ kind: "cancelled" });
    expect(d.confirmPrivate).toHaveBeenCalledWith(3);
    expect(d.create).not.toHaveBeenCalled();
    expect(confirmed.size).toBe(0);
  });

  it("skips the confirm when privateCount is null (a cursor page never counts)", async () => {
    const d = deps({}, { privateCount: null, liveLink: null });
    expect(await runCopyLiveLink(d, PR, { confirmed: new Set() })).toMatchObject({
      kind: "copied",
    });
    expect(d.confirmPrivate).not.toHaveBeenCalled();
  });

  it("asks only once per scope per page session", async () => {
    const d = deps({}, { privateCount: 2, liveLink: null });
    const confirmed = new Set<string>();
    await runCopyLiveLink(d, PR, { confirmed });
    await runCopyLiveLink(d, PR, { confirmed });
    expect(d.confirmPrivate).toHaveBeenCalledTimes(1);
  });

  it("reuses a link comment sync already made: same URL, no POST (Review Focus 5)", async () => {
    const d = deps(
      {},
      { privateCount: 0, liveLink: { id: "fromcomment", url: "https://uploads.sh/c/fromcomment" } },
    );
    const outcome = await runCopyLiveLink(d, PR, { confirmed: new Set() });
    expect(outcome).toEqual({
      kind: "copied",
      url: "https://uploads.sh/c/fromcomment",
      id: "fromcomment",
      created: false,
    });
    expect(d.create).not.toHaveBeenCalled();
    expect(liveLinkToast(outcome, PR, "/account/workspaces/acme/links")).toEqual({
      text: "Copied. Anyone with the link sees this PR's files as they're pushed.",
    });
  });

  it("reports the cap and links to Links", async () => {
    const d = deps({ create: vi.fn(async () => ({ kind: "limit" as const })) });
    const outcome = await runCopyLiveLink(d, PR, { confirmed: new Set() });
    expect(outcome).toEqual({ kind: "limit" });
    expect(d.writeClipboard).not.toHaveBeenCalled();
    expect(liveLinkToast(outcome, PR, "/account/workspaces/acme/links")).toEqual({
      text: "This workspace has reached its live link limit.",
      link: { href: "/account/workspaces/acme/links", label: "Manage live links" },
    });
  });

  it("hands the URL back when the clipboard write is rejected (Review Focus 1)", async () => {
    const d = deps({ writeClipboard: vi.fn(async () => false) });
    const outcome = await runCopyLiveLink(d, PR, { confirmed: new Set() });
    expect(outcome).toEqual({ kind: "clipboard-blocked", url: URL_A, id: "abc" });
    expect(liveLinkToast(outcome, PR, "/l")).toEqual({
      text: "Couldn't copy automatically. Your live link:",
      link: { href: URL_A, label: URL_A, external: true },
    });
  });

  it("uses known share info without refetching, and errors when info cannot load", async () => {
    const d = deps();
    await runCopyLiveLink(d, PR, {
      known: { privateCount: 0, liveLink: null },
      confirmed: new Set(),
    });
    expect(d.loadShareInfo).not.toHaveBeenCalled();
    const failing = deps({}, null);
    expect(await runCopyLiveLink(failing, PR, { confirmed: new Set() })).toEqual({ kind: "error" });
  });
});

describe("copy text", () => {
  it("names the private count in the confirm, per the spec", () => {
    expect(privateConfirmText(3)).toBe(
      "3 items are private and will show as hidden on the public page",
    );
    expect(privateConfirmText(1)).toBe(
      "1 item is private and will show as hidden on the public page",
    );
  });

  it("uses repo wording for a repo scope and nothing for a cancel", () => {
    const outcome = { kind: "copied" as const, url: URL_A, id: "abc", created: true };
    expect(liveLinkToast(outcome, { repo: "acme/web" }, "/l")?.text).toBe(
      "Copied. Anyone with the link sees this repo's files as they're pushed.",
    );
    expect(liveLinkToast({ kind: "cancelled" }, PR, "/l")).toBeNull();
    expect(liveLinkToast({ kind: "error" }, PR, "/l")?.text).toBe(
      "Couldn't create the live link. Try again.",
    );
  });

  it("keys scopes by repo and PR", () => {
    expect(liveLinkScopeKey(PR)).toBe("acme/web#7");
    expect(liveLinkScopeKey({ repo: "acme/web" })).toBe("acme/web");
  });
});
