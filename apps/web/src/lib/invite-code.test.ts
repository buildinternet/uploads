import { describe, expect, it } from "vitest";
import {
  codeFromHash,
  codeStorageKey,
  loginHref,
  readStashedCode,
  stashCode,
  type CodeStorage,
} from "./invite-code";

/** In-memory `CodeStorage`, optionally rigged to throw like a private
 * window / disabled storage would. */
function fakeStorage(opts: { throws?: boolean } = {}): CodeStorage {
  const store = new Map<string, string>();
  return {
    getItem(key) {
      if (opts.throws) throw new Error("storage disabled");
      return store.has(key) ? store.get(key)! : null;
    },
    setItem(key, value) {
      if (opts.throws) throw new Error("storage disabled");
      store.set(key, value);
    },
    removeItem(key) {
      if (opts.throws) throw new Error("storage disabled");
      store.delete(key);
    },
  };
}

describe("codeStorageKey", () => {
  it("scopes the key per pageId", () => {
    expect(codeStorageKey("upi_abc")).toBe("invite:upi_abc");
    expect(codeStorageKey("upi_abc")).not.toBe(codeStorageKey("upi_def"));
  });
});

describe("loginHref", () => {
  it("never embeds the code — only id survives into callbackURL", () => {
    const href = loginHref("https://uploads.sh", "upi_abcdefghijklmnop");
    expect(href).toBe(
      "/login?callbackURL=" +
        encodeURIComponent("https://uploads.sh/invite?id=upi_abcdefghijklmnop"),
    );
    expect(href).not.toContain("code");
    expect(href).not.toContain("%23"); // no encoded '#' fragment either
  });

  it("percent-encodes the pageId", () => {
    const href = loginHref("https://uploads.sh", "upi_weird value");
    const returnTo = decodeURIComponent(href.slice("/login?callbackURL=".length));
    expect(returnTo).toBe("https://uploads.sh/invite?id=upi_weird%20value");
  });
});

describe("codeFromHash", () => {
  it("extracts code from a #code=... fragment", () => {
    expect(codeFromHash("#code=upe_deadbeef")).toBe("upe_deadbeef");
  });

  it("returns empty string when there is no code", () => {
    expect(codeFromHash("")).toBe("");
    expect(codeFromHash("#other=1")).toBe("");
  });
});

describe("stashCode / readStashedCode", () => {
  it("round-trips a stashed code and clears it on read", () => {
    const storage = fakeStorage();
    expect(stashCode(storage, "upi_1", "upe_secret")).toBe(true);
    expect(readStashedCode(storage, "upi_1")).toBe("upe_secret");
    // Single-use: a second read finds nothing.
    expect(readStashedCode(storage, "upi_1")).toBe("");
  });

  it("scopes reads/writes per pageId — no cross-invite leakage", () => {
    const storage = fakeStorage();
    stashCode(storage, "upi_1", "upe_one");
    stashCode(storage, "upi_2", "upe_two");
    expect(readStashedCode(storage, "upi_2")).toBe("upe_two");
    expect(readStashedCode(storage, "upi_1")).toBe("upe_one");
  });

  it("stashCode returns false (never throws) when storage is unavailable", () => {
    const storage = fakeStorage({ throws: true });
    expect(() => stashCode(storage, "upi_1", "upe_secret")).not.toThrow();
    expect(stashCode(storage, "upi_1", "upe_secret")).toBe(false);
  });

  it('readStashedCode returns "" (never throws) when storage is unavailable', () => {
    const storage = fakeStorage({ throws: true });
    expect(() => readStashedCode(storage, "upi_1")).not.toThrow();
    expect(readStashedCode(storage, "upi_1")).toBe("");
  });

  it('readStashedCode returns "" when nothing was stashed', () => {
    const storage = fakeStorage();
    expect(readStashedCode(storage, "upi_never-stashed")).toBe("");
  });
});
