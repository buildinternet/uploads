# Screenshot Annotations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `uploads annotate` + `uploads screenshot --annotate`: bake hand-drawn boxes, arrows, labels, freeform strokes, and redactions onto screenshots before upload, behind a swappable renderer module.

**Architecture:** A self-contained module `packages/uploads/src/annotate/` whose ONLY public surface is its `index.ts` (spec types, `validateSpec`, `renderAnnotations`). Renderer internals: rough.js generator API for sketchy shapes, perfect-freehand for freeform strokes, opentype.js + bundled Excalifont for text-as-paths (bypasses librsvg font resolution entirely — portable), sharp for compositing. CLI commands consume only the module boundary; selectors are resolved to pixel boxes by the screenshot pipeline before the renderer ever runs.

**Tech Stack:** TypeScript ESM, `roughjs` (import from `roughjs/bundled/rough.esm.js` — package entries break under Node ESM), `perfect-freehand`, `opentype.js`, existing `sharp` dep, vitest.

**Spec:** `docs/superpowers/specs/2026-07-24-screenshot-annotations-design.md`. Deviation from spec (approved rationale): the module lives inside `packages/uploads` instead of a `packages/annotate` workspace package, because the published CLI must not depend on private workspace packages (see `src/public-urls.ts` header comment). The interface contract is unchanged.

## Global Constraints

- Node >= 22; plain tsc build (no bundler) — the Excalifont file ships in the npm package via a `files`-included assets path, loaded at runtime with `fs.readFileSync(new URL(...))`, never imported.
- NOTHING outside `src/annotate/index.ts` may be imported from outside the module (enforce by convention + a comment in each internal file).
- `src/annotate/` must NOT be imported (even indirectly) from `index.ts`, `agent.ts`, or `mcp/server.ts` static graphs if it pulls sharp — follow the existing dynamic-import pattern used for `screenshot-local.js`.
- rough.js `seed` fixed (e.g. 7) → deterministic golden tests.
- Repo formats with oxfmt (pre-commit hook handles it). Tests: `pnpm --filter @buildinternet/uploads test -- <file>`.
- Commit after every green task; conventional-commit messages, no sensational adjectives.
- Excalifont: download from excalidraw repo (OFL-1.1); include the OFL license text next to the font file.

---

### Task 1: Annotation spec types + validateSpec

**Files:**

- Create: `packages/uploads/src/annotate/index.ts` (types + re-exports; validate + render live in internal files)
- Create: `packages/uploads/src/annotate/spec.ts`
- Test: `packages/uploads/test/annotate-spec.test.ts`

**Interfaces (Produces):**

```ts
// index.ts re-exports all of these
export type Point = [number, number];
export interface BoxAnnotation {
  type: "box";
  x: number;
  y: number;
  w: number;
  h: number;
  color?: string;
  selector?: string;
}
export interface ArrowAnnotation {
  type: "arrow";
  from: Point;
  to: Point;
  color?: string;
  selector?: string;
} // selector = arrow points at element center; from computed if omitted
export interface LabelAnnotation {
  type: "label";
  text: string;
  target?: Point;
  at?: Point;
  color?: string;
  selector?: string;
}
export interface DrawAnnotation {
  type: "draw";
  points: Point[];
  color?: string;
}
export interface RedactAnnotation {
  type: "redact";
  x: number;
  y: number;
  w: number;
  h: number;
  style?: "blur" | "solid";
  selector?: string;
}
export interface SvgAnnotation {
  type: "svg";
  fragment: string;
}
export type Annotation =
  | BoxAnnotation
  | ArrowAnnotation
  | LabelAnnotation
  | DrawAnnotation
  | RedactAnnotation
  | SvgAnnotation;
export interface AnnotationSpec {
  version: 1;
  annotations: Annotation[];
}
export interface SpecError {
  index: number | null;
  message: string;
}
/** Throws AnnotateSpecError (carries errors: SpecError[]) on invalid input. */
export function validateSpec(json: unknown): AnnotationSpec;
/** True if any annotation still carries an unresolved selector. */
export function hasSelectors(spec: AnnotationSpec): boolean;
/** All distinct selectors in the spec, in order. */
export function specSelectors(spec: AnnotationSpec): string[];
/** Replace selector targeting with pixel geometry using measured boxes keyed by selector. Throws AnnotateSpecError naming any selector missing from boxes. */
export function resolveSelectors(
  spec: AnnotationSpec,
  boxes: Record<string, { x: number; y: number; w: number; h: number }>,
): AnnotationSpec;
```

Validation rules: `version` must be 1; `annotations` non-empty array; per-type required fields present with finite numbers; geometric types accept EITHER pixel geometry OR `selector` (both present → selector wins with a warning entry? NO — reject as ambiguous); `svg.fragment` must not contain `<script` (cheap guard); errors collected per-annotation with index. `resolveSelectors` maps: box/redact → element box; arrow → `to` = box center (`from` = center + [120,-120] clamped later if omitted); label → `target` = box center.

- [ ] **Step 1: Write failing tests** covering: valid full spec parses; wrong version rejected; unknown type rejected with index; box missing `h` rejected; box with both geometry and selector rejected; draw with 1 point rejected (need >= 2); `resolveSelectors` resolves box/arrow/label/redact and errors on missing selector; `hasSelectors`/`specSelectors`.
- [ ] **Step 2: Run tests, verify FAIL** (`pnpm --filter @buildinternet/uploads test -- annotate-spec`).
- [ ] **Step 3: Implement `spec.ts` + `index.ts`.**
- [ ] **Step 4: Tests pass; `pnpm --filter @buildinternet/uploads typecheck`.**
- [ ] **Step 5: Commit** `feat: annotation spec types and validation`.

### Task 2: Renderer — renderAnnotations

**Files:**

- Create: `packages/uploads/src/annotate/render.ts` (SVG overlay assembly + sharp composite)
- Create: `packages/uploads/src/annotate/shapes.ts` (rough.js/perfect-freehand path generation per annotation)
- Create: `packages/uploads/src/annotate/text.ts` (opentype.js text → SVG path, text measurement for callout bubble sizing)
- Create: `packages/uploads/assets/Excalifont-Regular.woff2` → NO: ship **.ttf** (opentype.js parses ttf/otf/woff, not woff2) as `packages/uploads/assets/Excalifont-Regular.ttf` + `packages/uploads/assets/OFL.txt`
- Modify: `packages/uploads/package.json` (add `roughjs`, `perfect-freehand`, `opentype.js` deps; add `"assets"` to `files`)
- Test: `packages/uploads/test/annotate-render.test.ts`, goldens in `packages/uploads/test/goldens/annotate/`

**Interfaces:**

- Consumes: Task 1 types.
- Produces: `renderAnnotations(image: Buffer | Uint8Array, spec: AnnotationSpec, opts?: { seed?: number }): Promise<Buffer>` — throws `AnnotateSpecError` if `hasSelectors(spec)`. Exported from `index.ts`. Out-of-bounds geometry clamps to image bounds with a `process.emitWarning`-free approach: return value stays pure; clamping is silent in the module, the CLI layer warns (Task 3) via a second export: `clampReport(spec, width, height): string[]`.

House style constants in `render.ts`: stroke `#e11d48` (rose-600 accent), strokeWidth 3 (scaled ×deviceScale? no — spec is in image pixels; fixed 3px at 1x, multiply by `opts.scale ?? Math.max(1, round(width/1280))` for hidpi legibility), roughness 1.5, fontSize 28·scale, label bubble: white fill 0.92 opacity, black sketchy border, 8px padding, leader line from bubble edge to target with small arrowhead. Freeform: perfect-freehand `getStroke(points, { size: 4·scale, smoothing: 0.6, streamline: 0.4 })` → filled path. Redact solid: opaque fill `#111`; redact blur: sharp `extract` region → `blur(18)` → composite back BEFORE overlay pass. Arrow: rough line + two rough head strokes. `svg` fragment: injected verbatim into overlay `<g>`.

- [ ] **Step 1: Vendor the font** — download Excalifont ttf from the excalidraw repo (find current path; it ships in excalidraw's public assets, license OFL) + OFL.txt. If only woff2 exists upstream, convert once with `npx wawoff2 decompress` into the ttf. Verify `opentype.parse` loads it in a scratch script.
- [ ] **Step 2: Write failing tests**: (a) render on a synthetic 800×600 sharp-generated base returns a PNG buffer with same dimensions; (b) deterministic — two renders with same seed are byte-identical; (c) golden comparison per annotation type (write goldens on first run via `UPDATE_GOLDENS=1`, then assert byte-equality; pixel-diff tolerance not needed given fixed seed); (d) selector-bearing spec throws; (e) out-of-bounds box clamps (render succeeds, `clampReport` names index).
- [ ] **Step 3: Verify FAIL.**
- [ ] **Step 4: Implement `text.ts` → `shapes.ts` → `render.ts`.** rough.js usage (from spike): `import rough from "roughjs/bundled/rough.esm.js"; const gen = rough.generator({ options: { seed } }); const d = gen.rectangle(x, y, w, h, { stroke, strokeWidth, roughness }); const paths = gen.toPaths(d)` → serialize to `<path d= stroke= stroke-width= fill=…>`. Add a local `.d.ts` (`declare module "roughjs/bundled/rough.esm.js"`) typed against `roughjs`'s own types.
- [ ] **Step 5: Tests pass; visually eyeball one golden.**
- [ ] **Step 6: Commit** `feat: hand-drawn annotation renderer (rough.js + sharp)`.

### Task 3: CLI command `uploads annotate`

**Files:**

- Create: `packages/uploads/src/commands/annotate.ts`
- Modify: command registry where `screenshot` is registered (grep `"screenshot"` in `packages/uploads/src/commands.ts` / router; mirror it for `annotate`, including help index + completion.ts)
- Test: `packages/uploads/test/commands-annotate.test.ts`

**Interfaces:**

- Consumes: `validateSpec`, `renderAnnotations`, `clampReport`, `hasSelectors` via dynamic `await import("../annotate/index.js")` (keeps sharp out of Worker bundles); existing `cli-args`/`cli-style`/`io` helpers (mirror `commands/screenshot.ts` patterns).
- Produces: `uploads annotate <image> --spec <file|-> [-o|--out <file>] [--seed <n>]`. Default out: `<stem>.annotated.png` next to input. Reads spec from file or stdin (`-`). Selector-bearing spec → UsageError: `annotate works on pixels; selectors need "uploads screenshot --annotate" (live page required)`. Invalid spec → exit 1 listing each SpecError as `annotations[i]: message`. Clamp warnings → stderr. `--format json` prints `{ out, width, height, warnings }`.

- [ ] **Step 1: Failing tests** (fake fs pattern from `commands-screenshot.test.ts`): happy path writes PNG; stdin spec; selector spec errors with the exact message; invalid spec lists indexed errors; clamp warning surfaces on stderr.
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implement + register (help text follows the house style of other command help strings — see `SCREENSHOT_HELP`).**
- [ ] **Step 4: PASS + typecheck.**
- [ ] **Step 5: Commit** `feat: uploads annotate command`.

### Task 4: `uploads screenshot --annotate` + selector resolution

**Files:**

- Modify: `packages/uploads/src/screenshot.ts` (thread `measureSelectors?: string[]` through `CaptureScreenshotOptions` and `captureLocalImpl` signature; new result shape)
- Modify: `packages/uploads/src/screenshot-local.ts` (`captureLocal` measures `document.querySelector(sel).getBoundingClientRect()` per selector before capture, multiplies by deviceScaleFactor, returns boxes alongside png)
- Modify: `packages/uploads/src/commands/screenshot.ts` (`--annotate <file|->` flag: parse spec early → fail fast; if `hasSelectors`, require local backend — remote → UsageError `selector annotations need --via local in v1`; after capture, `resolveSelectors` + `renderAnnotations` before the upload/optimize pipeline)
- Test: extend `packages/uploads/test/screenshot.test.ts` + `commands-screenshot.test.ts` (fake `captureLocalImpl` returns canned boxes)

**Interfaces:**

- Consumes: Task 1 `specSelectors/resolveSelectors/hasSelectors`, Task 2 `renderAnnotations`.
- Produces: `captureScreenshot` returns `{ png: Uint8Array; measures?: Record<string, {x,y,w,h}> }` — NOTE: inspect the actual current return type first and extend it compatibly (if it already returns an object, add `measures`; if bare bytes, migrate the two call sites). Selector matching nothing → error naming the selector (no silent skip), thrown from inside the page-eval step.

- [ ] **Step 1: Failing tests**: measureSelectors round-trip through fake captureLocalImpl; scale multiplication (viewport @2x → boxes ×2); missing selector errors with selector named; `--annotate` + remote backend rejected; end-to-end fake capture → annotated bytes handed to upload pipeline (assert renderer called via injected fake — add `renderAnnotationsImpl?` test seam mirroring `captureLocalImpl`).
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: PASS + full `pnpm --filter @buildinternet/uploads test` + typecheck.**
- [ ] **Step 5: Commit** `feat: screenshot --annotate with selector resolution`.

### Task 5: Standalone skill + docs + changeset

**Files:**

- Create: `skills/annotate-screenshots/SKILL.md` (frontmatter name/description like `skills/github-screenshots/SKILL.md`; content: when to annotate, spec format with a full worked example, selector vs pixel guidance — prefer selectors via `screenshot --annotate`; pixel coords only when annotating an existing image; workflow capture → spec → annotate → attach; redaction guidance for secrets)
- Modify: `packages/uploads/src/commands/install.ts` (`SKILL_NAMES` += `annotate-screenshots`; help text)
- Modify: `skills/github-screenshots/SKILL.md` + `skills/uploads-cli/SKILL.md` (short cross-reference lines only)
- Modify: `packages/uploads/README.md` (annotate section, brief)
- Create: `.changeset/<name>.md` — minor bump for `@buildinternet/uploads` (REQUIRED — a missing changeset stranded the screenshot feature once before)
- Test: extend install-command test if `SKILL_NAMES` is asserted anywhere (grep first)

- [ ] **Step 1: Write skill + cross-refs + README + changeset.**
- [ ] **Step 2: `pnpm test` at root green; docs read clean (plain STE-100-ish style per AGENTS.md "Writing docs").**
- [ ] **Step 3: Commit** `feat: annotate-screenshots skill and docs`.

## Verification (after all tasks)

- Full root `pnpm test` + `pnpm --filter @buildinternet/uploads typecheck` + `pack:check` (font asset must land in the tarball).
- Manual smoke: `uploads screenshot https://example.com --annotate /dev/stdin --no-upload --out /tmp/x.png` with a heredoc spec using a selector — eyeball output.
