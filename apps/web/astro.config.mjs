import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";

export default defineConfig({
  site: "https://uploads.sh",
  adapter: cloudflare({ imageService: "compile" }),
  trailingSlash: "never",
  build: {
    format: "file",
  },
});
