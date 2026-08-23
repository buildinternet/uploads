import "./canvas.module.css";
import {
  Button,
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverDescription,
} from "@uploads/ui";

export function ShareDetails() {
  return (
    <Popover open>
      <PopoverTrigger render={<Button variant="outline">Share</Button>} />
      <PopoverContent>
        <PopoverHeader>
          <PopoverTitle>Share console-after.png</PopoverTitle>
          <PopoverDescription>Anyone with the link can view this file.</PopoverDescription>
        </PopoverHeader>
        <Button size="sm">Copy link</Button>
      </PopoverContent>
    </Popover>
  );
}
