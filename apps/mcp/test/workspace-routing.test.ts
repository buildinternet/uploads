import { describe, expect, it } from "vitest";
import { chooseWorkspace } from "../src/workspace-routing";

describe("chooseWorkspace", () => {
  const choices = ["aw-labs", "rr"];

  it("uses the repo's workspace when the user belongs to it", () => {
    expect(chooseWorkspace({ defaultName: "aw-labs", choices, repoWorkspace: "rr" })).toBe("rr");
  });

  it("keeps the default for a repo bound to a workspace the user isn't in, or unbound", () => {
    expect(chooseWorkspace({ defaultName: "aw-labs", choices, repoWorkspace: "acme" })).toBe(
      "aw-labs",
    );
    expect(chooseWorkspace({ defaultName: "aw-labs", choices, repoWorkspace: null })).toBe(
      "aw-labs",
    );
  });

  it("lets an explicit workspace win over the repo", () => {
    expect(
      chooseWorkspace({
        defaultName: "aw-labs",
        choices,
        requested: "aw-labs",
        repoWorkspace: "rr",
      }),
    ).toBe("aw-labs");
  });

  it("refuses a workspace outside the choices", () => {
    expect(() => chooseWorkspace({ defaultName: "aw-labs", choices, requested: "acme" })).toThrow(
      /aw-labs, rr/,
    );
  });

  it("pins a credential with no choices", () => {
    expect(
      chooseWorkspace({ defaultName: "aw-labs", choices: undefined, repoWorkspace: "rr" }),
    ).toBe("aw-labs");
    expect(() =>
      chooseWorkspace({ defaultName: "aw-labs", choices: undefined, requested: "rr" }),
    ).toThrow(/only acts in workspace "aw-labs"/);
  });
});
