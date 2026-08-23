import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// apps/auth is otherwise on Vitest defaults (see the note in the repo-root
// vitest.projects.ts). The single reason this file exists: src/index.ts
// re-exports the `RateLimitCounter` Durable Object, which extends
// `DurableObject` from the workerd-only `cloudflare:workers` module. Plain
// Node can't resolve that specifier, so index.test.ts would fail at import
// time. Alias it to a minimal test stub.
export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(
        new URL("./src/test/cloudflare-workers-stub.ts", import.meta.url),
      ),
    },
  },
});
