import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// MCP auth calls `setIssueContext`, which imports `cloudflare:workers`.
export default defineConfig({
  // Mirrors wrangler.jsonc `rules`: `.md` imports (the served skills) are text.
  plugins: [
    {
      name: "md-text",
      transform(code, id) {
        if (id.endsWith(".md")) return `export default ${JSON.stringify(code)};`;
      },
    },
  ],
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(
        new URL("../../packages/observability/src/cloudflare-workers-stub.ts", import.meta.url),
      ),
    },
  },
});
