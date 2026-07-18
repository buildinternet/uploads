import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";

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
    server: {
      hmr: false,
    },
  },
});
