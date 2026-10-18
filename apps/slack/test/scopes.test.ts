import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { describe, expect, it } from "vitest";
import { API_SLACK_BOT_SCOPES } from "../../api/src/slack-scopes";
import { BOT_SCOPES, canRun, missingFeaturesText, missingScopes, parseScopes } from "../src/scopes";

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new NodeURL("../manifest.json", import.meta.url)), "utf8"),
) as {
  oauth_config: { scopes: { bot: string[] } };
};

describe("scopes", () => {
  it("requests exactly the manifest's bot scopes, and the API mirrors them", () => {
    const fromManifest = [...manifest.oauth_config.scopes.bot].sort();
    expect([...BOT_SCOPES]).toEqual(fromManifest);
    expect([...API_SLACK_BOT_SCOPES].sort()).toEqual(fromManifest);
  });

  it("names what an older install is missing", () => {
    const old = parseScopes("links:read, links:write,users:read");
    expect(missingScopes(old)).toEqual(["chat:write", "im:write"]);
    expect(canRun(old, "unfurl")).toBe(true);
    expect(canRun(old, "holds")).toBe(false);
    expect(missingFeaturesText(old)).toBe("held-upload messages");
    expect(missingFeaturesText(parseScopes("links:read"))).toBe(
      "link previews, connecting accounts and held-upload messages",
    );
    expect(missingFeaturesText(parseScopes(BOT_SCOPES.join(",")))).toBeNull();
  });
});
