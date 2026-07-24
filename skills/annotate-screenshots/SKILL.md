---
name: annotate-screenshots
description: >-
  Bake hand-drawn boxes, arrows, labels, freeform strokes, and redactions onto
  a screenshot so a PR reviewer or teammate sees exactly what changed and
  where to look, instead of reading a caption and hunting for it. Use this
  whenever a screenshot needs a callout — "point at the new button", "circle
  the bug", "arrow to the diff", "blur out the API key in this screenshot",
  "mark up this image before I attach it". Covers both annotating a live page
  during capture (`uploads screenshot --annotate`, CSS selector targeting) and
  annotating an image you already have (`uploads annotate`, pixel/freeform
  coordinates only). For getting the resulting image into a GitHub PR or
  issue, hand off to the github-screenshots skill — this skill only covers
  producing the annotated image.
---

# Annotating screenshots

## When to annotate

Add annotations when a screenshot needs to draw the reader's eye somewhere
specific — a new element, a bug, a diff — rather than leaving them to find it
in the caption. A plain before/after pair is often enough; reach for
annotation when "look at the top-right corner" is easier to say with an
arrow than with words, or when a screenshot contains a secret that must be
hidden before it's shared anywhere (uploads.sh URLs are public).

Two commands, same underlying spec format:

| Command                                                 | Input                     | Targeting                                       |
| ------------------------------------------------------- | ------------------------- | ----------------------------------------------- |
| `uploads screenshot <url\|file.html> --annotate <spec>` | captures a live page      | CSS selectors (preferred) or pixel coordinates  |
| `uploads annotate <image> --spec <spec>`                | an existing PNG/JPEG file | pixel coordinates only — selectors are rejected |

**Prefer selectors, resolved live, over guessing pixel coordinates.** An
agent estimating `x`/`y`/`w`/`h` by eye is unreliable — it's easy to point at
the wrong element or clip a box awkwardly. `uploads screenshot --annotate`
resolves a CSS selector against the real DOM at capture time (local backend
only in v1 — `--via remote` rejects selector-bearing specs up front), so use
it whenever you're capturing the page yourself. Fall back to pixel
coordinates with `uploads annotate` only when you're marking up an image you
already have and there's no live page to query — a screenshot someone else
took, a photo, a diagram exported from elsewhere.

## The spec format

A spec is a JSON document: `{ "version": 1, "annotations": [...] }`.
`annotations` is a non-empty array; each entry has a `type` plus fields for
that type. House style (color, stroke weight, sketchy roughness, font) is
fixed and not configurable — the one style knob is a per-annotation `color`
override.

Annotation types:

| Type     | Required fields                                                   | Notes                                                                                                    |
| -------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `box`    | `x, y, w, h` (or `selector`)                                      | outlines a region                                                                                        |
| `arrow`  | `from, to` points (or `selector`)                                 | `to` = element center when resolved from a selector; `from` defaults to an offset above-right if omitted |
| `label`  | `text`, plus `target` or `at` point (or `selector`)               | a callout bubble with a leader line to `target`                                                          |
| `draw`   | `points` (>= 2 `[x, y]` pairs)                                    | freeform stroke, pixel-only, no selector support                                                         |
| `redact` | `x, y, w, h` (or `selector`), optional `style: "blur" \| "solid"` | hides a region (default `blur`)                                                                          |
| `svg`    | `fragment` (raw SVG, no `<script`)                                | escape hatch, injected verbatim                                                                          |

Rules: a geometric annotation (`box`/`arrow`/`label`/`redact`) takes **either**
pixel geometry **or** `selector`, never both — supplying both is rejected as
ambiguous. `draw` and `svg` never take a selector. Every type accepts an
optional `color` override.

### Worked example — selector mode (preferred)

Point at a specific element on a live page, label it, and redact a nearby
API key, then capture and annotate in one call:

```json
{
  "version": 1,
  "annotations": [
    { "type": "box", "selector": "#save-button" },
    { "type": "label", "text": "New: bulk save", "selector": "#save-button" },
    { "type": "redact", "selector": "[data-testid=api-key]", "style": "blur" }
  ]
}
```

```bash
uploads screenshot http://localhost:4321/settings --via local \
  --annotate ./callouts.json --out settings.png
```

### Worked example — pixel mode (existing image only)

Annotating a screenshot you already have — no live page to query, so
geometry is given directly:

```json
{
  "version": 1,
  "annotations": [
    { "type": "box", "x": 120, "y": 84, "w": 220, "h": 48, "color": "#2563eb" },
    { "type": "arrow", "from": [520, 60], "to": [360, 108] },
    {
      "type": "draw",
      "points": [
        [40, 400],
        [80, 380],
        [120, 420],
        [160, 390]
      ]
    }
  ]
}
```

```bash
uploads annotate ./before.png --spec ./callouts.json --out ./before.marked.png
```

Coordinates are in image pixels, not CSS/viewport pixels — for a capture at
`--viewport 1280x800@2x` the image is 2560x1600, so pixel-mode geometry must
be scaled accordingly. This is exactly why selector mode is preferable
whenever a live page is available: the resolver handles device-scale
conversion for you.

Read a spec from stdin with `-`:

```bash
cat ./callouts.json | uploads annotate ./shot.png --spec -
```

## Redacting secrets

Every uploads.sh object is public once uploaded — see the github-screenshots
skill's "Cautions" section. Before capturing or attaching a screenshot that
shows an API key, token, password, session cookie, or other secret, add a
`redact` annotation over it (`style: "solid"` for a fully opaque cover,
`style: "blur"` when the surrounding shape should stay legible). Do this at
capture time with `screenshot --annotate` when possible — it's one less
chance to forget before the image goes anywhere public.

## Workflow: capture, annotate, attach

1. **Capture and annotate together** when there's a live page:
   `uploads screenshot <url> --via local --annotate ./spec.json ...`. This is
   one call — no separate "capture then annotate" round-trip.
2. **Annotate an existing image** with `uploads annotate <image> --spec ...`
   when there's no live page (an image from elsewhere, or a second annotation
   pass on something already captured).
3. **Attach the result to a PR or issue** — this skill stops at producing the
   annotated PNG. Hand off to the **github-screenshots** skill for hosting,
   embedding, and the managed attachments comment (`uploads attach`,
   `uploads put --pr`, before/after tables, etc.).

Invalid specs fail fast with per-annotation error messages
(`annotations[i]: <reason>`); a selector that matches nothing on the page
fails the command naming the selector rather than silently skipping it. See
`uploads annotate --help` / `uploads screenshot --help` for the full flag
reference, including `--seed` (deterministic sketchy rendering) and
`--format json`.
