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
- **Compare** — both images occupy the same box. `before` is the base layer; `after` is
  overlaid and clipped by a CSS `inset` driven by a single `--split` custom property. A
  vertical rule with a grab handle sits at the split. Corner labels read `BEFORE` (left)
  and `AFTER` (right).

Fit / Full width continues to size the whole stage in both modes. Click-to-zoom is
suppressed in Compare mode, because a click there moves the divider — this is the one
interaction the two modes cannot share. The Fit / Full width pills remain the size
affordance in Compare mode.

Because the two images may differ slightly in dimensions, both layers use
`object-fit: contain` against a stage box sized by this file's own image. Mismatched
aspect ratios letterbox rather than mis-register.

### Degrade rules

The API's counterpart DTO carries no content type
(`PublicFileCounterpart` in `apps/web/src/lib/public-file.ts`), so the counterpart cannot
be proven to be an image server-side. Two guards, no API change:

- The `compare` prop is only passed when **this** file's `fileKind` is `image`. A video or
  PDF with a counterpart keeps the rail row and gets no stage toggle.
- If the counterpart image fires `error`, the script removes the toggle and forces
  single mode. Today the same situation renders a broken thumbnail, so this is strictly
  better.

### Slider mechanics

A visually-hidden `<input type="range" min="0" max="100">` is the source of truth for the
split position. This buys keyboard support (arrows, Home, End), focus handling, and
screen-reader semantics from the platform instead of hand-rolled ARIA.

Pointer interaction writes into that input:

- `pointerdown` on the stage sets the split to the pointer's x and calls
  `setPointerCapture`, so a drag survives leaving the stage box.
- `pointermove` while captured updates the split.
- `pointerup` / `pointercancel` release capture.

Touch works through the same pointer events. There is no autoplay and no hover-scrub.

The pointer-x-to-percentage math and its clamping move into a new pure module,
`apps/web/src/lib/image-compare.ts`, following the precedent set by
`image-preview-mode.ts`:

```ts
/** Pointer x within a stage rect → a 0–100 split percentage, clamped. */
export function splitFromPointer(clientX: number, rect: { left: number; width: number }): number;
```

A zero-width rect returns 50 rather than dividing by zero.

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

The rail section renders whenever a counterpart exists, including for non-image files
that get no stage toggle.

## Files

| File                                              | Change                                                                                                                                                                                           |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/web/src/pages/f/[workspace]/[...key].astro` | Delete the `.pair` block, the `PairPanel` interface, `pairPanels`, and the `.pair*` CSS. Pass `compare` to `ImagePreview`. Add the Comparison rail section. Keep `ownState` / `counterpartHref`. |
| `apps/web/src/components/ImagePreview.astro`      | Optional `compare` prop; compare-mode markup, styles, and slider script; mode toggle; counterpart-error fallback.                                                                                |
| `apps/web/src/lib/image-compare.ts`               | New. Pure split-position helpers.                                                                                                                                                                |
| `apps/web/src/lib/image-compare.test.ts`          | New. Unit tests for those helpers.                                                                                                                                                               |

## Testing

- Unit tests for `splitFromPointer`: midpoint, both clamps, out-of-range pointer, zero-width rect.
- Existing `public-file.test.ts` counterpart coverage is unaffected and must stay green.
- Browser verification against a locally served paired file (stack-raw on `127.0.0.1`,
  per the local verification recipe): mode switch, drag, click-to-jump, keyboard nudge,
  Fit / Full width in both modes, mobile width, and the counterpart-fails-to-load fallback.

## Out of scope

- A side-by-side (non-slider) third mode. Two stage modes plus Fit / Full width is already
  the ceiling for stage chrome.
- Adding `contentType` to the counterpart DTO. The two guards above cover the case without
  an API change; revisit only if non-image pairs become common.
- Any change to how pairs are detected or to the managed PR comment's pairing output.
