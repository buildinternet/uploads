import { describe, expect, it } from "vitest";
import { parseExternalReference } from "../src/external-references";

describe("external reference providers", () => {
  it("normalizes GitHub casing and derives identity and URL", () => {
    expect(parseExternalReference("github", "BuildInternet/Uploads#123")).toEqual({
      ok: true,
      value: {
        provider: "github",
        resourceType: "item",
        normalizedKey: "github:item:buildinternet/uploads#123",
        locator: { owner: "buildinternet", repository: "uploads", number: 123 },
        canonicalUrl: "https://github.com/buildinternet/uploads/issues/123",
      },
    });
  });
  it("trims input, accepts case-insensitive providers and valid boundary names", () => {
    expect(parseExternalReference(" GitHub ", " a/.github#1 ")).toMatchObject({
      ok: true,
      value: { normalizedKey: "github:item:a/.github#1" },
    });
    const owner = `a${"b".repeat(37)}z`;
    const repository = `.${"r".repeat(99)}`;
    expect(parseExternalReference("GITHUB", `${owner}/${repository}#9`)).toMatchObject({
      ok: true,
    });
  });
  it.each([
    ["gitlab", "owner/repo#1"],
    ["github", "owner/repo#0"],
    ["github", "owner/repo#-1"],
    ["github", "owner//repo#1"],
    ["github", "owner/repo#9007199254740992"],
    ["github", ".owner/repo#1"],
    ["github", "owner_name/repo#1"],
    ["github", "-owner/repo#1"],
    ["github", "owner-/repo#1"],
    ["github", "owner/..#1"],
    ["github", "owner/.#1"],
    ["github", "owner/repo/extra#1"],
    ["github", "owner/repo#1#2"],
    ["github", "owner/repo#01"],
    ["github", "owner/re\u0000po#1"],
    ["github", `${"a".repeat(40)}/repo#1`],
    ["github", `owner/${"r".repeat(101)}#1`],
  ])("rejects invalid provider/coordinates", (provider, coordinate) => {
    expect(parseExternalReference(provider, coordinate)).toMatchObject({ ok: false });
  });
});
