import { describe, expect, it } from "vitest";
import { resourceModule } from "../ui/resource-module.mjs";

async function emitted(html) {
  return import(`data:text/javascript,${encodeURIComponent(resourceModule(html))}`);
}

describe("built UI resource identity", () => {
  it("uses the HTML bytes as the build identity and keeps identical builds stable", async () => {
    const built = await emitted("abc");
    const hash = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    expect(built.default).toBe("abc");
    expect(built.buildHash).toBe(hash);
    expect(built.resourceUri).toBe(`ui://uploads/media/c1/${hash}.html`);
    expect((await emitted("abc")).resourceUri).toBe(built.resourceUri);
    expect((await emitted("abcd")).resourceUri).not.toBe(built.resourceUri);
  });
});
