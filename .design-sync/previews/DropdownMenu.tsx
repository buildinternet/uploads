import "./canvas.module.css";
import {
  Button,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@uploads/ui";

export function FileActions() {
  return (
    <DropdownMenu open>
      <DropdownMenuTrigger render={<Button variant="outline">console-after.png ⋯</Button>} />
      <DropdownMenuContent>
        <DropdownMenuGroup>
          <DropdownMenuLabel>console-after.png</DropdownMenuLabel>
          <DropdownMenuItem>Copy link</DropdownMenuItem>
          <DropdownMenuItem>Copy markdown</DropdownMenuItem>
          <DropdownMenuItem>Attach to PR #778</DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem>Unlist</DropdownMenuItem>
          <DropdownMenuItem variant="destructive">Delete</DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
