import { describe, expect, it, vi } from "vitest";
import { createUploadsClient } from "../src/client.js";

describe("upsertGithubComment", () => {
  it("POSTs { repo, num, kind } to /v1/:workspace/github/comment and returns the result", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({ posted: true, action: "created", count: 2, commentUrl: "u" }),
          { status: 200 },
        ),
      );
    const client = createUploadsClient({
      apiUrl: "https://api.test",
      workspace: "acme",
      token: "tok",
    });
    const res = await client.upsertGithubComment({ repo: "acme/web", num: 12, kind: "pull" });
    expect(res).toEqual({ posted: true, action: "created", count: 2, commentUrl: "u" });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.test/v1/acme/github/comment");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(new TextDecoder().decode(init?.body as Uint8Array))).toEqual({
      repo: "acme/web",
      num: 12,
      kind: "pull",
    });
    fetchSpy.mockRestore();
  });
});
