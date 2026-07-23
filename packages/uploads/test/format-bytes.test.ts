import { describe, expect, it } from "vitest";
import { formatByteSize, formatMarketedBytes } from "../src/format-bytes.js";

describe("formatByteSize", () => {
  it("keeps small values in bytes", () => {
    expect(formatByteSize(0)).toBe("0 B");
    expect(formatByteSize(512)).toBe("512 B");
    expect(formatByteSize(999)).toBe("999 B");
  });

  it("formats KB and MB with decimal SI units", () => {
    expect(formatByteSize(1000)).toBe("1 KB");
    expect(formatByteSize(1500)).toBe("1.5 KB");
    expect(formatByteSize(1_500_000)).toBe("1.5 MB");
    expect(formatByteSize(1_000_000)).toBe("1 MB");
    // Free plan cap must read as marketed 250 MB, not binary 238.4 MB.
    expect(formatByteSize(250_000_000)).toBe("250 MB");
  });

  it("handles non-finite input", () => {
    expect(formatByteSize(Number.NaN)).toBe("0 B");
    expect(formatByteSize(-1)).toBe("0 B");
  });
});

describe("formatMarketedBytes", () => {
  it("renders plan catalog caps as round decimal units", () => {
    expect(formatMarketedBytes(250_000_000)).toBe("250 MB");
    expect(formatMarketedBytes(25_000_000)).toBe("25 MB");
    expect(formatMarketedBytes(8_000_000)).toBe("8 MB");
    expect(formatMarketedBytes(10_000_000_000)).toBe("10 GB");
    expect(formatMarketedBytes(100_000_000)).toBe("100 MB");
  });

  it("handles sub-KB and fractional values", () => {
    expect(formatMarketedBytes(500)).toBe("500 B");
    expect(formatMarketedBytes(1_500_000)).toBe("1.5 MB");
  });
});
