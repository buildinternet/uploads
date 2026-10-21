import { describe, expect, it } from "vitest";
import { UsageError } from "../src/cli-args.js";
import type { ListItem, UploadsClient } from "../src/client.js";
import { approveHeldFiles, holdSettingsHint } from "../src/commands.js";

const TARGET = { repo: "o/r", kind: "pull" as const, num: 12 };
const PREFIX = "gh/o/r/pull/12/";

function item(name: string, metadata: Record<string, string> = {}): ListItem {
  return {
    key: `${PREFIX}${name}`,
    url: `https://storage.test/${name}`,
    metadata,
  } as unknown as ListItem;
}

function fakeClient(opts: {
  items?: ListItem[];
  metadata?: Record<string, Record<string, string>>;
}) {
  const approved: string[] = [];
  const held = new Set(
    (opts.items ?? [])
      .filter((entry) => entry.metadata?.["ai.hold"] === "pending")
      .map((entry) => entry.key),
  );
  for (const [key, meta] of Object.entries(opts.metadata ?? {})) {
    if (meta["ai.hold"] === "pending") held.add(key);
  }
  const client = {
    listAll: async (listOpts: { prefix?: string }) =>
      listOpts.prefix === PREFIX ? (opts.items ?? []) : [],
    listHeld: async (prefix: string) =>
      (opts.items ?? [])
        .filter((entry) => entry.key.startsWith(prefix) && held.has(entry.key))
        .map((entry) => ({
          key: entry.key,
          reason: entry.metadata?.["ai.secret"]
            ? `secret: ${entry.metadata["ai.secret"]}`
            : `pii: ${entry.metadata?.["ai.pii"]}`,
          moved: false,
        })),
    getMetadata: async (key: string) => ({ metadata: opts.metadata?.[key] ?? {} }),
    approve: async (key: string) => {
      if (!held.delete(key)) return { key, approved: false, reason: "not_held" };
      approved.push(key);
      return { key, approved: true };
    },
  } as unknown as UploadsClient;
  return { client, approved };
}

describe("approveHeldFiles", () => {
  const items = [
    item("ok.png"),
    item("token.png", { "ai.hold": "pending", "ai.secret": "token" }),
    item("card.png", { "ai.hold": "pending", "ai.pii": "financial" }),
    item("released.png", { "ai.hold": "approved", "ai.secret": "api_key" }),
  ];

  it("lists a PR's held files with a reason and changes nothing without --all", async () => {
    const { client, approved } = fakeClient({ items });
    const result = await approveHeldFiles({ client, target: TARGET });
    expect(result.files).toEqual([
      { key: `${PREFIX}token.png`, action: "held", reason: "secret: token" },
      { key: `${PREFIX}card.png`, action: "held", reason: "pii: financial" },
    ]);
    expect(approved).toEqual([]);
  });

  it("approves every held file on the PR with --all", async () => {
    const { client, approved } = fakeClient({ items });
    const result = await approveHeldFiles({ client, target: TARGET, all: true });
    expect(result.files.map((file) => file.action)).toEqual(["approved", "approved"]);
    expect(approved).toEqual([`${PREFIX}token.png`, `${PREFIX}card.png`]);
  });

  it("writes nothing on --all --dry-run", async () => {
    const { client, approved } = fakeClient({ items });
    const result = await approveHeldFiles({ client, target: TARGET, all: true, dryRun: true });
    expect(result.files.map((file) => file.action)).toEqual(["held", "held"]);
    expect(approved).toEqual([]);
  });

  it("finds a moved hold through the server's held list", async () => {
    const { client } = fakeClient({ items: [item("ok.png")] });
    const moved = `${PREFIX}moved.png`;
    const withHeld = {
      ...client,
      listHeld: async (prefix: string) =>
        prefix === PREFIX ? [{ key: moved, reason: "secret: token", moved: true }] : [],
    } as unknown as UploadsClient;
    const result = await approveHeldFiles({ client: withHeld, target: TARGET });
    expect(result.files).toEqual([{ key: moved, action: "held", reason: "secret: token" }]);
  });

  it("approves explicit keys and reports a key that was not held", async () => {
    const key = `${PREFIX}token.png`;
    const { client, approved } = fakeClient({
      metadata: { [key]: { "ai.hold": "pending" } },
    });
    const result = await approveHeldFiles({ client, keys: [key, `${PREFIX}ok.png`] });
    expect(result.files).toEqual([
      { key, action: "approved" },
      { key: `${PREFIX}ok.png`, action: "not_held" },
    ]);
    expect(approved).toEqual([key]);
  });

  it("dry-runs explicit keys from the held list, so a moved hold still shows", async () => {
    const moved = `${PREFIX}token.png`;
    const { client, approved } = fakeClient({
      items: [item("token.png", { "ai.hold": "pending", "ai.secret": "token" })],
    });
    const result = await approveHeldFiles({
      client,
      keys: [moved, `${PREFIX}ok.png`],
      dryRun: true,
    });
    expect(result.files).toEqual([
      { key: moved, action: "held", reason: "secret: token" },
      { key: `${PREFIX}ok.png`, action: "not_held" },
    ]);
    expect(approved).toEqual([]);
  });

  it("rejects keys together with a target, and --all without one", async () => {
    const { client } = fakeClient({});
    await expect(approveHeldFiles({ client, keys: ["a"], target: TARGET })).rejects.toThrow(
      UsageError,
    );
    await expect(approveHeldFiles({ client, keys: ["a"], all: true })).rejects.toThrow(UsageError);
    await expect(approveHeldFiles({ client })).rejects.toThrow(UsageError);
  });
});

describe("holdSettingsHint", () => {
  it("points at the workspace's AI labels settings on the app origin", () => {
    expect(holdSettingsHint({ apiUrl: "https://api.uploads.sh", workspace: "acme" })).toBe(
      "a workspace admin can turn holds off in Settings → AI labels: https://uploads.sh/account/workspaces/acme/settings/ai-labels",
    );
  });
});
