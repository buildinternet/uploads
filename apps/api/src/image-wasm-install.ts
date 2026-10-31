import { registerImageWasm } from "./image-wasm";

/**
 * Called from the API worker entry. Node tests cannot import `.wasm`, so
 * there the module is absent and every caller takes the JS path.
 */
export function installImageWasm(): void {
  registerImageWasm(async () => {
    if (import.meta.url?.startsWith("file:")) return undefined;
    return (await import("./image-wasm-module")).default;
  });
}
