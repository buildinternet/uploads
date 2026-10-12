import { describe, expect, it } from "vitest";
import type { ClassifierRun } from "./classifier";
import {
  blankSource,
  buildDigestDecideRequest,
  curationFromModel,
  curateWorkspace,
  defaultLead,
  draftForRecipient,
  factsFor,
  sectionFromSource,
  weeklyBlurb,
  type DigestRecipient,
  type WorkspaceDigestSource,
} from "./weekly-digest";

function source(over: Partial<WorkspaceDigestSource> = {}): WorkspaceDigestSource {
  return {
    ...blankSource("acme"),
    uploads: 12,
    bytesAdded: 4_200_000,
    repos: [{ name: "acme/web", count: 8 }],
    shots: [
      {
        key: "gh/acme/web/pull/12/a.png",
        label: "/billing",
        url: "https://storage.uploads.sh/acme/a.png",
        embedUrl: "https://embed.uploads.sh/acme/a.png",
        at: "2026-10-11T00:00:00.000Z",
      },
      {
        key: "gh/acme/web/pull/12/b.png",
        label: "/settings",
        url: "https://storage.uploads.sh/acme/b.png",
        embedUrl: "https://embed.uploads.sh/acme/b.png",
        at: "2026-10-12T00:00:00.000Z",
      },
    ],
    pulls: [{ repo: "acme/web", number: 12, title: "Digest", count: 4 }],
    issues: [{ repo: "acme/web", number: 4, count: 1 }],
    pages: [{ path: "/settings", count: 3 }],
    galleryNames: ["Launch"],
    galleryCount: 1,
    feeds: 1,
    ...over,
  };
}

function recipient(over: Partial<DigestRecipient> = {}): DigestRecipient {
  return {
    userId: "user-1",
    email: "ada@example.com",
    name: "Ada",
    digest: true,
    workspaceDigest: false,
    memberships: [{ slug: "acme", orgName: "Acme", role: "member" }],
    ...over,
  };
}

describe("weekly digest assembly", () => {
  it("skips a workspace whose only signal is a storage snapshot", () => {
    const quiet = source({
      uploads: 0,
      bytesAdded: 0,
      repos: [],
      shots: [],
      pulls: [],
      issues: [],
      pages: [],
      galleryNames: [],
      galleryCount: 0,
      feeds: 0,
      storageBytes: 9_000_000,
      objects: 4,
    });
    expect(
      sectionFromSource(quiet, { name: "Acme", includeActivity: true, includeAdmin: false }),
    ).toBeNull();
    expect(draftForRecipient(recipient(), new Map([["acme", quiet]]), "Oct 5–12")).toBeNull();
  });

  it("builds file activity for a member and leaves the admin block off", () => {
    const section = sectionFromSource(source(), {
      name: "Acme",
      includeActivity: true,
      includeAdmin: false,
    });
    expect(section?.uploads).toBe(12);
    expect(section?.admin).toBeUndefined();
    expect(section?.pulls[0]?.href).toBe("https://github.com/acme/web/pull/12");
    expect(section?.issues[0]?.href).toBe("https://github.com/acme/web/issues/4");
    expect(section?.screenshots).toHaveLength(2);
    expect(section?.blurb).toContain("12 files");
    expect(section?.blurb).toContain("acme/web");
  });

  it("does not link a repo name that is not owner/name", () => {
    const section = sectionFromSource(
      source({ pulls: [{ repo: "not a repo", number: 3, title: null, count: 1 }] }),
      { name: "Acme", includeActivity: true, includeAdmin: false },
    );
    expect(section?.pulls[0]?.href).toBeUndefined();
  });

  it("treats new members as activity only for an admin digest", () => {
    const joined = source({
      uploads: 0,
      bytesAdded: 0,
      repos: [],
      shots: [],
      pulls: [],
      issues: [],
      pages: [],
      galleryNames: [],
      galleryCount: 0,
      feeds: 0,
      newMembers: 2,
      activePeople: 1,
    });
    expect(
      sectionFromSource(joined, { name: "Acme", includeActivity: true, includeAdmin: false }),
    ).toBeNull();
    const admin = sectionFromSource(joined, {
      name: "Acme",
      includeActivity: false,
      includeAdmin: true,
    });
    expect(admin?.admin?.newMembers).toBe(2);
    expect(admin?.uploads).toBe(0);
    expect(admin?.blurb).toContain("2 people joined");
  });

  it("sends one email with both unsubscribe kinds when both prefs are on", () => {
    const draft = draftForRecipient(
      recipient({
        workspaceDigest: true,
        memberships: [{ slug: "acme", orgName: "Acme", role: "owner" }],
      }),
      new Map([["acme", source({ storageBytes: 1000, objects: 2 })]]),
      "Oct 5–12",
    );
    expect(draft?.unsubscribes).toEqual(["digest", "workspace"]);
    expect(draft?.sections).toHaveLength(1);
    expect(draft?.sections[0]?.admin?.objects).toBe(2);
  });

  it("omits the member unsubscribe when the only news is new members", () => {
    const joined = source({
      uploads: 0,
      bytesAdded: 0,
      repos: [],
      shots: [],
      pulls: [],
      issues: [],
      pages: [],
      galleryNames: [],
      galleryCount: 0,
      feeds: 0,
      newMembers: 1,
    });
    const draft = draftForRecipient(
      recipient({
        digest: true,
        workspaceDigest: true,
        memberships: [{ slug: "acme", orgName: "Acme", role: "admin" }],
      }),
      new Map([["acme", joined]]),
      "Oct 5–12",
    );
    expect(draft?.unsubscribes).toEqual(["workspace"]);
  });

  it("caps the email at eight workspaces", () => {
    const sources = new Map<string, WorkspaceDigestSource>();
    const memberships = [];
    for (let i = 0; i < 10; i += 1) {
      const slug = `ws-${i}`;
      sources.set(slug, source({ slug, uploads: 10 - i }));
      memberships.push({ slug, orgName: slug, role: "member" });
    }
    const draft = draftForRecipient(recipient({ memberships }), sources, "Oct 5–12");
    expect(draft?.sections).toHaveLength(8);
    expect(draft?.omittedWorkspaces).toBe(2);
    expect(draft?.sections[0]?.uploads).toBe(10);
  });
});

describe("weekly digest blurb", () => {
  it("leads with uploads when the model is not consulted", () => {
    const facts = factsFor(source(), "Acme", false);
    expect(defaultLead(facts)).toBe("uploads");
    expect(weeklyBlurb(facts)).toMatch(/^Acme uploaded 12 files/);
  });

  it("follows a confident Jev choice and ignores a low-confidence one", () => {
    const row = source();
    const picked = curationFromModel(row, "Acme", {
      answers: {
        lead: { choice: "pull", confidence: 0.8 },
        shot: { choice: "s1", confidence: 0.9 },
      },
    });
    expect(picked.lead).toBe("pull");
    expect(picked.shotIndex).toBe(1);
    const section = sectionFromSource(row, {
      name: "Acme",
      includeActivity: true,
      includeAdmin: false,
      curation: picked,
    });
    expect(section?.blurb.startsWith("acme/web#12")).toBe(true);
    expect(section?.screenshots[0]?.label).toBe("/settings");

    const unsure = curationFromModel(row, "Acme", {
      answers: { lead: { choice: "page", confidence: 0.2 } },
    });
    expect(unsure.lead).toBeUndefined();
    expect(weeklyBlurb(factsFor(row, "Acme", false), unsure.lead)).toMatch(/^Acme uploaded/);
  });

  it("asks Jev with text only and falls back when the call throws", async () => {
    const row = source();
    const request = buildDigestDecideRequest(row, "Acme");
    expect(request?.state).not.toHaveProperty("image");
    expect(JSON.stringify(request)).not.toContain("storage.uploads.sh");
    const run: ClassifierRun = async () => {
      throw new Error("gateway down");
    };
    await expect(curateWorkspace(row, "Acme", run, 50)).resolves.toEqual({});
  });

  it("does not call the model when there is nothing to choose", () => {
    const only = source({
      repos: [],
      shots: [],
      pulls: [],
      issues: [],
      pages: [],
      galleryNames: [],
      galleryCount: 0,
      feeds: 0,
    });
    expect(buildDigestDecideRequest(only, "Acme")).toBeNull();
  });
});
