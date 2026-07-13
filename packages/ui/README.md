# @uploads/ui

The **uploads.sh** design system — React components carrying the Geist / Geist
Pixel brand and the dark developer-console visual language used across the
product (auth, console, galleries).

## Install & use

```tsx
import "@uploads/ui/styles.css"; // tokens, @font-face, component CSS — import once
import { Surface, Brand, Panel, Button, Field, Input } from "@uploads/ui";

export function LoginCard() {
  return (
    <Surface style={{ padding: 24 }}>
      <Panel roomy title="Sign in" description="Continue with GitHub or a workspace token.">
        <Button variant="primary" block>
          Continue with GitHub
        </Button>
      </Panel>
    </Surface>
  );
}
```

Wrap product UI in `<Surface>` so the dark `--bg` canvas, Geist body font, and
design tokens are in scope. Style by choosing a component and its props — you
never write the internal `ul-` classes yourself.

## Foundation

- **Fonts** — Geist (sans, body), Geist Mono (console chrome: buttons, labels,
  metadata), Geist Pixel (display / brand, with the `ELSH` element-shape axis).
- **Tokens** — see `src/tokens.css`: surfaces (`--bg`, `--panel`, `--line`),
  text (`--fg`, `--body`, `--muted`), accents (`--accent` violet, `--green`,
  `--red`), radii, and a spacing scale. Override any `var(--*)` on a scope to
  restyle it.

## Components

`Surface` · `Brand` · `Button` · `Panel` · `Field` / `Input` / `Label` ·
`Callout` · `Badge` · `Divider` · `GalleryTile` · `FileBrowser`

## Build

```sh
pnpm --filter @uploads/ui build   # tsup → dist/index.js + dist/index.d.ts + dist/uploads-ui.css
```
