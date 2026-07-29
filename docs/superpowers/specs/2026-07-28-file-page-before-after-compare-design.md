# File page: inline before/after comparison

Date: 2026-07-28
Status: approved, ready for planning

## Problem

A file with a before/after counterpart (issue #420, shipped in PRs #424/#425) renders a
two-up thumbnail strip above the main stage on `/f/:workspace/:key`
(`apps/web/src/pages/f/[workspace]/[...key].astro`, the `.pair` block). The strip has
three problems:

- The panels are capped at 220px tall, so on a screenshot pair the actual differences are
  invisible at that size.
- The images are not links and not interactive; only a small text link on the counterpart
  panel navigates anywhere, which is not where a viewer aims.
- It duplicates the stage below it. The page shows the same image twice at two sizes.

The comparison people actually want — a draggable split view — is absent.

## Design

Delete the thumbnail strip. Redistribute its two jobs: comparing becomes a mode of the
main stage; navigating to the counterpart becomes a rail row.

Nothing else on the page changes — Fit / Full width, click-to-zoom, Copy as, Details,
the footnote, and Report a problem all stay as they are.

### Stage

`ImagePreview.astro` gains an optional `compare` prop:

```ts
interface CompareProps {
  /** Public URL of the counterpart image. */
  src: string;
  /** This file's own role, so the labels and image order are correct. */
  ownState: "before" | "after";
}
```

When the prop is present, the component renders a second pill group in the stage's
top-left, mirroring the existing Fit / Full width group on the right:

```
┌────────────────────────────────────────────────────┐
│ [This image | Compare]          [Fit | Full width] │
│                                                    │
│                ← image / slider →                  │
└────────────────────────────────────────────────────┘
```

- **This image** — the default. Behavior identical to an unpaired file today, including
  click-to-zoom.
- **Compare** — both images occupy the same box, split by a draggable vertical divider
  with a grab handle, `before` on the left and `after` on the right. Corner labels read
  `BEFORE` and `AFTER`. The divider is the `img-comparison-slider` web component; see
  "Slider mechanics" below.

Fit / Full width continues to size the whole stage in both modes. Click-to-zoom is
suppressed in Compare mode, because a click there moves the divider — this is the one
interaction the two modes cannot share. The Fit / Full width pills remain the size
affordance in Compare mode.

Because the two images may differ slightly in dimensions, both layers use
`object-fit: contain` against a stage box sized by this file's own image. Mismatched
aspect ratios letterbox rather than mis-register.

### Degrade rules

The counterpart DTO (`PublicFileCounterpart` in `apps/web/src/lib/public-file.ts`) carries
no content type, but it does not need to: the API only ever populates `counterpart` when
**both** this file and the candidate pass `isPairableImageContentType`
(`apps/api/src/routes/public-files.ts`), whose set is identical to the web app's own
`imageTypes`. A video, PDF, or SVG therefore never receives a counterpart at all, and any
counterpart that arrives is renderable as an `<img>`.

That leaves one guard, for transport rather than type:

- If the counterpart image fires `error` (deleted between the API read and the browser
  fetch, network failure), the script removes the Compare toggle and forces single mode.
  Today the same situation renders a broken thumbnail, so this is strictly better.

Passing `compare` only when this file's `fileKind` is `image` remains a cheap assertion of
the server's contract, but it is a belt-and-braces check, not the thing standing between a
viewer and a broken layout.

### Slider mechanics: adopt `img-comparison-slider`

The divider itself is not hand-rolled. `img-comparison-slider`
(https://github.com/sneas/img-comparison-slider, MIT, v8.0.7) is a dependency-free web
component under 4 kB gzipped that already provides drag, click-to-jump, touch, and
keyboard control, plus a `value` attribute (0–100), a `slide` event, and CSS-variable
styling. Being a plain custom element, it costs the public file page no framework
runtime — the page ships no React today and must keep it that way.

Markup inside the stage, with `before` always first:

```html
<img-comparison-slider>
  <img slot="first" src="{beforeUrl}" alt="before" />
  <img slot="second" src="{afterUrl}" alt="after" />
</img-comparison-slider>
```

Slotted images stay in the light DOM, so the stage's existing `img` sizing rules keep
applying to both layers. The handle and divider are restyled to the page's palette
through the component's own custom properties (`--divider-width`, `--divider-color`,
`--default-handle-width`, `--default-handle-color`). The BEFORE / AFTER corner labels are
ours, positioned in the wrapper rather than inside the component's shadow root.

Rejected alternatives: shadcn/ui has no comparison component, and the community versions
(shadcn.io, BundUI, Aceternity) are React + Tailwind, which this repo's public pages use
neither of; `react-compare-slider` is a good component but would put react and react-dom
on a page that currently ships no framework JS.

Two integration details this brings with it:

- **No SSR.** Custom elements only upgrade client-side. The import lives in the
  component's client `<script>`, and an `img-comparison-slider:not(:defined)` rule hides
  or neutralizes the element until it upgrades, so there is no flash of stacked images.
- **Shadow DOM.** Styling reaches the component only through its documented custom
  properties and the slotted images. Anything the page needs to restyle beyond those has
  to live in our wrapper.

#### Spike first

The README does not document how the component lays out images of differing dimensions,
and before/after screenshot pairs are frequently a few pixels apart. **Before any other
implementation work**, prototype the component in the stage with a deliberately
mismatched pair and confirm the two layers stay registered (same origin, same scale) —
not offset or independently stretched.

If they mis-register and no combination of the component's CSS variables and our own
slotted-image rules fixes it, fall back to hand-rolling the divider: a visually-hidden
`<input type="range" min="0" max="100">` as the source of truth (platform keyboard and
screen-reader semantics for free), driven by `pointerdown` / `pointermove` with
`setPointerCapture`, with the pointer-x-to-percentage math in a pure, unit-tested
`apps/web/src/lib/image-compare.ts`. That fallback is a decision point for the
implementer, not a silent substitution — surface it before proceeding.

### Rail

A new section above the footnote, using the page's existing `rail-head` / `rail-label`
pattern:

```
COMPARISON ─────────────
BEFORE ↗
AFTER            (this file)
```

Both roles are always listed so the page states which one you are looking at; only the
counterpart row is a link. Filenames are omitted — the role labels plus the page title
are context enough, and the counterpart's filename is a near-duplicate of this file's.
The current file's row is marked with the accent color and a muted "this file" note; the
link carries an accessible name naming the role and destination (for example,
`View the before image`).

The rail section renders whenever a counterpart exists.

## Files

| File                                              | Change                                                                                                                                                                                           |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/web/src/pages/f/[workspace]/[...key].astro` | Delete the `.pair` block, the `PairPanel` interface, `pairPanels`, and the `.pair*` CSS. Pass `compare` to `ImagePreview`. Add the Comparison rail section. Keep `ownState` / `counterpartHref`. |
| `apps/web/src/components/ImagePreview.astro`      | Optional `compare` prop; compare-mode markup, styles, and slider script; mode toggle; counterpart-error fallback.                                                                                |
| `apps/web/package.json`                           | Add the `img-comparison-slider` dependency.                                                                                                                                                      |

Only if the spike fails and the divider is hand-rolled: new
`apps/web/src/lib/image-compare.ts` plus its unit tests.

## Testing

The comparison behavior is a third-party component driven by pointer events, so it is
verified in a browser rather than in unit tests.

- Existing `public-file.test.ts` counterpart coverage is unaffected and must stay green.
- Browser verification against a locally served paired file (stack-raw on `127.0.0.1`,
  per the local verification recipe): mode switch, drag, click-to-jump, keyboard nudge,
  Fit / Full width in both modes, mobile width, a mismatched-dimensions pair, and the
  counterpart-fails-to-load fallback.
- Confirm the public file page still ships no framework runtime, and that the added
  bundle is the component only.

## Out of scope

- A side-by-side (non-slider) third mode. Two stage modes plus Fit / Full width is already
  the ceiling for stage chrome.
- Adding `contentType` to the counterpart DTO. The API already guarantees both sides are
  pairable images, so the field would carry no new information.
- Any change to how pairs are detected or to the managed PR comment's pairing output.
