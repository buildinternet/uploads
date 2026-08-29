import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageAlertEvent } from "@uploads/email";
import { runUsageAlertSweep } from "./usage-alert-sweep";
import { usagePeriodStart } from "./usage";

type UsageSeed = { bytes?: number; uploads?: number };

/** Minimal D1 double for getWorkspaceUsage: prepare().bind(ws).first(). */
function fakeDb(usage: Record<string, UsageSeed>) {
  return {
    prepare() {
      return {
        bind(ws: string) {
          return {
            async first() {
              const u = usage[ws];
              if (!u) return null;
              return {
                workspace: ws,
                bytes: u.bytes ?? 0,
                objects: 0,
                shared_bytes: 0,
                shared_objects: 0,
                uploads_in_period: u.uploads ?? 0,
                period_start: usagePeriodStart(),
                updated_at: new Date().toISOString(),
              };
            },
          };
        },
      };
    },
  };
}

/** KV double: `ws:` records come back for get(key,"json"); markers are text. */
function fakeRegistry(records: Record<string, unknown>, markers = new Map<string, string>()) {
  return {
    markers,
    async list({ prefix }: { prefix: string }) {
      const keys = Object.keys(records)
        .filter((k) => k.startsWith(prefix))
        .map((name) => ({ name }));
      return { keys, list_complete: true, cursor: undefined };
    },
    async get(key: string, type?: string) {
      if (type === "json") return records[key] ?? null;
      return markers.get(key) ?? null;
    },
    async put(key: string, value: string) {
      markers.set(key, value);
    },
    async delete(key: string) {
      markers.delete(key);
    },
  };
}

function fakeAuth() {
  const posts: Array<{ slug: string; events: UsageAlertEvent[]; plan?: string }> = [];
  return {
    posts,
    fetch: vi.fn(async (_url: string, init: RequestInit) => {
      posts.push(JSON.parse(String(init.body)));
      return new Response(null, { status: 200 });
    }),
  };
}

function makeEnv(opts: {
  records: Record<string, unknown>;
  usage: Record<string, UsageSeed>;
  markers?: Map<string, string>;
}) {
  const REGISTRY = fakeRegistry(opts.records, opts.markers);
  const AUTH = fakeAuth();
  const DB = fakeDb(opts.usage);
  const env = { REGISTRY, AUTH, DB } as unknown as Env;
  return { env, REGISTRY, AUTH };
}

/** Workspace with explicit free-tier-shaped caps (plan-undefined keeps them). */
function wsRecord(over: Record<string, unknown> = {}) {
  return {
    name: "acme",
    version: 1,
    maxStorageBytes: 250_000_000,
    maxUploadsPerPeriod: 3000,
    ...over,
  };
}

describe("runUsageAlertSweep", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("posts a storage crossing once and dedups on re-run", async () => {
    const setup = {
      records: { "ws:acme": wsRecord() },
      usage: { acme: { bytes: 230_000_000 } }, // 92% → band 90
      markers: new Map<string, string>(),
    };
    const { env, AUTH } = makeEnv(setup);

    const r1 = await runUsageAlertSweep(env);
    expect(r1.crossings).toBe(1);
    expect(AUTH.posts).toHaveLength(1);
    expect(AUTH.posts[0]).toEqual({
      slug: "acme",
      events: [{ cap: "storage", threshold: 90, used: 230_000_000, limit: 250_000_000 }],
    });
    expect(setup.markers.get("usage:alert:acme:storage")).toBe("90");

    // Second sweep, same state → no new email.
    const env2 = makeEnv(setup).env; // reuse the same markers map
    const r2 = await runUsageAlertSweep(env2);
    expect(r2.crossings).toBe(0);
  });

  it("forwards the workspace plan so the email copy can stay plan-accurate", async () => {
    const { env, AUTH } = makeEnv({
      records: { "ws:acme": wsRecord({ plan: "pro", maxStorageBytes: 10_000_000_000 }) },
      usage: { acme: { bytes: 9_500_000_000 } }, // 95%
    });
    await runUsageAlertSweep(env);
    expect(AUTH.posts[0].plan).toBe("pro");
  });

  it("fires at 100% when uploads hit the cap", async () => {
    const { env, AUTH } = makeEnv({
      records: { "ws:acme": wsRecord() },
      usage: { acme: { uploads: 3000 } }, // 100%
    });
    await runUsageAlertSweep(env);
    expect(AUTH.posts[0].events).toEqual([
      { cap: "uploads", threshold: 100, used: 3000, limit: 3000 },
    ]);
  });

  it("combines both caps into one email when they cross together", async () => {
    const { env, AUTH } = makeEnv({
      records: { "ws:acme": wsRecord() },
      usage: { acme: { bytes: 230_000_000, uploads: 1500 } }, // storage 90, uploads 50
    });
    await runUsageAlertSweep(env);
    expect(AUTH.posts).toHaveLength(1);
    expect(AUTH.posts[0].events.map((e) => `${e.cap}:${e.threshold}`).sort()).toEqual([
      "storage:90",
      "uploads:50",
    ]);
  });

  it("re-arms as usage recedes, then re-alerts on a fresh crossing", async () => {
    const markers = new Map<string, string>([["usage:alert:acme:storage", "90"]]);

    // Receded to 55% (137.5M) — no email, marker drops to 50.
    const receded = makeEnv({
      records: { "ws:acme": wsRecord() },
      usage: { acme: { bytes: 137_500_000 } },
      markers,
    });
    await runUsageAlertSweep(receded.env);
    expect(receded.AUTH.posts).toHaveLength(0);
    expect(markers.get("usage:alert:acme:storage")).toBe("50");

    // Climbs back to 92% — re-alerts at 90.
    const climbed = makeEnv({
      records: { "ws:acme": wsRecord() },
      usage: { acme: { bytes: 230_000_000 } },
      markers,
    });
    await runUsageAlertSweep(climbed.env);
    expect(climbed.AUTH.posts).toHaveLength(1);
    expect(climbed.AUTH.posts[0].events[0].threshold).toBe(90);
  });

  it("does not alert below 50% and writes no marker", async () => {
    const markers = new Map<string, string>();
    const { env, AUTH } = makeEnv({
      records: { "ws:acme": wsRecord() },
      usage: { acme: { bytes: 100_000_000 } }, // 40%
      markers,
    });
    await runUsageAlertSweep(env);
    expect(AUTH.posts).toHaveLength(0);
    expect(markers.has("usage:alert:acme:storage")).toBe(false);
  });

  it("skips legacy/unlimited workspaces (no caps)", async () => {
    const { env, AUTH } = makeEnv({
      records: { "ws:legacy": { name: "legacy", version: 1 } }, // no plan, no caps
      usage: { legacy: { bytes: 999_000_000_000 } },
    });
    const r = await runUsageAlertSweep(env);
    expect(r.workspacesScanned).toBe(1);
    expect(AUTH.posts).toHaveLength(0);
  });

  it("skips soft-deleted workspaces and purged tombstones", async () => {
    const { env, AUTH } = makeEnv({
      records: {
        "ws:gone": wsRecord({ name: "gone", deletedAt: "2026-08-01T00:00:00.000Z" }),
        "ws:dead": { status: "purged", name: "dead", purgedAt: "2026-08-01T00:00:00.000Z" },
      },
      usage: { gone: { bytes: 250_000_000 }, dead: { bytes: 250_000_000 } },
    });
    await runUsageAlertSweep(env);
    expect(AUTH.posts).toHaveLength(0);
  });
});
