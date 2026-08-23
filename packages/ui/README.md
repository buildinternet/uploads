# @uploads/ui

The **uploads.sh** design system — shadcn / Base UI components under
`src/components/ui/`, styled with Tailwind v4 and the tokens in `theme.css`.
Carries the Geist / Geist Pixel brand and the dark developer-console visual
language used across the product (auth, console, galleries).

## Install & use

```tsx
import "@uploads/ui/theme.css"; // Tailwind v4 tokens + component styles — import once
import { Button } from "@uploads/ui/components/ui/button";
import { Badge } from "@uploads/ui/components/ui/badge";

export function Example() {
  return (
    <div className="flex items-center gap-2">
      <Badge variant="outline">Draft</Badge>
      <Button variant="default">Continue with GitHub</Button>
    </div>
  );
}
```

Each shadcn component ships as its own subpath export
(`@uploads/ui/components/ui/<name>`), matching the layout under
`src/components/ui/`. See `tsup.config.ts` for the full list of built entries.

## Foundation

- **Fonts** — Geist (sans, body), Geist Mono (console chrome: buttons, labels,
  metadata), Geist Pixel (display / brand, with the `ELSH` element-shape axis).
- **Tokens** — `theme.css` (Tailwind v4 `@theme`) is the live source for
  shadcn components. `src/tokens.css` holds the same values as plain CSS
  custom properties for non-Tailwind consumers (Astro pages, string-built
  markup). Override any `var(--*)` on a scope to restyle it.

## Legacy exports

`src/index.ts` still exports a handful of hand-rolled components predating
the shadcn migration: `Callout`, and `Field` / `Input` / `Label` / `Select`.
These have live consumers in `apps/web` (error boundaries, inline validation
messages, and the screenshots-by-path filter bar) that haven't been ported
yet. Don't build new UI against them — reach for the shadcn components under
`components/ui/` instead. Once a legacy component's last consumer migrates,
delete the component, its export, and its `ul-*` rules in `src/styles.css`
(after confirming no raw HTML string in `apps/web` still references those
classes — several `.astro` pages and `.ts` string builders apply `ul-*`
classes directly, outside React).

## Build

```sh
pnpm --filter @uploads/ui build   # tsup → dist/ (component bundles + dist/index.js) + dist/uploads-ui.css
```
