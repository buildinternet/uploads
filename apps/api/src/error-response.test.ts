import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { respondError } from "./error-response";

function appThrowing(err: unknown) {
  return new Hono()
    .get("/", () => {
      throw err;
    })
    .onError((e, c) => respondError(c, e));
}

describe("respondError: D1 export lock", () => {
  it("answers 503 with Retry-After so clients retry through the nightly backup", async () => {
    const res = await appThrowing(
      new Error("D1_ERROR: Currently processing a long-running export."),
    ).request("/");
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("10");
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("database_export_in_progress");
  });

  it("leaves other unknown errors as 500", async () => {
    const res = await appThrowing(new Error("D1_ERROR: no such table: x")).request("/");
    expect(res.status).toBe(500);
    expect(res.headers.get("Retry-After")).toBeNull();
  });
});
