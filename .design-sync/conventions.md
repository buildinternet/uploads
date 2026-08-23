# uploads.sh design system — how to build with it

A dark, developer-console UI language built on shadcn-style components
(Base UI primitives) and Tailwind utilities. Single dark theme by
construction — there is no light mode and no theme provider.

## Setup — no wrapper needed

Import the components and compose. The stylesheet's base layer paints the
dark `--bg` canvas and Geist sans on `<body>`; no provider or root wrapper
is required. The one composition exception: `Tooltip` must sit inside a
`TooltipProvider`.

```tsx
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle,
         DialogDescription, DialogFooter, DialogTrigger } from "@uploads/ui";

<Dialog>
  <DialogTrigger render={<Button variant="outline">Invite teammate</Button>} />
  <DialogContent>
    <DialogHeader>
      <DialogTitle>Invite a teammate</DialogTitle>
      <DialogDescription>They'll get an email link to join the workspace.</DialogDescription>
    </DialogHeader>
    <DialogFooter>
      <Button variant="ghost">Cancel</Button>
      <Button>Send invite</Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

**Base UI composition rules** (these throw or silently break if ignored):
triggers take a `render` prop to wrap a custom element (as above — not
`asChild`); `DropdownMenuLabel` must sit inside a `DropdownMenuGroup`;
overlays render open statically via `defaultOpen`.

## Styling idiom — utilities from the shipped sheet, tokens for the rest

The stylesheet is a **static Tailwind compile**: only classes the product
already uses exist. Stay inside this vocabulary and everything renders;
an arbitrary class outside it silently does nothing.

Safe, verified families for layout glue:

- Layout: `flex`, `flex-col`, `grid`, `items-center`, `justify-between`,
  `gap-2|3|4`, `min-w-0`, `truncate`, `w-full`
- Spacing: `p-4`, `px-4`, `py-2`, `mt-2`, `mb-4` (small numeric steps of
  each family exist; stay ≤ 8)
- Surfaces: `bg-bg` (page), `bg-panel` (raised), `bg-muted` (hover wash),
  `border`, `rounded-lg`
- Text: `text-fg` (headings), `text-body` (copy), `text-muted-foreground`
  (metadata), `text-sm`, `font-sans`, `font-mono`, `uppercase`

For anything beyond that, use inline `style` with the tokens — that always
works: `style={{ background: "var(--panel)", padding: "var(--space-4)" }}`.

- Surfaces: `--bg`, `--panel`, `--line` (hairline borders)
- Text: `--fg`, `--body`, `--muted`
- Accents: `--accent` (violet), `--green` (ready), `--red` (error)
- Families: `--sans`, `--mono`, `--pixel` (brand display face only)
- Sizes: `--text-display|h1|h2|h3|h4|body|ui|meta|micro`,
  `--leading-*`, `--tracking-*`, `--weight-*`, `--measure`
- `--radius-sm|md|lg`, `--space-1…6`

### The mono rule

`--sans` (Geist) is the interface voice: prose, headings, labels, nav,
metadata. Buttons and badges are the shipped exceptions — they come mono
out of the box; don't undo it. Reach for `font-mono` yourself only when
the characters are something the reader **transcribes or compares
column-to-column** — a command, file key, URL, hash, or a figure in a
table. Never to make a word look technical.

### Sizes

Never hardcode a pixel value — every size is a role. `--text-body` 16px
prose · `--text-ui` 14px controls · `--text-meta` 13px metadata ·
`--text-micro` 12px badges (the floor — nothing renders below 12px).
Cap prose at `--measure` (68ch).

## Components

`Accordion` · `AlertDialog` · `Badge` · `Button` · `Checkbox` · `Combobox`
· `Dialog` · `DropdownMenu` · `Empty` · `Input` · `InputGroup` · `Kbd`
· `Label` · `Popover` · `Select` · `Separator` · `Sheet` · `Sidebar`
· `Skeleton` · `Switch` · `Table` · `Tabs` · `Textarea` · `Tooltip`

Compound parts (`DialogTrigger`, `SelectItem`, `TableRow`,
`DropdownMenuItem`, `InputGroupAddon`, `EmptyHeader`/`EmptyTitle`/
`EmptyDescription`/`EmptyContent`/`EmptyMedia`, `KbdGroup`,
`SheetTrigger`/`SheetContent`/`SheetHeader`/`SheetFooter`/`SheetTitle`/
`SheetDescription`/`SheetClose`, `SidebarProvider`/`SidebarHeader`/
`SidebarContent`/`SidebarFooter`/`SidebarGroup`/`SidebarGroupLabel`/
`SidebarGroupContent`/`SidebarMenu`/`SidebarMenuItem`/`SidebarMenuButton`/
`SidebarTrigger`/`useSidebar`/…, …) are all
exported flat from the
same module. Key variant axes: `Button` `variant`
(`default | outline | secondary | ghost | destructive | link`) and `size`
(`xs | sm | default | lg | icon*`); `Badge` `variant` (same six). The
violet accent is `default`/primary — at most one filled-accent action per
surface.

## Where the truth lives

- **`styles.css`** — tokens, `@font-face`, base layer, and the compiled
  utility set. Read it before inventing a class.
- Per component: **`<Name>.d.ts`** is the exact prop contract;
  **`<Name>.prompt.md`** has usage examples. Read those before composing
  a component you haven't used.
