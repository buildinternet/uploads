# uploads.sh design system — how to build with it

A dark, developer-console UI language. Three typefaces do specific jobs, sizes
are roles rather than numbers, and the palette is dark by construction. Build screens by composing the components below
and choosing their props — you do not write CSS classes yourself.

## Setup — wrap everything in `Surface`

Import the stylesheet once at the app root, then wrap UI in `Surface` so the dark
`--bg` canvas, the Geist **sans** body font, and every token are in scope:

```tsx
import "@uploads/ui/styles.css";
import { Surface, Brand, Panel, Button, Field, Input, Divider } from "@uploads/ui";

<Surface style={{ padding: 24 }}>
  <Brand />
  <Panel roomy title="Sign in" description="Continue with GitHub or a workspace token.">
    <Button variant="primary" block>Continue with GitHub</Button>
    <Divider label="or" />
    <Field label="Workspace token"><Input placeholder="upl_…" /></Field>
  </Panel>
</Surface>
```

The design tokens live in `:root`, so components are styled even outside a
`Surface`; what `Surface` adds is the dark page canvas and the sans body font.
Build every screen inside one.

## Styling idiom — props + tokens, never classes

There is **no utility-class vocabulary to author**. Style two ways only:

1. **Component props** carry the design language:
   - `Button` — `variant` (`default | primary | solid | ghost | danger`; `solid`
     fills with the accent — at most one per surface), `size` (`sm | md | lg`),
     `block`, `icon`
   - `Callout` — `tone` (`info | ready | error | muted`), `title`
   - `Badge` — `tone` (`neutral | accent | ok | danger`), `dot`
   - `Field` — `label`, `hint`, `invalid`
   - `Select` — a dark `<select>`; compact variant via `className="ul-select--sm"`
   - `Panel` — `title`, `description`, `roomy`
   - `Progress` — `label`, `value`, `max`, `detail` (a labelled quota meter; the
     fill goes quiet below 85%, warns near the cap, and turns `--accent` when full)
   - `Brand` — `size` (`md | lg`), `href`
2. **Token overrides** for your own layout glue — set any `var(--*)` on a scope:
   - Surfaces: `--bg` (page), `--panel` (raised cards), `--line` (hairline borders)
   - Text: `--fg` (headings), `--body` (copy), `--muted` (metadata)
   - Accents: `--accent` (violet), `--green` (ready), `--red` (error)
   - Families: `--sans` (the interface voice), `--mono` (keys, code, and
     measurements), `--pixel` (the Geist Pixel display face; set its shape with
     `--pixel-shape`, 0–100)
   - Sizes: `--text-display|h1|h2|h3|h4|body|ui|meta|micro`
   - `--leading-*`, `--tracking-*`, `--weight-*`, `--measure`, `--mono-optical`
   - `--radius-sm|md|lg`, `--space-1…6`

### The mono rule

`--sans` (Geist) is the interface voice: prose, headings, buttons, labels,
navigation, metadata. `--pixel` is for brand moments only.

Reach for `--mono` (Geist Mono) when the characters are something the reader
**transcribes or compares column-to-column** — a command, a code sample, a file
key, a URL, a hash, or a figure in a table. Never to make a word look technical.
The terminal character of this system comes from Geist Pixel, the chevron motif,
and the density, not from setting every label in a typewriter.

Two helpers exist for the edges: `ul-input--key` puts a form field's value in
mono, and `--mono-optical` scales inline code down one step so it sits on the
baseline of the sans around it.

### Sizes

Never hardcode a pixel value — every size is a role:

| Token | Size | For |
| --- | --- | --- |
| `--text-body` | 16px | prose and reading copy |
| `--text-ui` | 14px | buttons, nav, labels, inputs |
| `--text-meta` | 13px | metadata, captions, dense table cells |
| `--text-micro` | 12px | badges and uppercase pills — the floor |

Nothing in this system renders below 12px. Cap prose at `--measure` (68ch).

## Where the truth lives

- **`styles.css`** (imported above) — the full token layer, `@font-face` rules,
  and every component's CSS. Read it before inventing layout styles.
- Per component: **`<Name>.d.ts`** is the exact prop contract; **`<Name>.prompt.md`**
  has usage examples. Read those before composing a component you haven't used.

## Components

`Surface` · `Brand` · `Button` · `Panel` · `Field` / `Input` / `Select` / `Label` ·
`Progress` (a labelled quota / usage meter) · `Callout` · `Badge` · `Divider` ·
`GalleryTile` (a hosted image / PR-screenshot tile — the product's core object) ·
`FileBrowser` (a read-only, folder-aware files-sdk browser).
