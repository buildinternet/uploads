import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// apps/auth is otherwise on Vitest defaults (see the note in the repo-root
// vitest.projects.ts). `@uploads/observability` imports the workerd-only
// `cloudflare:workers` module, which plain Node can't resolve, so alias it to
// a minimal test stub.
export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(
        new URL("./src/test/cloudflare-workers-stub.ts", import.meta.url),
      ),
    },
  },
});
