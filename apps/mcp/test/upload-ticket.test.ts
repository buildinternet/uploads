import { describe, expect, it } from "vitest";
import { signUploadTicket, UPLOAD_TICKET_TTL_S, verifyUploadTicket } from "../src/upload-ticket";

const claims = {
  ws: "test-ws",
  who: { kind: "user" as const, userId: "user-1" },
  args: { filename: "shot.png", repo: "acme/web", pr: 12 },
  maxBytes: 1024,
};

describe("upload tickets", () => {
  it("round-trips claims until expiry", async () => {
    const env = { WORKSPACE_SECRETS_KEY: "current" };
    const now = Date.UTC(2026, 9, 21, 12);
    const { ticket, expiresAt } = await signUploadTicket(env, claims, now);
    expect(expiresAt).toBe(new Date(now + UPLOAD_TICKET_TTL_S * 1000).toISOString());

    expect(await verifyUploadTicket(env, ticket, now)).toMatchObject(claims);
    expect(await verifyUploadTicket(env, ticket, now + UPLOAD_TICKET_TTL_S * 1000)).toBeNull();
  });

  it("rejects a different key or an edited payload", async () => {
    const { ticket } = await signUploadTicket({ WORKSPACE_SECRETS_KEY: "current" }, claims);
    expect(await verifyUploadTicket({ WORKSPACE_SECRETS_KEY: "other" }, ticket)).toBeNull();

    const [header, , sig] = ticket.split(".");
    const forged = btoa(JSON.stringify({ ...claims, ws: "victim", exp: 9e9 }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(
      await verifyUploadTicket({ WORKSPACE_SECRETS_KEY: "current" }, `${header}.${forged}.${sig}`),
    ).toBeNull();
  });

  it("still verifies with the previous key during rotation", async () => {
    const { ticket } = await signUploadTicket({ WORKSPACE_SECRETS_KEY: "old" }, claims);
    const rotated = { WORKSPACE_SECRETS_KEY: "new", WORKSPACE_SECRETS_KEY_PREVIOUS: "old" };
    expect(await verifyUploadTicket(rotated, ticket)).toMatchObject(claims);
  });
});
