import { build } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { fileURLToPath } from "node:url";

for (const [index, page] of ["gallery", "harness"].entries()) {
  await build({
    root: fileURLToPath(new URL(".", import.meta.url)),
    configFile: false,
    plugins: [viteSingleFile()],
    build: { emptyOutDir: index === 0, rollupOptions: { input: `${page}.html` } },
  });
}
