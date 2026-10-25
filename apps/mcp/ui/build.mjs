import { build } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { fileURLToPath } from "node:url";
import { readFile, writeFile } from "node:fs/promises";

await build({
  root: fileURLToPath(new URL(".", import.meta.url)),
  configFile: false,
  plugins: [tailwindcss(), viteSingleFile()],
  build: {
    target: "es2022",
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    rollupOptions: {
      input: "staged-media.html",
      onwarn(warning, warn) {
        // This entire resource is client-side; React Server Component markers do not apply.
        if (warning.code === "MODULE_LEVEL_DIRECTIVE") return;
        warn(warning);
      },
    },
  },
});
const html = await readFile(new URL("./dist/staged-media.html", import.meta.url), "utf8");
await writeFile(
  new URL("./dist/resource.ts", import.meta.url),
  `export default ${JSON.stringify(html)};\n`,
);
