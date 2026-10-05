/**
 * Empty states for the Files views: a title, a one-line hint, and one
 * copyable command (the galleries empty state's shape), plus a compact
 * inline variant for "nothing matches this filter".
 */
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@uploads/ui/components/ui/empty";
import { useState, type CSSProperties, type ReactNode } from "react";

export function CommandEmpty({
  title,
  description,
  command,
  footer,
}: {
  title: string;
  description: ReactNode;
  command: string;
  /** Optional extra line under the command (e.g. a link to another view). */
  footer?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // clipboard blocked — leave the label
    }
  };
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="max-w-xl">
        <div className="ws-empty__command flex w-full min-w-0 items-center gap-2 rounded-[6px] border border-line bg-panel px-3 py-2">
          <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-[var(--mono)] text-[13px] text-fg">
            {command}
          </code>
          <button
            type="button"
            aria-live="polite"
            className="text-btn text-btn--boxed flex-none"
            onClick={() => void copy()}
          >
            {copied ? "copied ✓" : "copy"}
          </button>
        </div>
        {footer}
      </EmptyContent>
    </Empty>
  );
}

/** Compact Empty for inline "nothing found" messages inside a scoped list. */
export function InlineEmpty({ title }: { title: ReactNode }) {
  return (
    <Empty className="gap-2 p-3">
      <EmptyHeader className="gap-1">
        <EmptyTitle>{title}</EmptyTitle>
      </EmptyHeader>
    </Empty>
  );
}

/** Row placeholders for the list views (label bar + four thumbs per row). */
export function RowsSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="grid gap-6" aria-busy="true">
      {Array.from({ length: rows }, (_, row) => (
        <div className="wsp-group grid gap-2.5" key={row}>
          <span
            className="ws-skel"
            aria-hidden="true"
            style={{ "--ws-skel-w": "220px" } as CSSProperties}
          />
          <div className="wsp-strip">
            {[0, 1, 2, 3].map((i) => (
              <span className="wsp-thumb wsp-thumb--skel" key={i} aria-hidden="true" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
