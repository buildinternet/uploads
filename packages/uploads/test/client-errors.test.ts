import { afterEach, describe, expect, it, vi } from "vitest";
import { createUploadsClient } from "../src/client.js";
import { UploadsError } from "../src/errors.js";

afterEach(() => vi.unstubAllGlobals());

function client() {
  return createUploadsClient({
    apiUrl: "https://api.test",
    workspace: "test",
    token: "up_test_x",
  });
}

describe("insufficient_scope error mapping", () => {
  it("maps to INSUFFICIENT_SCOPE and names the missing scope from details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                type: "insufficient_scope",
                code: "insufficient_scope",
                message: "forbidden",
                details: { required_scope: "files:delete" },
              },
            }),
            { status: 403 },
          ),
      ),
    );
    const err = await client()
      .delete("screenshots/a.png")
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(UploadsError);
    expect((err as UploadsError).code).toBe("INSUFFICIENT_SCOPE");
    expect((err as UploadsError).message).toContain("files:delete");
  });

  it("keeps the server message when details carry no scope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                type: "insufficient_scope",
                code: "insufficient_scope",
                message: "forbidden",
              },
            }),
            { status: 403 },
          ),
      ),
    );
    const err = await client()
      .delete("screenshots/a.png")
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect((err as UploadsError).code).toBe("INSUFFICIENT_SCOPE");
    expect((err as UploadsError).message).toBe("forbidden");
  });
});
