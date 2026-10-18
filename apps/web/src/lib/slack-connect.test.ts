import { describe, expect, it } from "vitest";
import { connectSlackTicket, isSlackTicketShape, previewSlackTicket } from "./slack-connect";

const TICKET = "abcdefghijklmnopqrstuvwx";

function fakeFetch(status: number, body: unknown, seen: Request[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(new Request(new URL(String(input), "https://uploads.sh"), init));
    return Response.json(body, { status });
  }) as typeof fetch;
}

describe("slack connect client", () => {
  it("previews through the same-origin api proxy with credentials", async () => {
    const seen: Request[] = [];
    const result = await previewSlackTicket("/api", TICKET, {
      fetchImpl: fakeFetch(
        200,
        { teamId: "T1AB", teamName: "Acme", slackUserId: "U1AB", slackUserName: "alice" },
        seen,
      ),
    });
    expect(result).toEqual({
      kind: "ok",
      ticket: { teamId: "T1AB", teamName: "Acme", slackUserId: "U1AB", slackUserName: "alice" },
    });
    expect(new URL(seen[0]!.url).pathname).toBe(`/api/me/slack/connect/${TICKET}`);
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.credentials).toBe("include");
  });

  it("POSTs to consume", async () => {
    const seen: Request[] = [];
    await connectSlackTicket("/api", TICKET, {
      fetchImpl: fakeFetch(200, { teamId: "T1AB", slackUserId: "U1AB", linked: true }, seen),
    });
    expect(seen[0]!.method).toBe("POST");
  });

  it("maps 404 to expired and 401 to signed_out", async () => {
    expect(await previewSlackTicket("/api", TICKET, { fetchImpl: fakeFetch(404, {}) })).toEqual({
      kind: "expired",
    });
    expect(await connectSlackTicket("/api", TICKET, { fetchImpl: fakeFetch(401, {}) })).toEqual({
      kind: "signed_out",
    });
    expect(await connectSlackTicket("/api", TICKET, { fetchImpl: fakeFetch(500, {}) })).toEqual({
      kind: "unavailable",
    });
  });

  it("treats a badly shaped ticket as expired without a request", async () => {
    const seen: Request[] = [];
    expect(isSlackTicketShape("short")).toBe(false);
    expect(
      await previewSlackTicket("/api", "short", { fetchImpl: fakeFetch(200, {}, seen) }),
    ).toEqual({ kind: "expired" });
    expect(seen).toHaveLength(0);
  });
});
