import { describe, expect, it, vi } from "vitest";
import { escapeHtml, loadOnce, type LoadOnceFlag } from "./admin-ui";

describe("escapeHtml", () => {
  it("escapes markup characters", () => {
    expect(escapeHtml(`<a href="x">b&c</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;b&amp;c&lt;/a&gt;");
  });
});

describe("loadOnce", () => {
  it("runs the loader once on success, even with concurrent callers", async () => {
    const flag: LoadOnceFlag = { done: false };
    let resolveLoad!: () => void;
    const load = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    loadOnce(flag, load);
    loadOnce(flag, load);
    expect(load).toHaveBeenCalledTimes(1);
    resolveLoad();
    await vi.waitFor(() => expect(flag.done).toBe(true));
    loadOnce(flag, load);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("retries after failure", async () => {
    const flag: LoadOnceFlag = { done: false };
    let attempts = 0;
    const load = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("fail");
    });
    loadOnce(flag, load);
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    expect(flag.done).toBe(false);
    loadOnce(flag, load);
    await vi.waitFor(() => expect(flag.done).toBe(true));
    expect(load).toHaveBeenCalledTimes(2);
  });
});
