import { describe, expect, it } from "vitest";
import {
  renderIssuedTokenListHtml,
  renderServiceTokenListHtml,
  tokenAccessLabel,
} from "./developers-ui";

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
    expect(html).toMatch(/data-revoke-label="ci"/);
    expect(html).toMatch(/data-revoke-workspace="acme"/);
  });
});

describe("renderServiceTokenListHtml", () => {
  it("renders the empty state and spells out access on each row", () => {
    expect(renderServiceTokenListHtml([])).toMatch(/No service tokens yet/);
    const html = renderServiceTokenListHtml([
      {
        id: "svc-1",
        label: "CI <main>",
        scopes: ["files:read", "files:write"],
        createdAt: "2026-09-01T00:00:00.000Z",
        expiresAt: "2026-11-30T00:00:00.000Z",
        lastUsedAt: null,
        createdByUserId: "user-1",
      },
      {
        id: "svc-2",
        label: "docs bot",
        scopes: ["files:read"],
        createdAt: "2026-09-02T00:00:00.000Z",
        expiresAt: null,
        lastUsedAt: "2026-09-20T08:00:00.000Z",
        createdByUserId: null,
      },
    ]);
    expect(html).toMatch(/read &amp; write · created 2026-09-01 · expires 2026-11-30 · never used/);
    expect(html).toMatch(/read-only · created 2026-09-02 · no expiry · last used 2026-09-20/);
    expect(html).toMatch(/data-revoke="svc-1" data-revoke-label="CI &lt;main&gt;"/);
    expect(html).not.toMatch(/<main>/);
  });
});
