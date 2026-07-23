// Renders the static OG/social image and touch icons for apps/web/public.
// Usage: node scripts/og/render-og.mjs   (from the repo root; needs a system Chrome)
//
// Outputs:
//   apps/web/public/og/home.png          1200x630  (og:image / twitter:image)
//   apps/web/public/apple-touch-icon.png  180x180
//   apps/web/public/favicon-32x32.png      32x32
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
// playwright-core and sharp are dependencies of packages/uploads, not the repo root.
const require = createRequire(path.join(root, "packages", "uploads", "package.json"));
const { chromium } = require("playwright-core");
const sharp = require("sharp");

/** Screenshot as a palette PNG — flat-color art compresses 3-5x vs raw RGBA. */
async function writePng(page, outPath, screenshotOpts = {}) {
  const raw = await page.screenshot(screenshotOpts);
  await sharp(raw).png({ palette: true, compressionLevel: 9 }).toFile(outPath);
  console.log(`wrote ${path.relative(root, outPath)}`);
}
const pub = path.join(root, "apps", "web", "public");

// Same env overrides as the CLI's detectLocalBrowser (packages/uploads/src/
// screenshot-local.ts) — this trimmed copy avoids importing the package build
// from a dev script, but keep the env var names in sync with it.
const CHROME_CANDIDATES = [
  process.env.UPLOADS_CHROME_PATH,
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);
const executablePath = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!executablePath) {
  console.error("No Chrome found. Set UPLOADS_CHROME_PATH to a Chrome/Chromium binary.");
  process.exit(1);
}

const browser = await chromium.launch({ executablePath, headless: true });
try {
  await mkdir(path.join(pub, "og"), { recursive: true });

  // 1200x630 social card from the HTML template.
  const og = await browser.newPage({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 2,
  });
  await og.goto(pathToFileURL(path.join(here, "home.html")).href);
  await og.evaluate(() => document.fonts.ready);
  await writePng(og, path.join(pub, "og", "home.png"));

  // Touch icons: the shipped favicon.svg (single source of the mark) rendered
  // on a solid ground — iOS screenshots the page when corners are transparent.
  const markSvg = (await readFile(path.join(pub, "favicon.svg"), "utf8")).replace(
    "<svg ",
    `<svg width="100%" height="100%" `,
  );
  const iconHtml = (
    px,
  ) => `<!doctype html><html><body style="margin:0;width:${px}px;height:${px}px;background:#121214;display:grid;place-items:center">
    <div style="width:${Math.round(px * 0.94)}px;height:${Math.round(px * 0.94)}px">${markSvg}</div></body></html>`;
  for (const [px, name] of [
    [180, "apple-touch-icon.png"],
    [32, "favicon-32x32.png"],
  ]) {
    const page = await browser.newPage({ viewport: { width: px, height: px } });
    await page.setContent(iconHtml(px));
    await writePng(page, path.join(pub, name));
  }
} finally {
  await browser.close();
}
