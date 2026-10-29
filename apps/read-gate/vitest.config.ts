import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vitest/config";

// Vitest would turn `import x from "./file.png"` into a file URL. Wrangler
// loads that import as an ArrayBuffer (`rules` in wrangler.jsonc). This
// plugin does the same so the suite reads the bytes the Worker returns.
function pngBytes(): Plugin {
  return {
    name: "read-gate-png-bytes",
    enforce: "pre",
    load(id) {
      const file = id.split("?")[0];
      if (!file?.endsWith(".png")) return null;
      const bytes = [...readFileSync(file)];
      return `export default new Uint8Array([${bytes.join(",")}]).buffer;`;
    },
  };
}

export default defineConfig({
  plugins: [pngBytes()],
});
