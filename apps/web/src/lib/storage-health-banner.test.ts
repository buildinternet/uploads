import { describe, expect, it } from "vitest";
import { storageBannerLinkHref } from "./storage-health-banner";
import { workspaceStorageBucketHref, workspaceStoragePath } from "./workspace-browse-url";

describe("storageBannerLinkHref", () => {
  it("jumps to #bucket on the same page when already on the Storage tab", () => {
    expect(storageBannerLinkHref("acme", workspaceStoragePath("acme"))).toBe("#bucket");
  });

  it("links to the Storage tab's Bucket section from every other tab", () => {
    for (const tab of ["files", "links", "people", "settings"]) {
      const pathname = `/account/workspaces/acme/${tab}`;
      expect(storageBannerLinkHref("acme", pathname)).toBe(workspaceStorageBucketHref("acme"));
    }
    expect(workspaceStorageBucketHref("acme")).toBe("/account/workspaces/acme/storage#bucket");
  });

  it("does not treat another workspace's Storage tab as on-page", () => {
    expect(storageBannerLinkHref("acme", workspaceStoragePath("other"))).toBe(
      workspaceStorageBucketHref("acme"),
    );
  });
});
