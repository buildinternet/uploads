/**
 * Quiet, read-only AI labels for Storage file detail. Server-owned — no
 * inputs. Renders nothing when `parseAiLabels` is silent.
 */
import { Badge } from "@uploads/ui/components/ui/badge";
import { AI_CHIP_FIELDS, parseAiLabels } from "../lib/ai-labels";

export function MetaChip({ label, value }: { label?: string; value: string }) {
  return (
    <Badge
      variant="outline"
      className="h-auto max-w-full gap-[5px] rounded-[2px] border-line bg-panel px-2 py-0.5 font-mono text-[length:var(--text-micro)] font-normal tracking-normal normal-case"
    >
      {label ? <span className="text-muted-foreground">{label}</span> : null}
      <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-fg">
        {value}
      </span>
    </Badge>
  );
}

export function UserPrimaryChips({ metadata }: { metadata?: Record<string, string> | null }) {
  const path = metadata?.path?.trim();
  const state = metadata?.state?.trim();
  if (!path && !state) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {path ? <MetaChip label="path" value={path} /> : null}
      {state ? <MetaChip label="state" value={state} /> : null}
    </div>
  );
}

export function AiLabels({ metadata }: { metadata?: Record<string, string> | null }) {
  const labels = parseAiLabels(metadata);
  if (!labels) return null;

  const chips = AI_CHIP_FIELDS.flatMap((field) => {
    const value = labels[field];
    return value ? [{ field, value }] : [];
  });

  return (
    <section className="grid gap-2" aria-label="AI labels">
      <div className="flex items-center gap-2">
        <span className="text-[length:var(--text-micro)] tracking-[0.14em] text-muted-foreground uppercase">
          AI labels
        </span>
        <span className="text-[length:var(--text-micro)] text-muted-foreground/70">
          experimental
        </span>
      </div>
      {(chips.length > 0 || labels.tags.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {chips.map(({ field, value }) => (
            <MetaChip key={field} label={field} value={value} />
          ))}
          {labels.tags.map((tag) => (
            <MetaChip key={tag} value={tag} />
          ))}
        </div>
      )}
      {labels.summary ? (
        <p className="m-0 text-[length:var(--text-micro)] leading-5 text-muted-foreground">
          {labels.summary}
        </p>
      ) : null}
    </section>
  );
}
