import { describe, expect, it } from "vitest";
import {
  STORAGE_MOVED_NOTICE_KEY,
  dismissStorageMovedNotice,
  isStorageMovedNoticeDismissed,
} from "./storage-moved-notice";

function mapStore() {
  const values = new Map<string, string>();
  return {
    values,
    store: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    },
  };
}

const throwing = {
  getItem: (): string | null => {
    throw new Error("SecurityError");
  },
  setItem: (): void => {
    throw new Error("QuotaExceededError");
  },
};

describe("storage moved notice", () => {
  it("shows until dismissed, then stays dismissed", () => {
    const { values, store } = mapStore();
    expect(isStorageMovedNoticeDismissed(store)).toBe(false);
    dismissStorageMovedNotice(store);
    expect(values.get(STORAGE_MOVED_NOTICE_KEY)).toBe("1");
    expect(isStorageMovedNoticeDismissed(store)).toBe(true);
  });

  it("treats a missing store as not dismissed and dismiss as a no-op", () => {
    expect(isStorageMovedNoticeDismissed(null)).toBe(false);
    expect(() => dismissStorageMovedNotice(null)).not.toThrow();
  });

  it("survives a store that throws on read and on write", () => {
    expect(isStorageMovedNoticeDismissed(throwing)).toBe(false);
    expect(() => dismissStorageMovedNotice(throwing)).not.toThrow();
  });
});
