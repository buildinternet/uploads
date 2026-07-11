import { describe, expect, it } from "vitest";
import { encryptSecret } from "../src/secrets";
import { reencryptRegistryCredentials } from "../src/reencrypt-registry";
import type { WorkspaceRecord } from "../src/workspace";

const CURRENT = "current-master-secret!!";
const PREVIOUS = "previous-master-secret!";

describe("reencryptRegistryCredentials", () => {
  it("rewrites credentials sealed with the previous key", async () => {
    const sealedAk = await encryptSecret(PREVIOUS, "AKIA");
    const sealedSk = await encryptSecret(PREVIOUS, "secret");
    const store = new Map<string, string>([
      [
        "ws:byo",
        JSON.stringify({
          provider: "r2",
          bucket: "other",
          accessKeyId: sealedAk,
          secretAccessKey: sealedSk,
        } satisfies WorkspaceRecord),
      ],
      [
        "ws:shared",
        JSON.stringify({
          provider: "r2",
          bucket: "uploads-default",
          prefix: "shared/",
        } satisfies WorkspaceRecord),
      ],
    ]);

    const env = {
      WORKSPACE_SECRETS_KEY: CURRENT,
      WORKSPACE_SECRETS_KEY_PREVIOUS: PREVIOUS,
      REGISTRY: {
        list: async () => ({
          keys: [...store.keys()].map((name) => ({ name })),
          list_complete: true as const,
          cursor: undefined,
        }),
        get: async (key: string) => {
          const raw = store.get(key);
          return raw ? (JSON.parse(raw) as WorkspaceRecord) : null;
        },
        put: async (key: string, value: string) => {
          store.set(key, value);
        },
      },
    } as unknown as Env;

    const dry = await reencryptRegistryCredentials(env, { dryRun: true });
    expect(dry.updated).toBe(1);
    expect(dry.workspaces.find((w) => w.workspace === "byo")?.action).toBe("would_update");
    // dry-run must not write
    expect(JSON.parse(store.get("ws:byo")!).accessKeyId).toBe(sealedAk);

    const live = await reencryptRegistryCredentials(env, { dryRun: false });
    expect(live.updated).toBe(1);
    const next = JSON.parse(store.get("ws:byo")!) as WorkspaceRecord;
    expect(next.accessKeyId).not.toBe(sealedAk);
    // Decrypt with current alone
    const { openCredentialFields } = await import("../src/secrets");
    const opened = await openCredentialFields(CURRENT, next);
    expect(opened.accessKeyId).toBe("AKIA");
    expect(opened.secretAccessKey).toBe("secret");
    expect(opened.usedPrevious).toBe(false);
  });
});
