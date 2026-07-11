import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://uploads.sh",
  // Slash-free URLs end to end. `format: "file"` emits `docs.html` instead of
  // `docs/index.html`, so Workers assets (default auto-trailing-slash) serve
  // /docs directly and redirect /docs/ → /docs — matching the canonical tags,
  // sitemap, robots rules, and every internal link, which are all slash-free.
  trailingSlash: "never",
  build: {
    format: "file",
  },
});
