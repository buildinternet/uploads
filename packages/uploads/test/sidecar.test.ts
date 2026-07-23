import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readSidecarMeta, sha256Hex, sidecarPath, writeSidecarMeta } from "../src/sidecar.js";

function tmpFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "uploads-sidecar-test-"));
  return join(dir, name);
}

describe("sidecar manifest (issue #469 lever 2)", () => {
  it("writes a manifest with version, sha256, and restricted meta", () => {
    const file = tmpFile("shot.png");
    const bytes = Buffer.from("bytes");
    writeFileSync(file, bytes);
    writeSidecarMeta(file, bytes, {
      path: "/settings",
      url: "https://x.test/settings",
      "not-canonical": "dropped",
    });
    const manifest = JSON.parse(readFileSync(sidecarPath(file), "utf8"));
    expect(manifest.version).toBe(1);
    expect(manifest.sha256).toBe(sha256Hex(bytes));
    expect(manifest.meta).toEqual({ path: "/settings", url: "https://x.test/settings" });
  });

  it("does not write a sidecar when meta has no canonical keys", () => {
    const file = tmpFile("shot.png");
    const bytes = Buffer.from("bytes");
    writeFileSync(file, bytes);
    writeSidecarMeta(file, bytes, { "not-canonical": "value" });
    expect(() => readFileSync(sidecarPath(file), "utf8")).toThrow();
  });

  it("reads back a matching manifest", () => {
    const file = tmpFile("shot.png");
    const bytes = Buffer.from("bytes");
    writeFileSync(file, bytes);
    writeSidecarMeta(file, bytes, { path: "/settings", state: "after" });
    expect(readSidecarMeta(file, bytes)).toEqual({ path: "/settings", state: "after" });
  });

  it("returns undefined when the sidecar is absent", () => {
    const file = tmpFile("shot.png");
    const bytes = Buffer.from("bytes");
    writeFileSync(file, bytes);
    expect(readSidecarMeta(file, bytes)).toBeUndefined();
  });

  it("returns undefined when the hash no longer matches (regenerated/edited file)", () => {
    const file = tmpFile("shot.png");
    const original = Buffer.from("original");
    writeFileSync(file, original);
    writeSidecarMeta(file, original, { path: "/settings" });
    const changed = Buffer.from("changed");
    expect(readSidecarMeta(file, changed)).toBeUndefined();
  });

  it("returns undefined for malformed JSON", () => {
    const file = tmpFile("shot.png");
    const bytes = Buffer.from("bytes");
    writeFileSync(file, bytes);
    writeFileSync(sidecarPath(file), "not json");
    expect(readSidecarMeta(file, bytes)).toBeUndefined();
  });

  it("returns undefined for a manifest with the wrong version", () => {
    const file = tmpFile("shot.png");
    const bytes = Buffer.from("bytes");
    writeFileSync(file, bytes);
    writeFileSync(
      sidecarPath(file),
      JSON.stringify({ version: 2, sha256: sha256Hex(bytes), meta: { path: "/x" } }),
    );
    expect(readSidecarMeta(file, bytes)).toBeUndefined();
  });

  it("returns undefined when meta is not a plain string record", () => {
    const file = tmpFile("shot.png");
    const bytes = Buffer.from("bytes");
    writeFileSync(file, bytes);
    writeFileSync(
      sidecarPath(file),
      JSON.stringify({ version: 1, sha256: sha256Hex(bytes), meta: { path: 123 } }),
    );
    expect(readSidecarMeta(file, bytes)).toBeUndefined();
  });

  it("drops non-canonical keys from a hand-edited manifest even when the hash matches", () => {
    const file = tmpFile("shot.png");
    const bytes = Buffer.from("bytes");
    writeFileSync(file, bytes);
    writeFileSync(
      sidecarPath(file),
      JSON.stringify({
        version: 1,
        sha256: sha256Hex(bytes),
        meta: { path: "/settings", "arbitrary-key": "smuggled" },
      }),
    );
    expect(readSidecarMeta(file, bytes)).toEqual({ path: "/settings" });
  });

  it("returns undefined when the manifest exists but has no canonical keys", () => {
    const file = tmpFile("shot.png");
    const bytes = Buffer.from("bytes");
    writeFileSync(file, bytes);
    writeFileSync(
      sidecarPath(file),
      JSON.stringify({ version: 1, sha256: sha256Hex(bytes), meta: { "not-canonical": "x" } }),
    );
    expect(readSidecarMeta(file, bytes)).toBeUndefined();
  });
});
