import "./canvas.module.css";
import {
  Button,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@uploads/ui";

export function Default() {
  return (
    <Empty style={{ width: 420 }} className="border">
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
  );
}

export function TitleOnly() {
  return (
    <Empty style={{ width: 420 }} className="border">
      <EmptyHeader>
        <EmptyTitle>No galleries yet</EmptyTitle>
        <EmptyDescription>Create one to collect related uploads.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export function Inline() {
  return (
    <Empty style={{ width: 420 }} className="items-start border-0 p-2 text-left">
      <EmptyHeader className="items-start text-left">
        <EmptyTitle>No tokens yet</EmptyTitle>
        <EmptyDescription>Create one above to start.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
