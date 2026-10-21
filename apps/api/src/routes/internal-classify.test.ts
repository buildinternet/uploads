import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { respondError } from "../error-response";

const schedule = vi.fn((..._args: unknown[]) => true);
vi.mock("../classifier", async (orig) => ({
  ...(await orig<typeof import("../classifier")>()),
  scheduleFileClassification: (...a: unknown[]) => schedule(...a),
}));
vi.mock("../workspace", async (orig) => ({
  ...(await orig<typeof import("../workspace")>()),
  loadWorkspaceRecord: async (_env: unknown, name: string) =>
    name === "acme" ? { provider: "r2", bucket: "b", name } : null,
}));

const { internalClassify } = await import("./internal-classify");

const app = new Hono()
  .route("/internal/classify", internalClassify)
  .onError((err, c) => respondError(c, err));

const ctx = { waitUntil: vi.fn(), passThroughOnException: () => undefined, props: {} };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

function post(host: string, query: string, body: Uint8Array = PNG) {
  return app.request(
    `https://${host}/internal/classify?${query}`,
    { method: "POST", body, headers: { "Content-Type": "image/png" } },
    {},
    ctx as unknown as ExecutionContext,
  );
}

beforeEach(() => {
  schedule.mockClear();
});

describe("POST /internal/classify", () => {
  it("schedules classification of the posted bytes", async () => {
    const res = await post("api.internal", "workspace=acme&key=shots/a.png&enforceHold=1");
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ scheduled: true });
    expect(schedule).toHaveBeenCalledTimes(1);
    const [, ws, name, key, bytes, contentType, , opts] = schedule.mock.calls[0]!;
    expect(ws).toMatchObject({ name: "acme" });
    expect([name, key, contentType]).toEqual(["acme", "shots/a.png", "image/png"]);
    expect(bytes).toEqual(PNG);
    expect(opts).toEqual({ enforceHold: true });
  });

  it("only holds when asked", async () => {
    await post("api.internal", "workspace=acme&key=shots/a.png");
    expect(schedule.mock.calls[0]![7]).toEqual({ enforceHold: false });
  });

  it("404s off the internal host, for an unknown workspace, or a bad key", async () => {
    expect((await post("api.uploads.sh", "workspace=acme&key=shots/a.png")).status).toBe(404);
    expect((await post("api.internal", "workspace=other&key=shots/a.png")).status).toBe(404);
    expect((await post("api.internal", "workspace=acme&key=../a.png")).status).toBe(404);
    expect((await post("api.internal", "workspace=acme")).status).toBe(404);
    expect(schedule).not.toHaveBeenCalled();
  });
});
