import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The mention agent's spans import `cloudflare:workers` (src/tracing.ts).
export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(
        new URL("./test/cloudflare-workers-stub.ts", import.meta.url),
      ),
    },
  },
});
