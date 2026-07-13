import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";

export default defineConfig({
  site: "https://uploads.sh",
  adapter: cloudflare({ imageService: "compile" }),
  integrations: [react()],
  trailingSlash: "never",
  build: {
    format: "file",
  },
});
