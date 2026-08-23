import * as React from "react";
import { Button } from "@uploads/ui/components/ui/button";
import { Badge } from "@uploads/ui/components/ui/badge";
import { Input } from "@uploads/ui/components/ui/input";
import { Textarea } from "@uploads/ui/components/ui/textarea";
import { Label } from "@uploads/ui/components/ui/label";
import { Checkbox } from "@uploads/ui/components/ui/checkbox";
import { Switch } from "@uploads/ui/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@uploads/ui/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@uploads/ui/components/ui/tabs";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@uploads/ui/components/ui/accordion";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@uploads/ui/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogClose,
} from "@uploads/ui/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@uploads/ui/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@uploads/ui/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@uploads/ui/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@uploads/ui/components/ui/tooltip";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@uploads/ui/components/ui/empty";
import { Kbd, KbdGroup } from "@uploads/ui/components/ui/kbd";
import {
  Combobox,
  ComboboxContent,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@uploads/ui/components/ui/combobox";
import { Separator } from "@uploads/ui/components/ui/separator";
import { Skeleton } from "@uploads/ui/components/ui/skeleton";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@uploads/ui/components/ui/sheet";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@uploads/ui/components/ui/sidebar";

function Section({ eyebrow, children }: { eyebrow: string; children: React.ReactNode }) {
  return (
    <section className="mb-12">
      <h2 className="mb-4 font-mono text-[13px] tracking-[0.08em] text-muted-foreground uppercase">
        {eyebrow}
      </h2>
      <div className="flex flex-col gap-4">{children}</div>
    </section>
  );
}

const FRUITS = ["Apple", "Banana", "Cherry", "Date", "Elderberry"];

export default function UiKit() {
  const [comboValue, setComboValue] = React.useState<string | null>(null);

  return (
    <div className="mx-auto flex max-w-[960px] flex-col px-6 py-12">
      <h1 className="mb-1 font-mono text-[13px] tracking-[0.08em] text-accent uppercase">
        packages/ui
      </h1>
      <p className="mb-10 text-sm text-muted-foreground">
        Generated shadcn (Base UI) components, themed by tokens.css. Workbench only — dev
        environment.
      </p>

      <Section eyebrow="Buttons">
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="default">Default</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="destructive">Destructive</Button>
          <Button variant="link">Link</Button>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button size="xs">xs</Button>
          <Button size="sm">sm</Button>
          <Button size="default">default</Button>
          <Button size="lg">lg</Button>
          <Button size="icon" aria-label="Icon button">
            ▾
          </Button>
        </div>
      </Section>

      <Section eyebrow="Badges">
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant="default">Default</Badge>
          <Badge variant="secondary">Secondary</Badge>
          <Badge variant="outline">Outline</Badge>
          <Badge variant="destructive">Destructive</Badge>
          <Badge variant="ghost">Ghost</Badge>
        </div>
      </Section>

      <Section eyebrow="Form">
        <div className="grid max-w-sm gap-2">
          <Label htmlFor="uikit-name">Name</Label>
          <Input id="uikit-name" placeholder="Ada Lovelace" />
        </div>
        <div className="grid max-w-sm gap-2">
          <Label htmlFor="uikit-notes">Notes</Label>
          <Textarea id="uikit-notes" placeholder="Anything else we should know…" />
        </div>
        <div className="grid max-w-sm gap-2">
          <Label htmlFor="uikit-plan">Plan</Label>
          <Select defaultValue="free">
            <SelectTrigger id="uikit-plan" className="w-full">
              <SelectValue placeholder="Choose a plan" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="free">Free</SelectItem>
              <SelectItem value="pro">Pro</SelectItem>
              <SelectItem value="enterprise">Enterprise</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox id="uikit-checkbox" />
          <Label htmlFor="uikit-checkbox">Enable ingest</Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch id="uikit-switch" />
          <Label htmlFor="uikit-switch">Public workspace</Label>
        </div>
        <div className="grid max-w-sm gap-2">
          <Label htmlFor="uikit-combobox">Fruit</Label>
          <Combobox items={FRUITS} value={comboValue} onValueChange={setComboValue}>
            <ComboboxInput id="uikit-combobox" placeholder="Search fruit…" />
            <ComboboxContent>
              <ComboboxList>
                {FRUITS.map((fruit) => (
                  <ComboboxItem key={fruit} value={fruit}>
                    {fruit}
                  </ComboboxItem>
                ))}
              </ComboboxList>
            </ComboboxContent>
          </Combobox>
        </div>
      </Section>

      <Section eyebrow="Tabs">
        <Tabs defaultValue="files">
          <TabsList>
            <TabsTrigger value="files">Files</TabsTrigger>
            <TabsTrigger value="galleries">Galleries</TabsTrigger>
            <TabsTrigger value="people">People</TabsTrigger>
          </TabsList>
          <TabsContent value="files">Files panel content.</TabsContent>
          <TabsContent value="galleries">Galleries panel content.</TabsContent>
          <TabsContent value="people">People panel content.</TabsContent>
        </Tabs>
      </Section>

      <Section eyebrow="Accordion">
        <Accordion defaultValue={["item-1"]} className="max-w-xl">
          <AccordionItem value="item-1">
            <AccordionTrigger>What is uploads.sh?</AccordionTrigger>
            <AccordionContent>A file-hosting backend for teams and agents.</AccordionContent>
          </AccordionItem>
          <AccordionItem value="item-2">
            <AccordionTrigger>How do I upload?</AccordionTrigger>
            <AccordionContent>Via the CLI, MCP, or the web app.</AccordionContent>
          </AccordionItem>
        </Accordion>
      </Section>

      <Section eyebrow="Table">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>File</TableHead>
              <TableHead>Size</TableHead>
              <TableHead>Uploaded</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>og-home.png</TableCell>
              <TableCell>412 KB</TableCell>
              <TableCell>2026-08-20</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>changelog-hero.gif</TableCell>
              <TableCell>1.8 MB</TableCell>
              <TableCell>2026-08-19</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>screenshot.png</TableCell>
              <TableCell>96 KB</TableCell>
              <TableCell>2026-08-18</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </Section>

      <Section eyebrow="Empty states">
        <Empty className="max-w-xl border">
          <EmptyHeader>
            <EmptyMedia variant="icon">⌁</EmptyMedia>
            <EmptyTitle>No screenshots yet</EmptyTitle>
            <EmptyDescription>
              Capture one with <code>uploads screenshot &lt;url&gt;</code> and it shows up here.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" size="sm">
              Read the docs
            </Button>
          </EmptyContent>
        </Empty>
      </Section>

      <Section eyebrow="Kbd">
        <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
          <span className="flex items-center gap-2">
            Filter
            <KbdGroup>
              <Kbd>⌘</Kbd>
              <Kbd>K</Kbd>
            </KbdGroup>
          </span>
          <span className="flex items-center gap-2">
            Search
            <Kbd>/</Kbd>
          </span>
        </div>
      </Section>

      <Section eyebrow="Overlays">
        <div className="flex flex-wrap items-center gap-3">
          <Dialog>
            <DialogTrigger render={<Button variant="outline">Open dialog</Button>} />
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Rename workspace</DialogTitle>
                <DialogDescription>Choose a new name for this workspace.</DialogDescription>
              </DialogHeader>
              <Input placeholder="workspace-name" />
              <DialogFooter>
                <DialogClose render={<Button variant="outline">Cancel</Button>} />
                <Button>Save</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <AlertDialog>
            <AlertDialogTrigger render={<Button variant="destructive">Delete file</Button>} />
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete this file?</AlertDialogTitle>
                <AlertDialogDescription>
                  This cannot be undone. The file will be permanently removed.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel variant="outline" size="default">
                  Cancel
                </AlertDialogCancel>
                <AlertDialogAction variant="destructive" size="default">
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="outline">Actions</Button>} />
            <DropdownMenuContent>
              {/* Base UI requires GroupLabel inside a Group (it throws otherwise). */}
              <DropdownMenuGroup>
                <DropdownMenuLabel>Workspace</DropdownMenuLabel>
                <DropdownMenuItem>Rename</DropdownMenuItem>
                <DropdownMenuItem>Duplicate</DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive">Delete</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Popover>
            <PopoverTrigger render={<Button variant="outline">Popover</Button>} />
            <PopoverContent>
              <p className="text-sm text-muted-foreground">Quick reference content lives here.</p>
            </PopoverContent>
          </Popover>

          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger render={<Button variant="outline">Hover me</Button>} />
              <TooltipContent>Tooltip copy</TooltipContent>
            </Tooltip>
          </TooltipProvider>

          <Sheet>
            <SheetTrigger render={<Button variant="outline">Open sheet</Button>} />
            <SheetContent>
              <SheetHeader>
                <SheetTitle>Workspace settings</SheetTitle>
                <SheetDescription>Update details for this workspace.</SheetDescription>
              </SheetHeader>
              <SheetFooter>
                <SheetClose render={<Button variant="outline">Cancel</Button>} />
                <Button>Save</Button>
              </SheetFooter>
            </SheetContent>
          </Sheet>
        </div>
      </Section>

      <Section eyebrow="Separator">
        <div className="flex flex-col gap-2">
          <p className="text-sm text-body">Above the line</p>
          <Separator />
          <p className="text-sm text-body">Below the line</p>
        </div>
        <div className="flex h-8 items-center gap-4">
          <span className="text-sm text-body">Files</span>
          <Separator orientation="vertical" />
          <span className="text-sm text-body">Galleries</span>
          <Separator orientation="vertical" />
          <span className="text-sm text-body">People</span>
        </div>
      </Section>

      <Section eyebrow="Skeleton">
        <div className="flex max-w-sm flex-col gap-3 rounded-lg border p-4">
          <Skeleton className="h-32 w-full rounded-lg" />
          <div className="flex items-center gap-3">
            <Skeleton className="size-8 rounded-full" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          </div>
        </div>
      </Section>

      <Section eyebrow="Sidebar">
        <div className="relative h-[520px] w-full overflow-hidden rounded-lg border [&_[data-slot=sidebar-container]]:absolute! [&_[data-slot=sidebar-container]]:h-full!">
          <SidebarProvider className="h-full min-h-0">
            <Sidebar collapsible="icon" className="h-full">
              <SidebarHeader>
                <span className="px-2 font-mono text-[13px] tracking-[0.08em] text-accent uppercase">
                  uploads.sh
                </span>
              </SidebarHeader>
              <SidebarContent>
                <SidebarGroup>
                  <SidebarGroupLabel>Workspace</SidebarGroupLabel>
                  <SidebarGroupContent>
                    <SidebarMenu>
                      <SidebarMenuItem>
                        <SidebarMenuButton isActive>Files</SidebarMenuButton>
                      </SidebarMenuItem>
                      <SidebarMenuItem>
                        <SidebarMenuButton>Screenshots</SidebarMenuButton>
                      </SidebarMenuItem>
                      <SidebarMenuItem>
                        <SidebarMenuButton>Galleries</SidebarMenuButton>
                      </SidebarMenuItem>
                      <SidebarMenuItem>
                        <SidebarMenuButton>Settings</SidebarMenuButton>
                      </SidebarMenuItem>
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>
              </SidebarContent>
              <SidebarFooter>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton>Ada Lovelace</SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarFooter>
            </Sidebar>
            <div className="flex flex-1 flex-col gap-2 p-4">
              <SidebarTrigger />
              <p className="text-sm text-muted-foreground">
                Sidebar content area — collapse via the trigger above.
              </p>
            </div>
          </SidebarProvider>
        </div>
      </Section>
    </div>
  );
}
