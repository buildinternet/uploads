import { describe, expect, it, vi } from "vitest";
import {
  liveLinkScopeKey,
  liveLinkScopeLabel,
  liveLinkToast,
  privateConfirmText,
  runCopyLiveLink,
  writeClipboardUrl,
  type CopyLiveLinkDeps,
  type ScopeShareInfo,
} from "./live-link-flow";

const PR = { repo: "acme/web", pr: 7 };
const URL_A = "https://uploads.sh/c/abc";

/** `copyText` resolves each write's URL promise; `writes` records the outcome per write. */
function deps(
  overrides: Partial<CopyLiveLinkDeps> = {},
  info: ScopeShareInfo | null = { privateCount: 0, liveLink: null },
) {
  const writes: Array<Promise<string>> = [];
  const copyText = vi.fn(async (url: Promise<string>) => {
    writes.push(url);
    try {
      await url;
      return true;
    } catch {
      return false;
    }
  });
  return {
    writes,
    loadShareInfo: vi.fn(async () => info),
    create: vi.fn(async () => ({ kind: "ok" as const, id: "abc", url: URL_A })),
    confirmPrivate: vi.fn(async () => true),
    copyText,
    ...overrides,
  };
}

describe("runCopyLiveLink", () => {
  it("creates, copies, and skips the confirm when nothing is private", async () => {
    const d = deps();
    const outcome = await runCopyLiveLink(d, PR, { confirmed: new Set() });
    expect(outcome).toEqual({ kind: "copied", url: URL_A, id: "abc" });
    expect(d.create).toHaveBeenCalledWith(PR);
    expect(d.copyText).toHaveBeenCalledTimes(1);
    await expect(d.writes[0]).resolves.toBe(URL_A);
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

  it("re-asks on retry when the create hit the limit or failed", async () => {
    const confirmed = new Set<string>();
    const info = { privateCount: 2, liveLink: null };
    const limited = deps(
      { create: vi.fn(async () => ({ kind: "limit" as const, limit: 50 })) },
      info,
    );
    expect(await runCopyLiveLink(limited, PR, { confirmed })).toEqual({ kind: "limit", limit: 50 });
    expect(confirmed.size).toBe(0);
    const failed = deps({ create: vi.fn(async () => ({ kind: "error" as const })) }, info);
    expect(await runCopyLiveLink(failed, PR, { confirmed })).toEqual({ kind: "error" });
    expect(confirmed.size).toBe(0);
    const retry = deps({}, info);
    expect(await runCopyLiveLink(retry, PR, { confirmed })).toMatchObject({ kind: "copied" });
    expect(retry.confirmPrivate).toHaveBeenCalledTimes(1);
    expect(confirmed.has("acme/web#7")).toBe(true);
  });

  it("asks the API every time, so a link revoked since the page loaded is replaced", async () => {
    const d = deps(
      {},
      { privateCount: 0, liveLink: { id: "revoked", url: "https://uploads.sh/c/revoked" } },
    );
    const outcome = await runCopyLiveLink(d, PR, { confirmed: new Set() });
    expect(d.create).toHaveBeenCalledTimes(1);
    expect(d.create).toHaveBeenCalledWith(PR);
    expect(outcome).toEqual({ kind: "copied", url: URL_A, id: "abc" });
    await expect(d.writes[0]).resolves.toBe(URL_A);
    expect(liveLinkToast(outcome, PR, "/account/workspaces/acme/links")).toEqual({
      text: "Copied. Anyone with the link sees this PR's files as they're pushed.",
    });
  });

  it("asks the API with known share info too, and copies the link it returns", async () => {
    const d = deps({
      create: vi.fn(async () => ({
        kind: "ok" as const,
        id: "fromcomment",
        url: "https://uploads.sh/c/fromcomment",
      })),
    });
    const outcome = await runCopyLiveLink(d, PR, {
      known: {
        privateCount: 0,
        liveLink: { id: "fromcomment", url: "https://uploads.sh/c/fromcomment" },
      },
      confirmed: new Set(),
    });
    expect(d.create).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({
      kind: "copied",
      url: "https://uploads.sh/c/fromcomment",
      id: "fromcomment",
    });
  });

  it("reports the repo cap with the API's number and a sticky link to Links", async () => {
    const d = deps({ create: vi.fn(async () => ({ kind: "limit" as const, limit: 50 })) });
    const outcome = await runCopyLiveLink(d, PR, { confirmed: new Set() });
    expect(outcome).toEqual({ kind: "limit", limit: 50 });
    await expect(d.writes[0]).rejects.toThrow();
    expect(liveLinkToast(outcome, PR, "/account/workspaces/acme/links")).toEqual({
      text: "This workspace has reached its limit of 50 repo live links. Revoke one to add another.",
      link: { href: "/account/workspaces/acme/links", label: "Manage live links" },
      sticky: true,
    });
  });

  it("says live links need publicly served files, with no retry, when the create is refused", async () => {
    const d = deps({ create: vi.fn(async () => ({ kind: "not_public" as const })) });
    const outcome = await runCopyLiveLink(d, PR, { confirmed: new Set() });
    expect(outcome).toEqual({ kind: "not_public" });
    await expect(d.writes[0]).rejects.toThrow();
    const toast = liveLinkToast(outcome, PR, "/l");
    expect(toast).toEqual({
      text: "Live links need publicly served files, and this workspace's files aren't publicly served yet.",
    });
    expect(toast?.text).not.toContain("Try again");
  });

  it("hands the URL back, sticky with a Copy button, when the clipboard write is rejected", async () => {
    const d = deps({ copyText: vi.fn(async () => false) });
    const outcome = await runCopyLiveLink(d, PR, { confirmed: new Set() });
    expect(outcome).toEqual({ kind: "clipboard-blocked", url: URL_A, id: "abc" });
    expect(liveLinkToast(outcome, PR, "/l")).toEqual({
      text: "Couldn't copy automatically. Your live link:",
      link: { href: URL_A, label: URL_A, external: true },
      copyText: URL_A,
      sticky: true,
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
    await expect(failing.writes[0]).rejects.toThrow();
  });

  it("returns error (no throw) when loading share info throws", async () => {
    const d = deps({
      loadShareInfo: vi.fn(async () => {
        throw new Error("network");
      }),
    });
    expect(await runCopyLiveLink(d, PR, { confirmed: new Set() })).toEqual({ kind: "error" });
  });
});

describe("clipboard gesture ordering", () => {
  it("starts the write synchronously in the click when known info needs no confirm", () => {
    const d = deps();
    void runCopyLiveLink(d, PR, {
      known: { privateCount: 0, liveLink: null },
      confirmed: new Set(),
    });
    expect(d.copyText).toHaveBeenCalledTimes(1);
  });

  it("writes optimistically in the click when share info is not known yet", async () => {
    const order: string[] = [];
    const d = deps({
      loadShareInfo: vi.fn(async () => {
        order.push("load");
        return { privateCount: 0, liveLink: null };
      }),
    });
    const copyText = d.copyText;
    d.copyText = vi.fn((url) => {
      order.push("write");
      return copyText(url);
    });
    await runCopyLiveLink(d, PR, { confirmed: new Set() });
    expect(order).toEqual(["write", "load"]);
    await expect(d.writes[0]).resolves.toBe(URL_A);
  });

  it("with known private items, waits for the confirm and starts the write after it", async () => {
    let answer!: (ok: boolean) => void;
    const d = deps({
      confirmPrivate: vi.fn(() => new Promise<boolean>((resolve) => (answer = resolve))),
    });
    const run = runCopyLiveLink(d, PR, {
      known: { privateCount: 2, liveLink: null },
      confirmed: new Set(),
    });
    expect(d.copyText).not.toHaveBeenCalled();
    answer(true);
    expect(await run).toMatchObject({ kind: "copied" });
    expect(d.copyText).toHaveBeenCalledTimes(1);
    await expect(d.writes[0]).resolves.toBe(URL_A);
  });

  it("abandons the optimistic write when a confirm turns up, then writes in the confirm gesture", async () => {
    const d = deps({}, { privateCount: 2, liveLink: null });
    const outcome = await runCopyLiveLink(d, PR, { confirmed: new Set() });
    expect(outcome).toMatchObject({ kind: "copied" });
    expect(d.copyText).toHaveBeenCalledTimes(2);
    await expect(d.writes[0]).rejects.toThrow("abandoned");
    await expect(d.writes[1]).resolves.toBe(URL_A);
  });
});

describe("writeClipboardUrl", () => {
  class FakeItem {
    constructor(readonly items: Record<string, Promise<Blob>>) {}
  }

  it("starts clipboard.write before the URL resolves, with a text/plain Blob promise", async () => {
    let resolveUrl!: (url: string) => void;
    const url = new Promise<string>((resolve) => (resolveUrl = resolve));
    let item: FakeItem | undefined;
    const write = vi.fn(async (items: unknown[]) => {
      item = items[0] as FakeItem;
      await item.items["text/plain"];
    });
    const writeText = vi.fn(async () => {});
    const done = writeClipboardUrl({ write, writeText }, FakeItem, url);
    expect(write).toHaveBeenCalledTimes(1);
    resolveUrl(URL_A);
    expect(await done).toBe(true);
    expect(await (await item!.items["text/plain"]).text()).toBe(URL_A);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("falls back to writeText after the URL resolves when ClipboardItem is missing", async () => {
    const writeText = vi.fn(async () => {});
    expect(await writeClipboardUrl({ writeText }, undefined, Promise.resolve(URL_A))).toBe(true);
    expect(writeText).toHaveBeenCalledWith(URL_A);
  });

  it("returns false when the write is rejected, the URL rejects, or there is no clipboard", async () => {
    const reject = vi.fn(async () => {
      throw new Error("blocked");
    });
    expect(
      await writeClipboardUrl(
        { write: reject, writeText: reject },
        FakeItem,
        Promise.resolve(URL_A),
      ),
    ).toBe(false);
    expect(await writeClipboardUrl({ writeText: reject }, undefined, Promise.resolve(URL_A))).toBe(
      false,
    );
    expect(
      await writeClipboardUrl(
        { writeText: vi.fn(async () => {}) },
        undefined,
        Promise.reject(new Error("x")),
      ),
    ).toBe(false);
    expect(await writeClipboardUrl(undefined, undefined, Promise.resolve(URL_A))).toBe(false);
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
    const outcome = { kind: "copied" as const, url: URL_A, id: "abc" };
    expect(liveLinkToast(outcome, { repo: "acme/web" }, "/l")?.text).toBe(
      "Copied. Anyone with the link sees this repo's files as they're pushed.",
    );
    expect(liveLinkToast({ kind: "cancelled" }, PR, "/l")).toBeNull();
    expect(liveLinkToast({ kind: "error" }, PR, "/l")?.text).toBe(
      "Couldn't create the live link. Try again.",
    );
  });

  it("keys and labels scopes by repo and PR", () => {
    expect(liveLinkScopeKey(PR)).toBe("acme/web#7");
    expect(liveLinkScopeKey({ repo: "acme/web" })).toBe("acme/web");
    expect(liveLinkScopeLabel(PR)).toBe("acme/web #7");
    expect(liveLinkScopeLabel({ repo: "acme/web" })).toBe("acme/web");
  });
});
