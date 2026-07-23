import { describe, expect, it } from "vitest";
import { formatByteSize, formatMarketedBytes } from "../src/format-bytes.js";

describe("formatByteSize", () => {
  it("keeps small values in bytes", () => {
    expect(formatByteSize(0)).toBe("0 B");
    expect(formatByteSize(512)).toBe("512 B");
    expect(formatByteSize(1023)).toBe("1023 B");
  });

  it("formats KB and MB with one decimal (1024-based)", () => {
    expect(formatByteSize(1024)).toBe("1.0 KB");
    expect(formatByteSize(96412)).toBe("94.2 KB");
    expect(formatByteSize(421337)).toBe("411.5 KB");
    expect(formatByteSize(1024 * 1024)).toBe("1.0 MB");
    expect(formatByteSize(1.5 * 1024 * 1024)).toBe("1.5 MB");
    // Plan free cap would look wrong with binary units:
    expect(formatByteSize(250_000_000)).toBe("238.4 MB");
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
