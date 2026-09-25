import { describe, expect, it } from "vitest";
import { tokenAttribution } from "./admin-token-attribution";

const EMAILS = new Map([
  ["u-alice", "alice@example.com"],
  ["u-admin", "admin@example.com"],
]);

describe("tokenAttribution", () => {
  it("names the creating admin for a service token", () => {
    expect(
      tokenAttribution(
        { owner: "workspace", mintingUserId: null, createdByUserId: "u-admin" },
        EMAILS,
      ),
    ).toBe("created by admin@example.com");
  });

  it("names the minting member for a personal token", () => {
    expect(
      tokenAttribution(
        { owner: "member", mintingUserId: "u-alice", createdByUserId: null },
        EMAILS,
      ),
    ).toBe("minted by alice@example.com");
  });

  it("falls back to the raw id when the user is not a current member", () => {
    expect(
      tokenAttribution({ owner: "member", mintingUserId: "u-gone", createdByUserId: null }, EMAILS),
    ).toBe("minted by u-gone");
  });

  it("returns null when the row has no user id", () => {
    expect(
      tokenAttribution({ owner: "member", mintingUserId: null, createdByUserId: null }, EMAILS),
    ).toBeNull();
    expect(
      tokenAttribution({ owner: "workspace", mintingUserId: null, createdByUserId: null }, EMAILS),
    ).toBeNull();
  });
});
