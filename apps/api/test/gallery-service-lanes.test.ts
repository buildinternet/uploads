/**
 * Task C4 audit (two-lane storage, PR C): `hydrateGalleryItems`
 * (gallery-service.ts) resolves pre-existing keys, so it's converted to
 * per-item lane resolution — a gallery can reference objects uploaded
 * before a storage switch. See the PR C body's per-site audit table.
 */
import { describe, expect, it } from "vitest";
import { FakeR2Bucket } from "./fake-r2";
import { hydrateGalleryItems } from "../src/gallery-service";
import type { GalleryItemRecord } from "../src/galleries";
import type { StorageLane, WorkspaceRecord } from "../src/workspace";

function item(overrides: Partial<GalleryItemRecord> = {}): GalleryItemRecord {
  return {
    id: "item-1",
    gallery_id: "gal-1",
    object_key: "shots/a.png",
    position: 0,
    caption: null,
    alt_text: null,
    created_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

const FALLBACK_LANE: StorageLane = {
  id: "lane_fallback1",
  provider: "r2",
  bucket: "customer-bucket",
  binding: "UPLOADS_FALLBACK",
  lastActiveAt: "2026-08-01T00:00:00.000Z",
  publicBaseUrl: "https://storage.customer.example.com",
};

describe("hydrateGalleryItems across storage lanes", () => {
  it("resolves a fallback-only item to that lane's public URL", async () => {
    const active = new FakeR2Bucket();
    const fallback = new FakeR2Bucket();
    await fallback.put("shots/a.png", new Uint8Array([1, 2, 3]));
    const env = {
      UPLOADS_DEFAULT: active,
      UPLOADS_FALLBACK: fallback,
      DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }) },
    } as unknown as Env;
    const workspace: WorkspaceRecord = {
      provider: "r2",
      bucket: "uploads-default",
      binding: "UPLOADS_DEFAULT",
      publicBaseUrl: "https://storage.uploads.sh",
      storageLaneId: "lane_active1",
      storageLanes: [FALLBACK_LANE],
    };

    const [dto] = await hydrateGalleryItems(env, workspace, [item()]);
    expect(dto.status).toBe("available");
    expect(dto.url).toBe("https://storage.customer.example.com/shots/a.png");
  });

  it("single-lane record behaves as today (control)", async () => {
    const active = new FakeR2Bucket();
    await active.put("shots/a.png", new Uint8Array([1, 2, 3]));
    const env = {
      UPLOADS_DEFAULT: active,
      DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }) },
    } as unknown as Env;
    const workspace: WorkspaceRecord = {
      provider: "r2",
      bucket: "uploads-default",
      binding: "UPLOADS_DEFAULT",
      publicBaseUrl: "https://storage.uploads.sh",
    };

    const [dto] = await hydrateGalleryItems(env, workspace, [item()]);
    expect(dto.status).toBe("available");
    expect(dto.url).toBe("https://storage.uploads.sh/shots/a.png");
  });

  it("reports a key present in neither lane as missing", async () => {
    const active = new FakeR2Bucket();
    const fallback = new FakeR2Bucket();
    const env = {
      UPLOADS_DEFAULT: active,
      UPLOADS_FALLBACK: fallback,
      DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }) },
    } as unknown as Env;
    const workspace: WorkspaceRecord = {
      provider: "r2",
      bucket: "uploads-default",
      binding: "UPLOADS_DEFAULT",
      publicBaseUrl: "https://storage.uploads.sh",
      storageLanes: [FALLBACK_LANE],
    };

    const [dto] = await hydrateGalleryItems(env, workspace, [item()]);
    expect(dto.status).toBe("missing");
  });
});
