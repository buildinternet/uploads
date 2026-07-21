import { describe, expect, it, vi } from "vitest";
import { enrichPublicReferences } from "./gallery-service";
import type { GalleryExternalReferenceRecord } from "./galleries";
import * as titles from "./github-titles";
import { FakeKv } from "../test/fake-kv";

function ref(
  over: Partial<GalleryExternalReferenceRecord> &
    Pick<GalleryExternalReferenceRecord, "locator_json" | "canonical_url">,
): GalleryExternalReferenceRecord {
  return {
    id: over.id ?? "ref_1",
    gallery_id: over.gallery_id ?? "gal_abcdefghijklmnopqrstuv",
    provider: over.provider ?? "github",
    resource_type: over.resource_type ?? "item",
    normalized_key: over.normalized_key ?? "github:item:o/r#9",
    locator_json: over.locator_json,
    canonical_url: over.canonical_url,
    created_at: over.created_at ?? "2026-07-20T00:00:00.000Z",
    updated_at: over.updated_at ?? "2026-07-20T00:00:00.000Z",
  };
}

describe("enrichPublicReferences", () => {
  it("overlays title + kind and rewrites PR URLs when resolve succeeds", async () => {
    vi.spyOn(titles, "resolveTitles").mockResolvedValue({
      "o/r#9": { title: "Ship gallery parity", state: "open", kind: "pull" },
    });
    vi.spyOn(titles, "withPublicTitleBudget").mockImplementation(async (work) => work);

    const out = await enrichPublicReferences({ GITHUB_CACHE: new FakeKv() } as unknown as Env, [
      ref({
        locator_json: JSON.stringify({ owner: "o", repository: "r", number: 9 }),
        canonical_url: "https://github.com/o/r/issues/9",
      }),
    ]);

    expect(out).toEqual([
      {
        provider: "github",
        resourceType: "item",
        coordinate: "o/r#9",
        canonicalUrl: "https://github.com/o/r/pull/9",
        title: "Ship gallery parity",
        kind: "pull",
      },
    ]);
  });

  it("keeps bare references when resolve returns null / times out", async () => {
    vi.spyOn(titles, "withPublicTitleBudget").mockResolvedValue(null);

    const out = await enrichPublicReferences({ GITHUB_CACHE: new FakeKv() } as unknown as Env, [
      ref({
        locator_json: JSON.stringify({ owner: "o", repository: "r", number: 9 }),
        canonical_url: "https://github.com/o/r/issues/9",
      }),
    ]);

    expect(out).toEqual([
      {
        provider: "github",
        resourceType: "item",
        coordinate: "o/r#9",
        canonicalUrl: "https://github.com/o/r/issues/9",
      },
    ]);
  });
});
