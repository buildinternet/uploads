import { describe, expect, it } from "vitest";
import { renderIssuedTokenListHtml, tokenAccessLabel } from "./developers-ui";

describe("tokenAccessLabel", () => {
  it("calls out read-only and stays quiet for the default read+write grant", () => {
    expect(tokenAccessLabel(["files:read"])).toBe("read-only");
    expect(tokenAccessLabel(["files:read", "files:write"])).toBe("");
  });
});

describe("renderIssuedTokenListHtml", () => {
  it("renders the empty state and a used read-only row", () => {
    expect(renderIssuedTokenListHtml([])).toMatch(/No tokens yet/);
    const html = renderIssuedTokenListHtml([
      {
        id: "tok-1",
        workspace: "acme",
        label: "ci",
        scopes: ["files:read"],
        createdAt: "2026-08-01T00:00:00.000Z",
        expiresAt: null,
        lastUsedAt: "2026-08-17T12:00:00.000Z",
      },
    ]);
    expect(html).toMatch(/read-only/);
    expect(html).toMatch(/no expiry/);
    expect(html).toMatch(/last used 2026-08-17/);
    expect(html).toMatch(/data-token-id="tok-1"/);
  });
});
