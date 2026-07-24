# Screenshot annotations — design

Date: 2026-07-24
Status: approved

## Goal

Let agents (and scripts) add annotations — boxes, arrows, labeled callouts, freeform strokes, redactions — to screenshots before uploading/attaching them to PRs. Programmatic only; no human editor. Hand-drawn "excalidraw-ish" aesthetic.

## Decision record

- Spiked two renderers. tldraw-in-a-page (headless playwright export) works but costs ~1s/render, ~119MB deps, leans on unexported tldraw internals, and has commercial-license risk. rough.js + perfect-freehand + sharp renders in ~7ms with ~560KB of new deps (beyond sharp), no browser, MIT licenses, and produced the better-looking output. **Chosen: rough.js + sharp**, behind a swappable package boundary.
- Both selector-driven targeting (resolved at capture time) and raw pixel coordinates are supported.
- Annotations are baked into pixels at render time; no structured-annotation storage (no future-editor accommodation — deliberately dropped).

## Architecture

### `packages/uploads/src/annotate/` — self-contained renderer module

Amended from the original `packages/annotate` workspace package: the published CLI must not depend on private workspace packages (plain tsc build, no bundler — see the `src/public-urls.ts` header comment). The module keeps the same narrow boundary — only its `index.ts` is imported from outside — so the renderer stays swappable. Narrow public API so the renderer can be swapped later (tldraw, server-side `/v1/render`, …) without CLI changes:

- `AnnotationSpec` — versioned JSON contract:
  ```jsonc
  {
    "version": 1,
    "annotations": [
      { "type": "box", "x": 10, "y": 20, "w": 200, "h": 80 },
      { "type": "arrow", "from": [400, 300], "to": [250, 120] },
      { "type": "label", "text": "New button", "target": [250, 120], "at": [420, 40] },
      {
        "type": "draw",
        "points": [
          [1, 2],
          [3, 4],
        ],
      },
      { "type": "redact", "x": 0, "y": 0, "w": 100, "h": 30, "style": "blur" },
      { "type": "svg", "fragment": "<path d='…'/>" },
    ],
  }
  ```
  Every geometric annotation may alternatively carry `"selector": "css"` instead of pixel geometry; the **package only understands pixels** — callers resolve selectors to pixel boxes before rendering. `color` is an optional per-annotation override.
- `renderAnnotations(image: Buffer, spec: ResolvedSpec, opts?): Promise<Buffer>` — sole render entry point. Pure: image + resolved spec in, PNG out. No browser/playwright knowledge.
- `validateSpec(json): ResolvedSpec` (or structured errors) — actionable messages; agents hand-write these specs.

Internal (not exported): rough.js generator API (via `roughjs/bundled/rough.esm.js` — package entries break under Node ESM), perfect-freehand, sharp compositing, embedded base64 hand-drawn font (open Excalifont/Shantell-alike) via `@font-face` — librsvg font fallback is silent and unportable, so the font MUST be embedded. rough.js `seed` fixed per-render for deterministic output.

### CLI (`packages/uploads`)

- `uploads annotate <image> --spec <file|-> [-o out.png]` — annotate any existing image. Spec from file or stdin. Selector targets are an error here (no live page).
- `uploads screenshot <url> --annotate <file|->` — capture then annotate in one pass. Selector targets resolved to bounding boxes in the live playwright session; remote `/v1/render` mode rejects selector specs with a clear error in v1 (parity later). Same renderer for both.
- Downstream upload/attach/staging flows (`--pr`, etc.) are untouched — annotation happens before upload.

### House style

One opinionated default theme: uploads brand accent stroke color, fixed roughness/stroke width, embedded hand-drawn font. Per-annotation `color` override only; no theming system in v1.

### Skill

A **standalone** `annotate-screenshots` skill (in-repo, installed via `uploads install`, like the github-screenshots split in PR #189) documenting the workflow: capture → write spec → annotate → attach. `github-screenshots` and `uploads-cli` get short cross-references, not the full content.

## Testing

- Spec validation unit tests (good + adversarial inputs).
- Golden-image tests for the renderer (deterministic rough.js seed).
- CLI command tests with existing fake patterns; plain vitest via the unified root runner.

## Error handling

- `validateSpec` failures: exit non-zero with per-annotation error messages (index + reason).
- Selector that matches nothing at capture time: fail the command with the selector named (no silent skip).
- Out-of-bounds geometry: clamp to image bounds with a stderr warning.

## Out of scope (v1)

- Human/browser editor; structured annotation storage.
- Remote `/v1/render` selector resolution parity.
- Hosted-MCP annotate tool (follow-up issue once CLI ships).
- Theming beyond per-annotation color.
