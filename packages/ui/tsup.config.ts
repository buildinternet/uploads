import { copyFileSync } from "node:fs";
import { defineConfig } from "tsup";

/**
 * Emits an ESM `dist/index.js` + `dist/index.d.ts` that /design-sync (and any
 * consumer) can bundle, plus the shipped stylesheet `dist/uploads-ui.css` — the
 * design system's tokens, @font-face rules, and component classes in one file.
 * React stays external so previews load it from the design host's own runtime.
 */
export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: false,
  external: ["react", "react-dom", "react/jsx-runtime"],
  // Ship the authored stylesheet verbatim under the name consumers import.
  onSuccess: async () => {
    copyFileSync("src/styles.css", "dist/uploads-ui.css");
  },
});
