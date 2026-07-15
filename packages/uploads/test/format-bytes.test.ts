import { describe, expect, it } from "vitest";
import { formatByteSize } from "../src/format-bytes.js";

describe("formatByteSize", () => {
  it("keeps small values in bytes", () => {
    expect(formatByteSize(0)).toBe("0 B");
    expect(formatByteSize(512)).toBe("512 B");
    expect(formatByteSize(1023)).toBe("1023 B");
  });

  it("formats KB and MB with one decimal", () => {
    expect(formatByteSize(1024)).toBe("1.0 KB");
    expect(formatByteSize(96412)).toBe("94.2 KB");
    expect(formatByteSize(421337)).toBe("411.5 KB");
    expect(formatByteSize(1024 * 1024)).toBe("1.0 MB");
    expect(formatByteSize(1.5 * 1024 * 1024)).toBe("1.5 MB");
  });

  it("handles non-finite input", () => {
    expect(formatByteSize(Number.NaN)).toBe("0 B");
    expect(formatByteSize(-1)).toBe("0 B");
  });
});
