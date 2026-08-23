import "./canvas.module.css";
import { Button, Tooltip, TooltipProvider, TooltipTrigger, TooltipContent } from "@uploads/ui";

export function CopyHint() {
  return (
    <TooltipProvider>
      <Tooltip open>
        <TooltipTrigger render={<Button variant="outline">Copy link</Button>} />
        <TooltipContent>Copy the public link for console-after.png</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
