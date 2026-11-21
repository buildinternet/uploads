import { describe, expect, it } from "vitest";
import { app } from "../src/index";

describe("POST /v1/render (removed)", () => {
  it("answers 410 with an actionable message, without auth", async () => {
    const res = await app.request("/v1/render", { method: "POST", body: "{}" }, {});
    expect(res.status).toBe(410);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("render_removed");
    expect(body.error.message).toMatch(/install Chrome/);
  });
});
