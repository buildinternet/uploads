# design-sync notes — @uploads/ui

Repo-specific gotchas for future syncs of the uploads.sh design system.

## Build

- Shape is **package** (no Storybook). Source lives in `packages/ui/src/`, built
  with **tsup** → `packages/ui/dist/{index.js,index.d.ts,uploads-ui.css}`.
- `cfg.buildCmd` = `pnpm --filter @uploads/ui build`. That needs the package's
  devDeps installed. In an isolated worktree with no workspace install, build it
  standalone: `cd packages/ui && npm install --no-save --no-package-lock && npx tsup`
  (npm avoids pnpm workspace resolution; approve the esbuild postinstall).
- Converter invocation (from repo root):
  `node .ds-sync/package-build.mjs --config .design-sync/config.json --node-modules packages/ui/node_modules --entry ./packages/ui/dist/index.js --out ./ds-bundle`
  `PKG_DIR` is walked up from `--entry`, so the entry must be the real
  `packages/ui/dist/index.js` path, not `./dist/...`.

## Fonts

- `packages/ui/fonts/` holds three self-hosted woff2: `geist.woff2` and
  `geist-mono.woff2` (the **latin variable** files copied from
  `@fontsource-variable/geist@5.2.9` / `geist-mono@5.2.8`), and `geist-pixel.woff2`
  (from `apps/web/src/styles/fonts/geist-pixel`, SIL OFL — see `GeistPixel-OFL.txt`).
- `@font-face` rules live in `src/styles.css` (= `dist/uploads-ui.css` = `cfg.cssEntry`)
  and reference `../fonts/*.woff2`, a path that resolves from both `src/` and `dist/`.
  If a Geist version bumps, refresh these three files; otherwise `[FONT_MISSING]` is impossible.

## Styling

- `cfg.cssEntry` = `dist/uploads-ui.css` — one self-contained stylesheet carrying
  the `:root` token layer + `@font-face` + every `ul-` component class. No separate
  tokens package/glob; tokens are inline there and ship via the `styles.css` closure.

## Render check

- Playwright + chromium were installed into `.ds-sync/node_modules` (`npm i playwright`
  + `npx playwright install chromium`). On a fresh clone the `.ds-sync/` tree is
  gitignored and regenerated, so reinstall before validating.
- 5 components use `cfg.overrides.<Name>.cardMode = "column"` (Button, Divider,
  Field, GalleryTile, Panel) to resolve `[GRID_OVERFLOW]` — their previews are wider
  than a grid cell. Not a warn once the override is applied.
- No `[RENDER_THIN]` / `variants-identical` warns to record — all 22 cells graded good.

## Re-sync risks

- Previews (`.design-sync/previews/*.tsx`) import from `'@uploads/ui'` and are fully
  self-contained: no network, no fixtures. `GalleryTile` thumbnails are inline SVG
  data-URIs. Safe to re-render on any machine.
- `.design-sync/conventions.md` enumerates real tokens/props/components validated
  against the build. If `packages/ui` renames a token or component, re-validate the
  header (the base skill's conventions step does this) and fix drift.
- The scoped `npm install` in `packages/ui` writes no lockfile (`--no-package-lock`),
  so the exact tsup/esbuild versions aren't pinned there — the committed
  `package.json` ranges are the source of truth. A real `pnpm install` at repo root
  is the canonical build path.
