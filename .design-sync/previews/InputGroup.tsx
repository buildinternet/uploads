import "./canvas.module.css";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupText,
  InputGroupInput,
  InputGroupTextarea,
} from "@uploads/ui";
import { SearchIcon, CopyIcon, LinkIcon } from "lucide-react";

export function SearchFiles() {
  return (
    <div style={{ width: 300 }}>
      <InputGroup>
        <InputGroupAddon>
          <SearchIcon />
        </InputGroupAddon>
        <InputGroupInput placeholder="Search screenshots…" />
      </InputGroup>
    </div>
  );
}

export function CopyableLink() {
  return (
    <div style={{ width: 340 }}>
      <InputGroup>
        <InputGroupAddon>
          <LinkIcon />
        </InputGroupAddon>
        <InputGroupInput defaultValue="https://uploads.sh/f/console-after" readOnly />
        <InputGroupAddon align="inline-end">
          <InputGroupButton size="icon-xs" aria-label="Copy link">
            <CopyIcon />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}

export function TextAddon() {
  return (
    <div style={{ width: 300 }}>
      <InputGroup>
        <InputGroupAddon>
          <InputGroupText>uploads.sh/</InputGroupText>
        </InputGroupAddon>
        <InputGroupInput defaultValue="acme-widgets" />
      </InputGroup>
    </div>
  );
}

export function CommentTextarea() {
  return (
    <div style={{ width: 340 }}>
      <InputGroup>
        <InputGroupTextarea placeholder="Add a note about this attachment…" rows={3} />
        <InputGroupAddon align="block-end">
          <InputGroupButton variant="outline" size="sm">
            Attach to PR
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}
