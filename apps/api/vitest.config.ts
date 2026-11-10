import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Workspace auth calls `setIssueContext`, which imports `cloudflare:workers`.
export default defineConfig({
  test: {
    setupFiles: ["./test/setup-image-wasm.ts"],
  },
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(
        new URL("../../packages/observability/src/cloudflare-workers-stub.ts", import.meta.url),
      ),
    },
  },
});
