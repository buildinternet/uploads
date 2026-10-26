import { describe, expect, it } from "vitest";
import type { ClassifierRun } from "./classifier";
import {
  blankSource,
  buildDigestDecideRequest,
  curationFromModel,
  curateWorkspace,
  digestWindow,
  draftsForRecipient,
  hasAdminPulse,
  notableRepo,
  slugsWorthCurating,
  storagePressurePercent,
  type DigestMembership,
  type DigestRecipient,
  type WorkspaceDigestSource,
} from "./weekly-digest";

function source(over: Partial<WorkspaceDigestSource> = {}): WorkspaceDigestSource {
  return {
    ...blankSource("acme"),
    uploads: 37,
    prevUploads: 25,
    bytesAdded: 80_000_000,
    repos: [{ name: "acme/web", count: 8, prev: 1 }],
    shots: [
      {
        key: "a.png",
        label: "/billing",
        url: "https://storage.uploads.sh/acme/a.png",
        embedUrl: "https://embed.uploads.sh/acme/a.png",
        at: "2026-10-11T00:00:00.000Z",
        repo: "acme/web",
        number: 4,
        kind: "pull",
      },
      {
        key: "b.png",
        label: "/settings",
        url: "https://storage.uploads.sh/acme/b.png",
        embedUrl: "https://embed.uploads.sh/acme/b.png",
        at: "2026-10-12T00:00:00.000Z",
        repo: "acme/web",
        number: 12,
        kind: "pull",
      },
    ],
    pulls: [
      {
        repo: "acme/web",
        number: 12,
        title: "Digest settings",
        count: 4,
        state: "merged",
        shot: {
          url: "https://storage.uploads.sh/acme/b.png",
          embedUrl: "https://embed.uploads.sh/acme/b.png",
        },
      },
    ],
    activePeople: 8,
    newPeople: 2,
    storageBytes: 1_200_000_000,
    ...over,
  };
}

function draftForRecipient(
  ...args: Parameters<typeof draftsForRecipient>
): ReturnType<typeof draftsForRecipient>[number] | null {
  const drafts = draftsForRecipient(...args);
  if (drafts.length > 1) {
    throw new Error(`expected at most one draft, got ${drafts.length}`);
  }
  return drafts[0] ?? null;
}

function membership(over: Partial<DigestMembership> = {}): DigestMembership {
  return {
    slug: "acme",
    orgName: "Acme",
    role: "member",
    digest: true,
    workspaceDigest: false,
    ...over,
  };
}

function recipient(over: Partial<DigestRecipient> = {}): DigestRecipient {
  return {
    userId: "user-1",
    email: "ada@example.com",
    name: "Ada",
    memberships: [membership()],
    ...over,
  };
}

describe("weekly digest assembly", () => {
  it("skips a workspace whose only signal is a storage snapshot", () => {
    const quiet = source({
      uploads: 0,
      prevUploads: 0,
      bytesAdded: 0,
      repos: [],
      shots: [],
      pulls: [],
      activePeople: 0,
      newPeople: 0,
      storageBytes: 9_000_000,
    });
    expect(hasAdminPulse(quiet)).toBe(false);
    expect(draftForRecipient(recipient(), new Map([["acme", quiet]]), "Oct 5–12")).toBeNull();
  });

  it("builds one highlight, the busiest pull request, and a stat line for a member", () => {
    const draft = draftForRecipient(recipient(), new Map([["acme", source()]]), "Oct 5–12");
    expect(draft?.user?.uploads).toBe(37);
    expect(draft?.user?.repos).toBe(1);
    expect(draft?.user?.workspaceSlug).toBe("acme");
    expect(draft?.user?.highlight?.caption).toBe("/settings");
    expect(draft?.user?.highlight?.href).toBe("https://github.com/acme/web/pull/12");
    expect(draft?.user?.topPull).toMatchObject({
      title: "Digest settings",
      state: "merged",
      href: "https://github.com/acme/web/pull/12",
    });
    expect(draft?.pulses).toEqual([]);
    expect(draft?.unsubscribes).toEqual(["digest"]);
  });

  it("does not link a repo name that is not owner/name", () => {
    const draft = draftForRecipient(
      recipient(),
      new Map([
        [
          "acme",
          source({
            shots: [
              {
                key: "a.png",
                label: "note",
                url: "https://storage.uploads.sh/acme/a.png",
                embedUrl: null,
                at: "2026-10-12T00:00:00.000Z",
                repo: "not a repo",
                number: 3,
                kind: "pull",
              },
            ],
            pulls: [{ repo: "not a repo", number: 3, title: null, count: 1, state: "open" }],
          }),
        ],
      ]),
      "Oct 5–12",
    );
    expect(draft?.user?.highlight?.href).toBeUndefined();
    expect(draft?.user?.topPull?.href).toBeUndefined();
    expect(draft?.user?.topPull?.title).toBe("not a repo#3");
  });

  it("sends an admin pulse with deltas and only the notable links", () => {
    const row = source({
      firstUploads: { count: 1, name: "Ada" },
      storageLimitBytes: 1_400_000_000,
    });
    const draft = draftForRecipient(
      recipient({
        memberships: [membership({ role: "owner", digest: false, workspaceDigest: true })],
      }),
      new Map([["acme", row]]),
      "Oct 5–12",
    );
    expect(draft?.user).toBeUndefined();
    expect(draft?.unsubscribes).toEqual(["workspace"]);
    const pulse = draft?.pulses[0]?.pulse;
    expect(pulse?.uploadsDelta).toBe(12);
    expect(pulse?.activeMembersNew).toBe(2);
    expect(pulse?.storageDeltaBytes).toBe(80_000_000);
    expect(pulse?.notes).toEqual([
      { text: "acme/web got busy — 8 files, up from 1" },
      { text: "Ada's first upload" },
    ]);
    expect(pulse?.storageNote).toEqual({
      text: "Storage is at 86% of the plan",
      href: "/account/workspaces/acme/billing",
    });
  });

  it("leaves the callout list empty when the week is ordinary", () => {
    const row = source({
      repos: [{ name: "acme/web", count: 2, prev: 2 }],
      newPeople: 0,
      activePeople: 3,
    });
    expect(notableRepo(row.repos)).toBeNull();
    expect(storagePressurePercent(row.storageBytes, 10_000_000_000)).toBeNull();
    const draft = draftForRecipient(
      recipient({
        memberships: [membership({ role: "admin", digest: false, workspaceDigest: true })],
      }),
      new Map([["acme", row]]),
      "Oct 5–12",
    );
    expect(draft?.pulses[0]?.pulse.notes).toEqual([]);
  });

  it("sends a storage warning without turning on the member digest", () => {
    const row = source({
      uploads: 0,
      prevUploads: 0,
      bytesAdded: 0,
      repos: [],
      shots: [],
      pulls: [],
      activePeople: 0,
      newPeople: 0,
      storageBytes: 220_000_000,
      storageLimitBytes: 250_000_000,
    });
    const draft = draftForRecipient(
      recipient({
        memberships: [membership({ role: "admin", digest: true, workspaceDigest: true })],
      }),
      new Map([["acme", row]]),
      "Oct 5–12",
    );
    expect(draft?.user).toBeUndefined();
    expect(draft?.unsubscribes).toEqual(["workspace"]);
    expect(draft?.pulses[0]?.pulse.notes).toEqual([]);
    expect(draft?.pulses[0]?.pulse.storageNote?.text).toBe("Storage is at 88% of the plan");
    expect(draft?.pulses[0]?.pulse.storageNote?.href).toBe("/account/workspaces/acme/billing");
  });

  it("puts both parts in one email when both preferences are on", () => {
    const draft = draftForRecipient(
      recipient({
        memberships: [membership({ role: "owner", digest: true, workspaceDigest: true })],
      }),
      new Map([["acme", source()]]),
      "Oct 5–12",
    );
    expect(draft?.unsubscribes).toEqual(["digest", "workspace"]);
    expect(draft?.user?.highlight?.caption).toBe("/settings");
    expect(draft?.pulses).toHaveLength(1);
  });

  it("sends one admin email per workspace, busiest first", () => {
    const sources = new Map<string, WorkspaceDigestSource>();
    const memberships = [];
    for (let i = 0; i < 5; i += 1) {
      const slug = `ws-${i}`;
      sources.set(slug, source({ slug, uploads: 10 - i, repos: [] }));
      memberships.push(
        membership({ slug, orgName: slug, role: "owner", digest: false, workspaceDigest: true }),
      );
    }
    const drafts = draftsForRecipient(recipient({ memberships }), sources, "Oct 5–12");
    expect(drafts).toHaveLength(5);
    expect(drafts.every((draft) => draft.pulses.length === 1 && !draft.user)).toBe(true);
    expect(drafts.map((draft) => draft.pulses[0]?.pulse.uploads)).toEqual([10, 9, 8, 7, 6]);
  });

  it("sends a separate member email per workspace and skips a quiet one", () => {
    const beta = source({
      slug: "beta",
      uploads: 4,
      repos: [{ name: "beta/web", count: 4, prev: 1 }],
      shots: [],
      pulls: [],
    });
    const quiet = source({
      slug: "quiet",
      uploads: 0,
      prevUploads: 0,
      bytesAdded: 0,
      repos: [],
      shots: [],
      pulls: [],
      activePeople: 0,
      newPeople: 0,
      storageBytes: 0,
    });
    const drafts = draftsForRecipient(
      recipient({
        memberships: [
          membership(),
          membership({ slug: "beta", orgName: "Beta" }),
          membership({ slug: "quiet", orgName: "Quiet" }),
        ],
      }),
      new Map([
        ["acme", source()],
        ["beta", beta],
        ["quiet", quiet],
      ]),
      "Oct 5–12",
    );
    expect(drafts.map((draft) => draft.user?.workspaceName)).toEqual(["Acme", "Beta"]);
    expect(drafts.map((draft) => draft.user?.uploads)).toEqual([37, 4]);
    expect(drafts.map((draft) => draft.user?.workspaceSlug)).toEqual(["acme", "beta"]);
    expect(drafts.every((draft) => draft.pulses.length === 0)).toBe(true);
  });

  it("sends only the workspaces that membership opted into", () => {
    const drafts = draftsForRecipient(
      recipient({
        memberships: [
          membership({ role: "owner", digest: true, workspaceDigest: false }),
          membership({ slug: "beta", orgName: "Beta", digest: false, workspaceDigest: true }),
          membership({
            slug: "gamma",
            orgName: "Gamma",
            role: "owner",
            digest: false,
            workspaceDigest: true,
          }),
        ],
      }),
      new Map([
        ["acme", source()],
        ["beta", source({ slug: "beta" })],
        ["gamma", source({ slug: "gamma", uploads: 3, repos: [] })],
      ]),
      "Oct 5–11",
    );
    expect(drafts.map((draft) => draft.user?.workspaceSlug ?? draft.pulses[0]?.slug)).toEqual([
      "acme",
      "gamma",
    ]);
    expect(drafts.find((draft) => draft.pulses[0]?.slug === "gamma")?.user).toBeUndefined();
  });
});

describe("digestWindow", () => {
  it("labels a Monday-to-Monday window as seven calendar days", () => {
    const window = digestWindow(new Date("2026-10-12T14:00:00.000Z"));
    expect(window.sinceDay).toBe("2026-10-05");
    expect(window.weekLabel).toBe("Oct 5–11");
  });

  it("names both months when the seven days cross a month", () => {
    expect(digestWindow(new Date("2026-11-02T14:00:00.000Z")).weekLabel).toBe("Oct 26–Nov 1");
  });

  it("names both months when the seven days cross a year", () => {
    expect(digestWindow(new Date("2027-01-04T14:00:00.000Z")).weekLabel).toBe("Dec 28–Jan 3");
  });
});

describe("slugsWorthCurating", () => {
  it("skips a workspace whose membership did not opt into the member digest", () => {
    const sources = new Map<string, WorkspaceDigestSource>([
      ["acme", source()],
      ["beta", source({ slug: "beta" })],
    ]);
    const slugs = slugsWorthCurating(
      [
        recipient({
          memberships: [
            membership({ digest: true }),
            membership({ slug: "beta", orgName: "Beta", digest: false, workspaceDigest: true }),
          ],
        }),
      ],
      sources,
    );
    expect(slugs).toEqual(["acme"]);
  });
});

describe("weekly digest highlight", () => {
  it("keeps the newest screenshot when the model is not consulted", () => {
    const draft = draftForRecipient(recipient(), new Map([["acme", source()]]), "Oct 5–12");
    expect(draft?.user?.highlight?.caption).toBe("/settings");
  });

  it("follows a confident Jev choice and ignores a low-confidence one", () => {
    const row = source();
    // Newest first, so s0 is /settings and s1 is the older /billing shot.
    const picked = curationFromModel(row, {
      answers: { shot: { choice: "s1", confidence: 0.9 } },
    });
    expect(picked.shotIndex).toBe(1);
    const draft = draftForRecipient(
      recipient(),
      new Map([["acme", row]]),
      "Oct 5–12",
      new Map([["acme", { shotIndex: 1 }]]),
    );
    expect(draft?.user?.highlight?.caption).toBe("/billing");

    const unsure = curationFromModel(row, {
      answers: { shot: { choice: "s1", confidence: 0.2 } },
    });
    expect(unsure.shotIndex).toBeUndefined();
    const fallback = draftForRecipient(recipient(), new Map([["acme", row]]), "Oct 5–12");
    expect(fallback?.user?.highlight?.caption).toBe("/settings");
  });

  it("asks Jev with text only and falls back when the call throws", async () => {
    const row = source();
    const request = buildDigestDecideRequest(row);
    expect(request?.questions).toHaveProperty("shot");
    expect(request?.questions).not.toHaveProperty("lead");
    expect(request?.state).not.toHaveProperty("image");
    expect(JSON.stringify(request)).not.toContain("storage.uploads.sh");
    expect(JSON.stringify(request)).toContain("/settings");
    const run: ClassifierRun = async () => {
      throw new Error("gateway down");
    };
    await expect(curateWorkspace(row, run, 50)).resolves.toEqual({});
    const draft = draftForRecipient(recipient(), new Map([["acme", row]]), "Oct 5–12");
    expect(draft?.user?.highlight?.caption).toBe("/settings");
  });

  it("does not call the model when there is only one screenshot", () => {
    const only = source({ shots: source().shots.slice(0, 1) });
    expect(buildDigestDecideRequest(only)).toBeNull();
  });
});
