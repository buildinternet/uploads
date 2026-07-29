# File page before/after comparison — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two-up thumbnail strip on the public file page with a Compare mode on the main image stage, driven by a draggable before/after slider, plus a Comparison row in the right rail.

**Architecture:** `ImagePreview.astro` — the component that already owns the stage's Fit / Full width modes — gains an optional `compare` prop and a second pill group that switches the stage between a single image and an `img-comparison-slider` web component. The page (`f/[workspace]/[...key].astro`) stops rendering `.pair` and instead passes `compare` down and renders a rail section. All pure derivations (own before/after role, image ordering, rail rows) move out of the `.astro` frontmatter into a unit-tested lib module.

**Tech Stack:** Astro 7, Cloudflare Workers SSR, vanilla `<script>` (no framework JS on public pages), `img-comparison-slider` (MIT web component), vitest.

**Spec:** `docs/superpowers/specs/2026-07-28-file-page-before-after-compare-design.md`

## Global Constraints

- **No framework JS on public pages.** The `/f/` page ships zero React today. Do not add a `client:*` directive or import React here. The slider is a custom element precisely for this reason.
- **No changeset.** `apps/web` is an ignored package for changesets; adding one silently blocks every npm publish. Do not create one.
- **Formatting is `oxfmt`, not prettier.** It runs automatically via lint-staged on commit. Do not run prettier.
- **Commit style:** `feat(web): …` / `test(web): …` / `chore(web): …`. No "comprehensive"/"world-class" wording.
- **The API guarantees both sides are images.** `counterpart` is only populated when this file _and_ the candidate pass `isPairableImageContentType` (`apps/api/src/routes/public-files.ts:198-224`). Do not add content-type plumbing.
- **Dependency target:** `img-comparison-slider@^8.0.7`, added to `apps/web` only.
- Run `pnpm --filter @uploads/web test` for unit tests and `pnpm typecheck` before the final commit.

---

## File Structure

| File                                              | Responsibility                                                                                                                                     |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/lib/before-after-view.ts`           | **New.** All pure derivations for the paired view: own role, before/after image ordering, rail rows. No DOM.                                       |
| `apps/web/src/lib/before-after-view.test.ts`      | **New.** Unit tests for the above.                                                                                                                 |
| `apps/web/src/components/ImagePreview.astro`      | Owns the stage: Fit / Full width, click-to-zoom, and now the single ⇄ compare view switch and the slider markup/styles/script.                     |
| `apps/web/src/pages/f/[workspace]/[...key].astro` | Page composition only: resolves the counterpart, passes `compare` to `ImagePreview`, renders the Comparison rail section. Loses the `.pair` block. |
| `apps/web/package.json`                           | Adds the `img-comparison-slider` dependency.                                                                                                       |

---

### Task 1: Spike — prove the component registers mismatched images

The spec requires this before any other work. The component's README does not
document how it lays out images of differing dimensions, and real before/after
screenshot pairs are routinely a few pixels apart. If the two layers do not stay
registered, the whole approach changes.

**Files:**

- Modify: `apps/web/package.json`
- Temporary (deleted at the end of this task): a scratch HTML page

- [ ] **Step 1: Add the dependency**

```bash
pnpm --filter @uploads/web add img-comparison-slider@^8.0.7
```

- [ ] **Step 2: Confirm it is dependency-free and small**

```bash
pnpm --filter @uploads/web why img-comparison-slider
```

Expected: `img-comparison-slider 8.x` with no transitive runtime dependencies of
its own. If it pulls in a framework, stop and report — that contradicts the
premise of the choice.

- [ ] **Step 3: Write the scratch page**

Create `apps/web/public/__spike.html` (deleted in Step 6). Two deliberately
mismatched images: 800×600 and 780×590, each with a marker in the same corner so
mis-registration is visible.

```html
<!doctype html>
<meta charset="utf-8" />
<style>
  body {
    background: #111;
    margin: 0;
    padding: 40px;
  }
  .stage {
    width: 700px;
    margin: 0 auto;
  }
  img-comparison-slider {
    display: block;
    width: 100%;
  }
  img-comparison-slider img {
    display: block;
    width: 100%;
    height: auto;
    object-fit: contain;
  }
</style>
<div class="stage">
  <img-comparison-slider value="50">
    <img slot="first" src="https://placehold.co/800x600/222/fff?text=BEFORE+%E2%97%8F" />
    <img slot="second" src="https://placehold.co/780x590/333/fff?text=AFTER+%E2%97%8F" />
  </img-comparison-slider>
</div>
<script type="module">
  import "img-comparison-slider";
</script>
```

If the machine has no network access for `placehold.co`, generate two local PNGs
of those exact dimensions instead and reference them by relative path — the
point of the spike is the dimension mismatch, not the image source.

- [ ] **Step 4: Run the web dev server and look at it**

```bash
pnpm dev:web
```

Open `http://localhost:4321/__spike.html` in the browser panel. Drag the divider
across the full width.

- [ ] **Step 5: Judge the result and record it**

PASS means: both images fill the same box, their corner markers sit at the same
place, and dragging reveals the second image without it jumping, offsetting, or
scaling differently from the first.

FAIL means: the layers are offset, one is stretched independently, or the
component sizes itself to zero height.

Record the verdict in the plan file under this task (one or two sentences plus a
screenshot), then:

- **On PASS** — continue to Task 2 as written.
- **On FAIL** — **stop and surface it to the user before writing any more code.**
  The spec's documented fallback is to hand-roll the divider: a visually-hidden
  `<input type="range" min="0" max="100">` as the source of truth, driven by
  `pointerdown`/`pointermove` with `setPointerCapture`, with the pointer-x → percent
  math in a pure, unit-tested `apps/web/src/lib/image-compare.ts`. That is a
  decision point for the user, not a silent substitution.

- [ ] **Step 6: Delete the scratch page and commit the dependency**

```bash
rm apps/web/public/__spike.html
git add apps/web/package.json pnpm-lock.yaml
git commit -m "chore(web): add img-comparison-slider for the paired file view"
```

---

### Task 2: Pure derivations for the paired view

**Files:**

- Create: `apps/web/src/lib/before-after-view.ts`
- Test: `apps/web/src/lib/before-after-view.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `type BeforeAfterState = "before" | "after"`
  - `ownBeforeAfterState(metadataState: string | undefined, counterpartState: BeforeAfterState): BeforeAfterState`
  - `compareImages(ownState: BeforeAfterState, ownUrl: string, counterpartUrl: string): { beforeUrl: string; afterUrl: string }`
  - `comparisonRows(ownState: BeforeAfterState, counterpartHref: string): ComparisonRow[]`
  - `interface ComparisonRow { state: BeforeAfterState; current: boolean; href: string | null }`

`ownBeforeAfterState` moves verbatim out of the page's frontmatter
(`f/[workspace]/[...key].astro:108-114`), where it is currently untestable.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/lib/before-after-view.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { comparisonRows, compareImages, ownBeforeAfterState } from "./before-after-view";

describe("ownBeforeAfterState", () => {
  it("trusts this file's own state metadata when it is valid", () => {
    expect(ownBeforeAfterState("before", "after")).toBe("before");
    expect(ownBeforeAfterState("after", "before")).toBe("after");
  });

  it("falls back to the counterpart's opposite when metadata is missing", () => {
    expect(ownBeforeAfterState(undefined, "after")).toBe("before");
    expect(ownBeforeAfterState(undefined, "before")).toBe("after");
  });

  it("ignores junk metadata rather than trusting it", () => {
    expect(ownBeforeAfterState("sideways", "before")).toBe("after");
    expect(ownBeforeAfterState("", "after")).toBe("before");
  });

  // The API pairs on `state` metadata, so both sides claiming the same role is
  // not supposed to happen — but the page must still render a stable order.
  it("keeps its own claim even when both sides claim the same role", () => {
    expect(ownBeforeAfterState("after", "after")).toBe("after");
  });
});

describe("compareImages", () => {
  it("puts the before image first when this file is the after", () => {
    expect(compareImages("after", "own.png", "other.png")).toEqual({
      beforeUrl: "other.png",
      afterUrl: "own.png",
    });
  });

  it("puts this file first when it is the before", () => {
    expect(compareImages("before", "own.png", "other.png")).toEqual({
      beforeUrl: "own.png",
      afterUrl: "other.png",
    });
  });
});

describe("comparisonRows", () => {
  it("always orders before then after, regardless of which one this is", () => {
    expect(comparisonRows("after", "/f/ws/before.png").map((r) => r.state)).toEqual([
      "before",
      "after",
    ]);
    expect(comparisonRows("before", "/f/ws/after.png").map((r) => r.state)).toEqual([
      "before",
      "after",
    ]);
  });

  it("links only the counterpart row and marks the current one", () => {
    const rows = comparisonRows("after", "/f/ws/before.png");
    expect(rows).toEqual([
      { state: "before", current: false, href: "/f/ws/before.png" },
      { state: "after", current: true, href: null },
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @uploads/web test before-after-view
```

Expected: FAIL — `Failed to resolve import "./before-after-view"`.

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/lib/before-after-view.ts`:

```ts
/**
 * Pure derivations for the file page's before/after paired view (issue #420).
 *
 * The API has already done the visibility- and content-type-safe counterpart
 * lookup (apps/api/src/routes/public-files.ts); everything here is layout
 * bookkeeping, kept out of the page's frontmatter so it can be tested.
 */

export type BeforeAfterState = "before" | "after";

/** One row of the rail's Comparison section; `href` is null for this file. */
export interface ComparisonRow {
  state: BeforeAfterState;
  current: boolean;
  href: string | null;
}

/**
 * This file's own role, given the counterpart it was paired with. Uses its own
 * `state` metadata when that is one of the two valid values, else it is simply
 * the counterpart's opposite.
 */
export function ownBeforeAfterState(
  metadataState: string | undefined,
  counterpartState: BeforeAfterState,
): BeforeAfterState {
  if (metadataState === "before" || metadataState === "after") return metadataState;
  return counterpartState === "before" ? "after" : "before";
}

/** Which URL goes on each side of the slider, whichever half this page is. */
export function compareImages(
  ownState: BeforeAfterState,
  ownUrl: string,
  counterpartUrl: string,
): { beforeUrl: string; afterUrl: string } {
  return ownState === "before"
    ? { beforeUrl: ownUrl, afterUrl: counterpartUrl }
    : { beforeUrl: counterpartUrl, afterUrl: ownUrl };
}

/** Both roles, always before-then-after, with only the counterpart linked. */
export function comparisonRows(
  ownState: BeforeAfterState,
  counterpartHref: string,
): ComparisonRow[] {
  return (["before", "after"] as const).map((state) => ({
    state,
    current: state === ownState,
    href: state === ownState ? null : counterpartHref,
  }));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @uploads/web test before-after-view
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/before-after-view.ts apps/web/src/lib/before-after-view.test.ts
git commit -m "feat(web): pure derivations for the before/after paired view"
```

---

### Task 3: Compare mode in the image stage

**Files:**

- Modify: `apps/web/src/components/ImagePreview.astro` (whole file — frontmatter, markup, script, styles)

**Interfaces:**

- Consumes: `compareImages`, `BeforeAfterState` from Task 2.
- Produces: `ImagePreview` accepts a new optional prop
  `compare?: { src: string; ownState: BeforeAfterState } | null` (default `null`).
  When omitted, rendering and behavior are byte-for-byte what they are today.

This component has no unit tests today (it is markup plus a DOM script) and this
task does not add a test harness for it — its verification is the browser pass in
Task 5. The testable logic it uses lives in Task 2.

- [ ] **Step 1: Extend the frontmatter**

Replace the frontmatter block (lines 1-15) with:

```astro
---
/**
 * Public image stage with Fit / Full width controls.
 *
 * Fit: compact, viewport-capped (photos / wide UI).
 * Full width: stage grows with the image; page scroll (tall screenshots).
 * Tall images auto-open full width. Mode resolution: `lib/image-preview-mode.ts`.
 *
 * When `compare` is supplied the stage gains a second, independent axis: the
 * view switch between this image alone and a draggable before/after slider
 * (`img-comparison-slider`, a custom element — the public file page ships no
 * framework runtime and must keep it that way).
 */
import { compareImages, type BeforeAfterState } from "../lib/before-after-view";

interface Props {
  src: string;
  alt: string;
  /** The counterpart image and this file's own role; omit for unpaired files. */
  compare?: { src: string; ownState: BeforeAfterState } | null;
}

const { src, alt, compare = null } = Astro.props;
const pair = compare ? compareImages(compare.ownState, src, compare.src) : null;
/** The counterpart's URL — the one layer that can 404 out from under us. */
const counterpartUrl = compare?.src ?? null;
---
```

- [ ] **Step 2: Extend the markup**

Replace the markup block (the `<div class="media image-preview">` element) with:

```astro
<div class="media image-preview" data-mode="fit" data-view="single" data-image-preview>
  {pair && (
    <div class="view-toggle" role="group" aria-label="Comparison view">
      <button type="button" data-view-btn="single" aria-pressed="true">This image</button>
      <button type="button" data-view-btn="compare" aria-pressed="false">Compare</button>
    </div>
  )}
  <div class="size-toggle" role="group" aria-label="Preview size">
    <button type="button" data-size="fit" aria-pressed="true">Fit</button>
    <button type="button" data-size="full" aria-pressed="false">Full width</button>
  </div>
  <img class="single-image" src={src} alt={alt} decoding="async" />
  {pair && (
    <div class="compare-wrap">
      <img-comparison-slider value="50">
        <img
          slot="first"
          src={pair.beforeUrl}
          alt={`Before: ${alt}`}
          decoding="async"
          loading="lazy"
          data-counterpart={pair.beforeUrl === counterpartUrl ? "true" : null}
        />
        <img
          slot="second"
          src={pair.afterUrl}
          alt={`After: ${alt}`}
          decoding="async"
          loading="lazy"
          data-counterpart={pair.afterUrl === counterpartUrl ? "true" : null}
        />
      </img-comparison-slider>
      <span class="compare-label compare-label--before" aria-hidden="true">before</span>
      <span class="compare-label compare-label--after" aria-hidden="true">after</span>
    </div>
  )}
</div>
```

The `aria-hidden` labels are decoration — the slotted images already carry
"Before: …" / "After: …" alt text, so a screen reader gets the roles without the
duplication.

- [ ] **Step 3: Extend the script**

In the `<script>` block, add the import at the top (alongside the existing
`image-preview-mode` import):

```ts
import "img-comparison-slider";
```

Then add this function above `initPreview`:

```ts
type CompareView = "single" | "compare";

function applyView(root: HTMLElement, view: CompareView): void {
  root.dataset.view = view;
  for (const btn of root.querySelectorAll<HTMLButtonElement>("button[data-view-btn]")) {
    btn.setAttribute("aria-pressed", btn.dataset.viewBtn === view ? "true" : "false");
  }
}

/**
 * Wire the single ⇄ compare switch. No-op for unpaired files. If the
 * counterpart image fails to load, the switch removes itself rather than
 * offering a mode that would show a broken half.
 */
function initCompare(root: HTMLElement): void {
  const wrap = root.querySelector<HTMLElement>(".compare-wrap");
  const toggle = root.querySelector<HTMLElement>(".view-toggle");
  if (!wrap || !toggle) return;

  for (const btn of toggle.querySelectorAll<HTMLButtonElement>("button[data-view-btn]")) {
    btn.addEventListener("click", () => {
      const view = btn.dataset.viewBtn;
      if (view !== "single" && view !== "compare") return;
      applyView(root, view);
    });
  }

  const counterpart = wrap.querySelector<HTMLImageElement>("img[data-counterpart]");
  if (!counterpart) return;
  const drop = () => {
    applyView(root, "single");
    toggle.remove();
    wrap.remove();
  };
  if (counterpart.complete && counterpart.naturalWidth === 0) drop();
  else counterpart.addEventListener("error", drop, { once: true });
}
```

Call it from `initPreview`, immediately after the `previewReady` guard:

```ts
initCompare(root);
```

Finally, make click-to-zoom yield in compare mode — in compare mode a click on
the stage is the slider's own "jump the divider here" gesture. Replace the
existing image click handler with:

```ts
img.addEventListener("click", () => {
  if (root.dataset.view === "compare") return;
  override = root.dataset.mode === "full" ? "fit" : "full";
  applyMode(root, override);
});
```

- [ ] **Step 4: Extend the styles**

The `.size-toggle` rules already describe the pill-group look. Make the view
toggle share them by widening the existing selectors: replace every
`.size-toggle` selector in the `<style>` block with `.size-toggle, .view-toggle`
(and `.size-toggle button` with `.size-toggle button, .view-toggle button`, and
so on for `:hover`, `:focus-visible`, and `[aria-pressed="true"]`). Then add the
positional and compare-specific rules:

```css
.view-toggle {
  right: auto;
  left: 10px;
}

.compare-wrap {
  position: relative;
  display: none;
  width: 100%;
}

.image-preview[data-view="compare"] .compare-wrap {
  display: block;
}

.image-preview[data-view="compare"] > .single-image {
  display: none;
}

img-comparison-slider {
  display: block;
  width: 100%;
  --divider-width: 2px;
  --divider-color: var(--accent);
  --default-handle-width: 44px;
  --default-handle-color: var(--accent);
}

/* Custom elements upgrade client-side only; without this the two slotted
     images render stacked for a frame before the component takes over. */
img-comparison-slider:not(:defined) {
  visibility: hidden;
}

img-comparison-slider img {
  display: block;
  width: 100%;
  height: auto;
  object-fit: contain;
}

.image-preview[data-mode="fit"] img-comparison-slider img {
  max-height: var(--preview-max-h);
}

.compare-label {
  position: absolute;
  bottom: 10px;
  z-index: 2;
  padding: 4px 9px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--panel) 82%, transparent);
  color: var(--muted);
  font: 10.5px var(--mono);
  letter-spacing: 0.12em;
  text-transform: uppercase;
  pointer-events: none;
}

.compare-label--before {
  left: 10px;
}
.compare-label--after {
  right: 10px;
}
```

Compare mode also needs the stage to stop centering a single child. Add to the
existing `[data-mode="full"]` group:

```css
.image-preview[data-view="compare"] {
  place-items: start stretch;
}
```

- [ ] **Step 5: Typecheck**

```bash
pnpm --filter @uploads/web typecheck
```

Expected: no errors. If TypeScript objects to the unknown `img-comparison-slider`
element in the Astro template, that is a real finding — report it rather than
casting it away; the package ships its own element typings and importing them may
be required.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/ImagePreview.astro
git commit -m "feat(web): compare mode on the public image stage"
```

---

### Task 4: Page wiring — drop the thumbnail strip, add the rail row

**Files:**

- Modify: `apps/web/src/pages/f/[workspace]/[...key].astro`

**Interfaces:**

- Consumes: `ownBeforeAfterState`, `comparisonRows` from Task 2; the `compare`
  prop from Task 3.
- Produces: nothing downstream.

- [ ] **Step 1: Replace the frontmatter's pairing block**

Delete lines 107-134 — the local `ownBeforeAfterState` function, the `PairPanel`
interface, and the `pairPanels` array — and replace them with:

```ts
const ownState: BeforeAfterState | null = counterpart
  ? ownBeforeAfterState(file?.metadata?.state, counterpart.state)
  : null;
const counterpartHref = counterpart ? filePath(workspace, counterpart.key) : null;
const railRows = ownState && counterpartHref ? comparisonRows(ownState, counterpartHref) : null;
// Belt and braces: the API only pairs images (isPairableImageContentType on both
// sides, apps/api/src/routes/public-files.ts), so this never actually filters.
const compare =
  counterpart && ownState && kind(file!.contentType) === "image"
    ? { src: counterpart.url, ownState }
    : null;
```

Delete the now-unused `counterpartFilename` const (line 119).

Add to the imports at the top of the frontmatter:

```ts
import {
  comparisonRows,
  ownBeforeAfterState,
  type BeforeAfterState,
} from "../../../lib/before-after-view";
```

- [ ] **Step 2: Delete the `.pair` markup**

Delete the whole `{pairPanels && ( … )}` block (lines 309-323). Nothing replaces
it in that position — the stage below is the only image region now.

- [ ] **Step 3: Pass `compare` to the stage**

Change the image branch inside `<figure class="stage">`:

```astro
            {kind(file.contentType) === "image" ? (
              <ImagePreview src={file.url} alt={filename} compare={compare} />
            ) : (
```

- [ ] **Step 4: Add the rail section**

Insert immediately **before** the `{metadataEntries.length > 0 && …}` block
inside `<figcaption class="details">`, so Comparison sits above Details:

```astro
              {railRows && (
                <div>
                  <div class="rail-head">
                    <span class="rail-label">Comparison</span>
                    <span class="rail-rule" aria-hidden="true"></span>
                  </div>
                  <ul class="pairlist">
                    {railRows.map((row) => (
                      <li class="pairrow" data-current={row.current ? "true" : "false"}>
                        {row.href ? (
                          <a href={row.href} aria-label={`View the ${row.state} image`}>
                            {row.state} ↗
                          </a>
                        ) : (
                          <>
                            <span>{row.state}</span>
                            <span class="pairrow-note">this file</span>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
```

- [ ] **Step 5: Swap the `.pair` styles for `.pairlist` styles**

Delete the five `.pair*` rules and their `@media (max-width: 620px)` companion
(lines 211-220), and add in their place:

```css
/* Before/after counterpart (issue #420) — rail rows; the stage itself
         carries the comparison via ImagePreview's Compare mode. */
.pairlist {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font: 12px var(--mono);
}
.pairrow {
  display: flex;
  align-items: baseline;
  gap: 8px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
}
.pairrow a {
  color: var(--body);
  text-decoration: none;
}
.pairrow a:hover,
.pairrow a:focus-visible {
  color: var(--accent);
  outline: none;
}
.pairrow[data-current="true"] {
  color: var(--accent);
}
.pairrow-note {
  color: var(--muted);
  text-transform: none;
  letter-spacing: normal;
  font-size: 11.5px;
}
```

- [ ] **Step 6: Typecheck and run the whole web suite**

```bash
pnpm --filter @uploads/web typecheck && pnpm --filter @uploads/web test
```

Expected: no type errors; all tests pass, including the untouched
`public-file.test.ts` counterpart coverage.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/pages/f/[workspace]/[...key].astro
git commit -m "feat(web): inline before/after comparison on the file page"
```

---

### Task 5: Browser verification and staged screenshots

**Files:** none modified unless a defect is found.

The `/f/` page is public, but it fetches the file DTO from the API, so the web
server alone is not enough — the API must be running and hold a real paired
fixture.

- [ ] **Step 1: Start the raw local stack**

Use the browser panel: `preview_start {name: "stack-raw"}` → web `:4321`, api
`:8787`, auth `:8788`. Everything lands on `127.0.0.1`.

- [ ] **Step 2: Mint a local token**

```bash
pnpm workspace:add dev-demo --local
```

Copy the bearer token it prints. The token echoed in the stack log is stale after
a restart; this one is not.

- [ ] **Step 3: Seed a paired fixture with mismatched dimensions**

Pairing rule (`apps/api/src/before-after.ts`): same `path` metadata with opposite
`state` values, scoped to the same key prefix. Deliberately size the two images
differently — this is the case the spike was about.

```bash
TOKEN=<token from step 2>
curl -sf -X PUT "http://127.0.0.1:8787/v1/dev-demo/files/pairtest/shot-before.png" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: image/png" \
  -H "X-Uploads-Meta-state: before" \
  -H "X-Uploads-Meta-path: /pairtest" \
  --data-binary @before.png
curl -sf -X PUT "http://127.0.0.1:8787/v1/dev-demo/files/pairtest/shot-after.png" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: image/png" \
  -H "X-Uploads-Meta-state: after" \
  -H "X-Uploads-Meta-path: /pairtest" \
  --data-binary @after.png
```

Any two PNGs of different sizes work; screenshots of two different pages of the
local site are the most realistic.

- [ ] **Step 4: Verify each behavior**

Open `http://127.0.0.1:4321/f/dev-demo/pairtest/shot-after.png` and confirm:

1. The page opens on the single image — the `after` file, as its URL says.
2. No thumbnail strip anywhere on the page.
3. Top-left pill group reads `This image | Compare`; top-right still reads `Fit | Full width`.
4. Clicking Compare shows the slider; the two layers are registered (Task 1's criterion) despite differing dimensions.
5. Dragging the handle works; clicking elsewhere in the stage jumps the divider; the divider does **not** toggle zoom.
6. Tab to the slider, then arrow keys move the divider.
7. Switching back to This image restores click-to-zoom.
8. Fit and Full width both behave in **both** views.
9. The rail shows `COMPARISON` above `DETAILS`, with `before ↗` linking to the counterpart and `after` marked "this file" in the accent color.
10. Following that link lands on the before page, where the roles are reversed and Compare shows the _same_ left/right arrangement (before on the left) — not a mirrored one.
11. At a 375px viewport the rail stacks under the stage and the slider is still draggable by touch.

Note `read_page` returns "(empty page)" on this stack — use screenshots and
`javascript_tool` instead.

- [ ] **Step 5: Verify the counterpart-failure fallback**

In the page console, simulate the counterpart 404ing:

```js
const img = document.querySelector(".compare-wrap img[data-counterpart]");
img.dispatchEvent(new Event("error"));
```

Expected: the Compare pill and the slider both disappear, the single image
remains, and the page does not shift or error. The rail's Comparison rows stay —
the counterpart page may still be reachable even if this fetch failed.

- [ ] **Step 6: Confirm no framework JS reached the page**

```js
Array.from(document.scripts)
  .map((s) => s.src)
  .filter(Boolean);
```

Expected: no `react` / `react-dom` bundle in the list.

- [ ] **Step 7: Stage before/after screenshots for the PR**

Per AGENTS.md, stage as you go rather than waiting for a PR. The "before" here is
the old thumbnail strip — capture it from `git stash` or from the production page
at `https://uploads.sh/f/default/gh/buildinternet/uploads/pull/549/file-page-after.webp`,
which still shows the old layout.

```bash
uploads put ./file-page-compare-before.webp --meta path=/f --state before
uploads put ./file-page-compare-after.webp --meta path=/f --state after
```

- [ ] **Step 8: Full typecheck and test sweep, then commit any fixes**

```bash
pnpm typecheck && pnpm test
```

Expected: both green. Commit any defect fixes found during verification with
`fix(web): …`, each with a one-line note on what the browser pass caught.

---

## Self-Review

**Spec coverage:**

| Spec section                                                             | Task                                                     |
| ------------------------------------------------------------------------ | -------------------------------------------------------- |
| Delete the thumbnail strip                                               | Task 4, steps 2 and 5                                    |
| Stage: `compare` prop, two-mode toggle, single default                   | Task 3, steps 1-2                                        |
| Click-to-zoom suppressed in Compare; Fit / Full width in both            | Task 3, steps 3-4; verified Task 5 step 4 items 5, 7, 8  |
| Adopt `img-comparison-slider`, CSS-var restyling, `:not(:defined)` guard | Task 1; Task 3, steps 3-4                                |
| Spike mismatched dimensions before other work, with hand-roll fallback   | Task 1 (blocking, with an explicit stop-and-ask on FAIL) |
| Counterpart-error degrade                                                | Task 3, step 3; verified Task 5 step 5                   |
| Rail Comparison section, roles only, no filenames                        | Task 4, steps 4-5                                        |
| Browser verification incl. mismatched pair and mobile                    | Task 5                                                   |
| No framework JS on public pages                                          | Global constraint; verified Task 5 step 6                |

**Placeholders:** none — every code step carries the actual code, and the one
open question (spike PASS/FAIL) is an explicit decision point with both branches
specified rather than a "TBD".

**Type consistency:** `BeforeAfterState`, `ComparisonRow`, `ownBeforeAfterState`,
`compareImages`, and `comparisonRows` are defined in Task 2 and used with those
exact names and signatures in Tasks 3 and 4. The `compare` prop shape
`{ src, ownState }` is identical in Task 3's `Props` and Task 4's construction.
The `data-view` / `data-mode` / `data-counterpart` attribute names match between
Task 3's markup, script, and styles.
