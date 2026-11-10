import { registerImageWasm } from "./image-wasm";

/**
 * Called from the API worker entry, and from the API test setup. The
 * bundled worker imports the module; Node (vitest) cannot import `.wasm`,
 * so there it is compiled from the file next to this one.
 */
export function installImageWasm(): void {
  registerImageWasm(async () => {
    if (import.meta.url?.startsWith("file:")) {
      const { readFileSync } = await import("node:fs");
      const bytes = readFileSync(new URL("./image.wasm", import.meta.url).pathname);
      // Workers types only declare the bundled-module form.
      const NodeModule = WebAssembly.Module as unknown as new (b: Uint8Array) => WebAssembly.Module;
      return new NodeModule(bytes);
    }
    return (await import("./image-wasm-module")).default;
  });
}
