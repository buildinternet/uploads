import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";

export default defineConfig({
  site: "https://uploads.sh",
  adapter: cloudflare({ imageService: "compile" }),
  integrations: [react()],
  trailingSlash: "never",
  redirects: {
    // Renamed for a more recognizable slug; keep the old path working.
    "/docs/attach": "/docs/attach-pull-request-images",
  },
  build: {
    format: "file",
  },
});
