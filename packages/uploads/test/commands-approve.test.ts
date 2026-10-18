import { describe, expect, it } from "vitest";
import { UsageError } from "../src/cli-args.js";
import type { ListItem, UploadsClient } from "../src/client.js";
import { approveHeldFiles } from "../src/commands.js";

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
      { key: `${PREFIX}card.png`, action: "held", reason: "personal data: financial" },
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

  it("rejects keys together with a target, and --all without one", async () => {
    const { client } = fakeClient({});
    await expect(approveHeldFiles({ client, keys: ["a"], target: TARGET })).rejects.toThrow(
      UsageError,
    );
    await expect(approveHeldFiles({ client, keys: ["a"], all: true })).rejects.toThrow(UsageError);
    await expect(approveHeldFiles({ client })).rejects.toThrow(UsageError);
  });
});
