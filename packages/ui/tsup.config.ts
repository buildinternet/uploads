import { copyFileSync } from "node:fs";
import { defineConfig } from "tsup";

/**
 * Emits an ESM `dist/index.js` + `dist/index.d.ts` that /design-sync (and any
 * consumer) can bundle, plus the shipped stylesheet `dist/uploads-ui.css` — the
 * design system's tokens, @font-face rules, and component classes in one file.
 * React stays external so previews load it from the design host's own runtime.
 */
export default defineConfig({
  entry: {
    index: "src/index.ts",
    "components/ui/accordion": "src/components/ui/accordion.tsx",
    "components/ui/alert-dialog": "src/components/ui/alert-dialog.tsx",
    "components/ui/badge": "src/components/ui/badge.tsx",
    "components/ui/button": "src/components/ui/button.tsx",
    "components/ui/checkbox": "src/components/ui/checkbox.tsx",
    "components/ui/combobox": "src/components/ui/combobox.tsx",
    "components/ui/dialog": "src/components/ui/dialog.tsx",
    "components/ui/dropdown-menu": "src/components/ui/dropdown-menu.tsx",
    "components/ui/input": "src/components/ui/input.tsx",
    "components/ui/input-group": "src/components/ui/input-group.tsx",
    "components/ui/label": "src/components/ui/label.tsx",
    "components/ui/popover": "src/components/ui/popover.tsx",
    "components/ui/select": "src/components/ui/select.tsx",
    "components/ui/switch": "src/components/ui/switch.tsx",
    "components/ui/table": "src/components/ui/table.tsx",
    "components/ui/tabs": "src/components/ui/tabs.tsx",
    "components/ui/textarea": "src/components/ui/textarea.tsx",
    "components/ui/tooltip": "src/components/ui/tooltip.tsx",
    "lib/utils": "src/lib/utils.ts",
  },
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: false,
  external: ["react", "react-dom", "react/jsx-runtime"],
  // Ship the authored stylesheet verbatim under the name consumers import.
  onSuccess: async () => {
    copyFileSync("src/styles.css", "dist/uploads-ui.css");
  },
});
