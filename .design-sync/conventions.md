# uploads.sh design system — how to build with it

A dark, developer-console UI language. Three typefaces do specific jobs and the
palette is dark by construction. Build screens by composing the components below
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
   - `Button` — `variant` (`default | primary | ghost | danger`), `size` (`sm | md | lg`), `block`
   - `Callout` — `tone` (`info | ready | error | muted`), `title`
   - `Badge` — `tone` (`neutral | accent | ok | danger`), `dot`
   - `Field` — `label`, `hint`, `invalid`
   - `Panel` — `title`, `description`, `roomy`
   - `Brand` — `size` (`md | lg`), `href`
2. **Token overrides** for your own layout glue — set any `var(--*)` on a scope:
   - Surfaces: `--bg` (page), `--panel` (raised cards), `--line` (hairline borders)
   - Text: `--fg` (headings), `--body` (copy), `--muted` (metadata)
   - Accents: `--accent` (violet), `--green` (ready), `--red` (error)
   - Type: `--sans`, `--mono` (console chrome — buttons/labels/metadata), `--pixel`
     (the Geist Pixel display face; set its shape with `--pixel-shape`, 0–100)
   - `--radius-sm|md|lg`, `--space-1…6`

Use `--mono` (Geist Mono) for controls, labels, and metadata; `--sans` (Geist)
for headings and body copy; `--pixel` only for brand moments.

## Where the truth lives

- **`styles.css`** (imported above) — the full token layer, `@font-face` rules,
  and every component's CSS. Read it before inventing layout styles.
- Per component: **`<Name>.d.ts`** is the exact prop contract; **`<Name>.prompt.md`**
  has usage examples. Read those before composing a component you haven't used.

## Components

`Surface` · `Brand` · `Button` · `Panel` · `Field` / `Input` / `Label` ·
`Callout` · `Badge` · `Divider` · `GalleryTile` (a hosted image / PR-screenshot
tile — the product's core object).
