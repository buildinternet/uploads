import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { factsFromExifTags, imageFactsFromBytes } from "../src/image-facts.js";

describe("factsFromExifTags", () => {
  it("joins Make and Model into device", () => {
    const facts = factsFromExifTags({ Image: { Make: "Apple", Model: "iPhone 16 Pro" } });
    expect(facts.device).toBe("Apple iPhone 16 Pro");
  });

  it("does not repeat the make when the model already contains it", () => {
    const facts = factsFromExifTags({ Image: { Make: "Canon", Model: "Canon EOS R5" } });
    expect(facts.device).toBe("Canon EOS R5");
  });

  it("promotes software", () => {
    expect(factsFromExifTags({ Image: { Software: "Figma" } }).software).toBe("Figma");
  });

  it("formats a Date DateTimeOriginal without a spurious Z", () => {
    const facts = factsFromExifTags({
      Photo: { DateTimeOriginal: new Date(Date.UTC(2026, 6, 20, 20, 35, 39)) },
    });
    expect(facts.captured).toBe("2026-07-20T20:35:39");
  });

  it("formats a string DateTimeOriginal", () => {
    const facts = factsFromExifTags({ Photo: { DateTimeOriginal: "2026:07:20 20:35:39" } });
    expect(facts.captured).toBe("2026-07-20T20:35:39");
  });

  it("appends a known offset", () => {
    const facts = factsFromExifTags({
      Photo: { DateTimeOriginal: "2026:07:20 20:35:39", OffsetTimeOriginal: "-04:00" },
    });
    expect(facts.captured).toBe("2026-07-20T20:35:39-04:00");
  });

  it("never promotes GPS, serials, or personal names", () => {
    const facts = factsFromExifTags({
      Image: { Make: "Apple", Model: "iPhone 16 Pro", Artist: "Jane Doe", Copyright: "(c) Jane" },
      Photo: { BodySerialNumber: "F2LX9", LensSerialNumber: "0001", UserComment: "at home" },
      GPSInfo: { GPSLatitude: [37, 46, 30], GPSLongitude: [122, 25, 9] },
    });
    expect(facts.device).toBe("Apple iPhone 16 Pro");
    const serialized = JSON.stringify(facts).toLowerCase();
    expect(serialized).not.toContain("gps");
    expect(serialized).not.toContain("jane");
    expect(serialized).not.toContain("f2lx9");
    expect(serialized).not.toContain("at home");
    expect(Object.keys(facts)).toEqual(["device"]);
  });

  it("drops values that are not printable ASCII", () => {
    const facts = factsFromExifTags({ Image: { Software: "Figma™ ✨" } });
    expect(facts.software).toBeUndefined();
  });

  it("returns an empty object for junk input", () => {
    expect(factsFromExifTags(null)).toEqual({});
    expect(factsFromExifTags("nonsense")).toEqual({});
  });
});

describe("imageFactsFromBytes", () => {
  it("derives a logical viewport from dimensions and density", async () => {
    const png = await sharp({
      create: { width: 1624, height: 1154, channels: 3, background: { r: 10, g: 10, b: 10 } },
    })
      .withMetadata({ density: 144 })
      .png()
      .toBuffer();
    const facts = await imageFactsFromBytes(png);
    expect(facts.viewport).toBe("812x577@2x");
  });

  it("skips viewport at 72dpi, where the image is not a scaled capture", async () => {
    const png = await sharp({
      create: { width: 4032, height: 3024, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .withMetadata({ density: 72 })
      .png()
      .toBuffer();
    const facts = await imageFactsFromBytes(png);
    expect(facts.viewport).toBeUndefined();
  });

  // The factsFromExifTags tests above use hand-built tag objects, so they would
  // still pass if exif-reader's output shape changed. This one goes through
  // real bytes and pins the shape our mapping depends on.
  it("promotes device, software and captured from real EXIF bytes", async () => {
    const jpg = await sharp({
      create: { width: 100, height: 80, channels: 3, background: { r: 9, g: 9, b: 9 } },
    })
      .withExif({
        IFD0: { Make: "Apple", Model: "iPhone 16 Pro", Software: "Figma", Artist: "Jane Doe" },
        IFD2: { DateTimeOriginal: "2026:07:20 20:35:39", OffsetTimeOriginal: "-04:00" },
      })
      .jpeg()
      .toBuffer();
    const facts = await imageFactsFromBytes(jpg);
    expect(facts.device).toBe("Apple iPhone 16 Pro");
    expect(facts.software).toBe("Figma");
    expect(facts.captured).toBe("2026-07-20T20:35:39-04:00");
    // Artist rode along in the EXIF and must not have been promoted.
    expect(JSON.stringify(facts)).not.toContain("Jane");
  });

  it("returns an empty object for bytes that are not an image", async () => {
    await expect(imageFactsFromBytes(new TextEncoder().encode("not an image"))).resolves.toEqual(
      {},
    );
  });

  it("never rejects", async () => {
    await expect(imageFactsFromBytes(new Uint8Array())).resolves.toEqual({});
  });
});
