import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// `src/issues.ts` imports `cloudflare:workers`, which Node cannot resolve.
export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(
        new URL("./src/cloudflare-workers-stub.ts", import.meta.url),
      ),
    },
  },
});
