# design-sync notes — @uploads/ui

Repo-specific gotchas for future syncs of the uploads.sh design system.

## Converter harness (`.ds-sync/`)

Same layout as either/releases: **project inputs** live under committed
`.design-sync/`; the **converter scripts** are staged into gitignored
`.ds-sync/` at the repo root (never committed). Invocations always use
`node .ds-sync/…` against this tree.

### Restaging after a clean

`.ds-sync/` is machine state. A fresh clone, `git clean`, or wiping the dir
removes it — re-stage from the `/design-sync` skill (or any surviving sibling
checkout that still has the tree, e.g. another repo's `.ds-sync/`):

```bash
mkdir -p .ds-sync
# From the skill base dir, or a known-good .ds-sync copy:
cp -R <skill-or-copy>/{package-build.mjs,package-validate.mjs,package-capture.mjs,resync.mjs,lib,storybook} .ds-sync/
# Install converter deps in ONE npm command (separate --no-save installs prune
# each other):
(cd .ds-sync && npm i esbuild ts-morph @types/react playwright)
# Optional render/capture browser:
(cd .ds-sync && npx playwright install chromium)
```

Do not commit `.ds-sync/` or its `node_modules`.

### Claude worktrees

`.worktreeinclude` lists `.ds-sync/` so Claude Code copies the staged harness
from the **main checkout** into new worktrees (same mechanism as `.env`). That
only helps when main already has a staged tree; it does not replace restaging
after a full clean. Plain `git worktree add` does not read `.worktreeinclude` —
restage by hand (or copy from main) in those worktrees.

## Build

- Shape is **package** (no Storybook). Source lives in `packages/ui/src/`, built
  with **tsup** → `packages/ui/dist/{index.js,index.d.ts,uploads-ui.css}`.
- `cfg.buildCmd` = `pnpm --filter @uploads/ui build`. That needs the package's
  devDeps installed. In an isolated worktree with no workspace install, build it
  standalone: `cd packages/ui && npm install --no-save --no-package-lock && npm run build`
  (npm avoids pnpm workspace resolution; approve the esbuild postinstall).
  **Use `npm run build`, not `npx tsup`.** `tsup.config.ts` sets `dts: false`, so
  tsup alone emits only `index.js` + `uploads-ui.css`; the 12 `.d.ts` files come
  from the second half of the build script (`tsc -p tsconfig.build.json
  --emitDeclarationOnly --outDir dist`). Skip it and every `<Name>Props` contract
  the design agent codes against degrades silently.
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
- **No component-scoped custom-property *declarations* — thread per-instance
  color through `color`/`currentColor` instead.** claude.ai/design's
  `check_design_system` treats every `--*` declaration as a design token and
  flags any declared outside a theme scope (`:root` / `[data-theme]`). A
  component that needs one color knob shared across an element and its
  pseudo-elements (e.g. Progress's fill + dither cap) must set `color:
  var(--token)` on the element (overriding per `[data-*]`) and consume it as
  `currentColor` — **not** declare a `--ul-*` custom property on a component
  selector. Do **not** "fix" such a finding by hoisting the property to `:root`:
  the value varies per instance, so hoisting breaks it. Consume-with-fallback
  (`var(--ul-x, 116px)`, like `--ul-files-min-height`) is also fine — it's never
  *declared*, so it isn't flagged.
- **`@kind` token annotations are load-bearing — do not strip them.** The token
  declarations in `src/styles.css` / `src/tokens.css` carry trailing comments the
  claude.ai/design compiler reads to classify tokens: `--sans`/`--mono`/`--pixel`
  → `/* @kind font */`, `--pixel-shape` → `/* @kind other */` (a `1/0` flag, not a
  color). Without them the compiler misgroups/flags those tokens. oxfmt preserves
  the trailing comments; keep them on the same line as the declaration's `;`.

## Render check

- Playwright + chromium live under `.ds-sync/node_modules` (see restage above —
  install with the other converter deps in one `npm i`). On a fresh clone the
  `.ds-sync/` tree is gitignored and regenerated, so reinstall before validating.
- 7 components use `cfg.overrides.<Name>.cardMode = "column"` (Button, Divider,
  Field, GalleryTile, Panel, Progress, Select) to resolve `[GRID_OVERFLOW]` — their
  previews are wider than a grid cell. Not a warn once the override is applied.
- **Progress and Select were added to that list on the 2026-08-14 re-sync.** The
  2026-08-14 sync recorded them as fitting the default card width; a later converter
  measures grid cells differently and flagged both `[GRID_OVERFLOW]` (`wide`). If a
  future converter flags more components the same way, the remedy is the same one
  the warn names — merge `cardMode: "column"`, then
  `preview-rebuild.mjs --components <them>`; grades carry through it.
- No `[RENDER_THIN]` / `variants-identical` warns to record — all cells graded good.
- **Progress** and **Select** were added to `@uploads/ui` and authored on the
  2026-08-14 sync (`previews/Progress.tsx`, `previews/Select.tsx`) — 3 cells each,
  all graded good (both later needed `cardMode: "column"`, see above). Select is a
  new export from `Field.tsx` (`ul-select` / compact `ul-select--sm`); Progress is
  its own file (`ul-progress__*`, `data-level` fill bands). Both added to
  `conventions.md`. That brought the DS from 12 → 14 components.

## Re-sync risks

- **Sync from an up-to-date `main`, and check before uploading.** A sync uploads
  whatever the working tree builds, so a stale base silently *reverts* merged
  design-system fixes in the Claude Design project — the anchor diff can't catch
  it, because the bundle genuinely changed and looks like a legitimate update.
  This bit us on 2026-08-14: a worktree branched at #663 re-synced ~1h after #664
  merged and re-uploaded the pre-#664 stylesheet, restoring the exact
  `--ul-progress-fill` declaration #664 removed. The design agent kept reporting
  the finding and was correct. **Run `git fetch && git log --oneline -3
  origin/main` before the build**, and after building grep the bundle for
  whatever the most recent DS fix removed
  (`grep -c 'ul-progress-fill' ds-bundle/_ds_bundle.css` → expect 0).
- **Harness is not in git** — if `.ds-sync/` is missing, restage before build/
  validate (see "Converter harness" above). Worktrees only inherit it when main
  already has a staged copy.
- Previews (`.design-sync/previews/*.tsx`) import from `'@uploads/ui'` and are fully
  self-contained: no network, no fixtures. `GalleryTile` thumbnails are inline SVG
  data-URIs. Safe to re-render on any machine.
- `.design-sync/conventions.md` enumerates real tokens/props/components validated
  against the build. If `packages/ui` renames a token or component, re-validate the
  header (the base skill's conventions step does this) and fix drift.
  **Drift is usually additive, not renames** — the 2026-08-14 re-sync found
  `Button.variant` had gained `"solid"` (a real variant with its own
  `ul-btn--solid` CSS) while the header still listed only four. Nothing the header
  named was wrong, so a name-existence check alone passes; also diff each
  enumerated union against the fresh `<Name>.d.ts` for *added* members, or the
  design agent never learns the new option exists.
- The scoped `npm install` in `packages/ui` writes no lockfile (`--no-package-lock`),
  so the exact tsup/esbuild versions aren't pinned there — the committed
  `package.json` ranges are the source of truth. A real `pnpm install` at repo root
  is the canonical build path.
