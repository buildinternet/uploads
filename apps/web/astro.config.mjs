import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";

/**
 * Serve `public/` during `astro dev`.
 *
 * The Cloudflare Vite plugin routes dev requests through workerd and serves
 * static assets from wrangler's `assets.directory` (`./dist` — the production
 * build output), not from `public/`. With `run_worker_first: ["/*"]` every
 * public asset (favicon, /preview/* hero images, robots.txt) therefore hits
 * the Astro worker, matches no route, and renders 404.astro in dev — prod is
 * unaffected because the build copies `public/` into `dist/`. This tiny
 * middleware answers from `public/` before the worker sees the request,
 * restoring parity. Dev-only: Vite ignores `configureServer` in builds.
 */
const PUBLIC_DIR = fileURLToPath(new URL("./public/", import.meta.url));
const PUBLIC_MIME = {
  ".avif": "image/avif",
  ".css": "text/css",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js": "text/javascript",
  ".json": "application/json",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".xml": "application/xml",
};
function servePublicInDev() {
  return {
    name: "uploads:serve-public-in-dev",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.method !== "GET" && req.method !== "HEAD") return next();
        let pathname;
        try {
          pathname = decodeURIComponent((req.url ?? "").split("?")[0]);
        } catch {
          return next();
        }
        const file = path.normalize(path.join(PUBLIC_DIR, pathname));
        if (!file.startsWith(PUBLIC_DIR)) return next();
        stat(file).then(
          (st) => {
            if (!st.isFile()) return next();
            res.setHeader(
              "Content-Type",
              PUBLIC_MIME[path.extname(file)] ?? "application/octet-stream",
            );
            res.setHeader("Content-Length", String(st.size));
            if (req.method === "HEAD") return res.end();
            createReadStream(file).pipe(res);
          },
          () => next(),
        );
      });
    },
  };
}

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
    plugins: [tailwindcss(), servePublicInDev()],
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
