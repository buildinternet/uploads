import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";

/**
 * Vite 8 / Rolldown + @vitejs/plugin-react injects Fast Refresh helpers
 * (`$RefreshSig$`, `/@react-refresh`) into every `.tsx` file. Under the
 * Cloudflare local adapter those helpers often fail to evaluate (missing
 * virtual module, or TDZ/`$RefreshSig$ is not defined`), which aborts any
 * page script that imports a React component — e.g. the workspace page
 * stuck on “Loading workspace…”.
 *
 * We don't need component-level HMR for the account file browser (it mounts
 * via createRoot after a session fetch). Disabling Vite HMR turns off the
 * Fast Refresh transform entirely (`skipFastRefresh`); CSS/full reloads
 * still work via the browser refresh. Production builds already skip this.
 */
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
  vite: {
    plugins: [tailwindcss()],
    server: {
      hmr: false,
    },
    // With `hmr: false` Vite cannot push the full-reload it normally issues
    // after a mid-load dep re-optimization, so any dependency the cold
    // optimizer discovers lazily strands the already-evaluated graph on a
    // second React copy — "Invalid hook call", every island dead until a
    // manual reload. The lazy discoveries (per the dev log) are Astro's own
    // ClientRouter virtual modules, first pulled when a signed-in page
    // loads. Pre-include them so a cold cache has nothing left to discover;
    // dedupe pins one React instance regardless.
    resolve: {
      dedupe: ["react", "react-dom"],
    },
    optimizeDeps: {
      include: [
        "react",
        "react/jsx-runtime",
        "react-dom/client",
        "astro/virtual-modules/transitions-events.js",
        "astro/virtual-modules/transitions-router.js",
        "astro/virtual-modules/transitions-swap-functions.js",
        "astro/virtual-modules/transitions-types.js",
      ],
    },
  },
});
