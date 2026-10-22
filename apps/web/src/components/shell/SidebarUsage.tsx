/**
 * Workspace usage at the foot of the sidebar (moved from the right rail, which
 * is being cleared out). Collapsed it is one line: the fullest meter's label
 * and value over its bar. Expanded it shows every meter and the object count.
 * The open/closed choice is a per-viewer convenience in localStorage.
 *
 * Server render and the first client render both show the placeholder, so
 * hydration matches; the cached snapshot paints right after mount and the
 * shared summary request (deduped with the rest of the page) revalidates it.
 */
import { ChevronDown } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { onSession } from "../../lib/account-shell";
import { readWorkspaceSnapshot } from "../../lib/workspace-cache";
import { loadWorkspaceSummary } from "../../lib/workspace-summary-source";
import {
  BYO_USAGE_NOTE,
  usageMeters,
  usagePlainText,
  type UsageMeter,
  type UsageSnapshot,
} from "../../lib/workspace-ui";

const OPEN_KEY = "uploads.sidebar-usage-open";

type UsageState =
  | { status: "loading" }
  | { status: "ready"; usage: UsageSnapshot }
  | { status: "unavailable" };

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

function writeOpen(open: boolean): void {
  try {
    localStorage.setItem(OPEN_KEY, open ? "1" : "0");
  } catch {
    // Private mode or blocked storage: the toggle still works for this page.
  }
}

function Meter({ meter }: { meter: UsageMeter }): ReactNode {
  const level = meter.pct >= 100 ? "full" : meter.pct >= 85 ? "high" : undefined;
  return (
    <div className="ul-progress__row">
      <div className="ul-progress__head">
        <span className="ul-progress__label">{meter.label}</span>
        <span className="ul-progress__value">{meter.detail}</span>
      </div>
      <div
        className="ul-progress__track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(meter.pct)}
        aria-label={meter.label}
      >
        <div className="ul-progress__fill" data-level={level} style={{ width: `${meter.pct}%` }} />
      </div>
    </div>
  );
}

export function SidebarUsage({
  apiOrigin,
  workspace,
}: {
  apiOrigin: string;
  workspace: string;
}): ReactNode {
  const [state, setState] = useState<UsageState>({ status: "loading" });
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(readOpen());
    let live = true;
    const cached = readWorkspaceSnapshot(workspace)?.usage;
    if (cached) setState({ status: "ready", usage: cached });
    onSession(() => {
      void loadWorkspaceSummary(apiOrigin, workspace).then((result) => {
        if (!live) return;
        if (result.kind === "success" && result.usage) {
          setState({ status: "ready", usage: result.usage });
        } else if (!cached) {
          // Keep a warm value over an error line: it was true recently.
          setState({ status: "unavailable" });
        }
      });
    });
    return () => {
      live = false;
    };
  }, [apiOrigin, workspace]);

  if (state.status === "unavailable") return null;

  const meters = state.status === "ready" ? usageMeters(state.usage) : [];
  // Collapsed, the fullest meter speaks for the rest.
  const lead = meters.reduce<UsageMeter | undefined>(
    (best, m) => (!best || m.pct > best.pct ? m : best),
    undefined,
  );
  const toggle = () => {
    setOpen((prev) => {
      writeOpen(!prev);
      return !prev;
    });
  };

  return (
    <div className="grid gap-2 border-t border-sidebar-border px-2 pt-3 group-data-[collapsible=icon]:hidden">
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-md border-0 bg-transparent p-0 text-left text-xs font-medium text-sidebar-foreground/70 cursor-pointer hover:text-sidebar-foreground focus-visible:text-sidebar-foreground"
        aria-expanded={open}
        onClick={toggle}
      >
        <span>Usage</span>
        <ChevronDown
          aria-hidden
          className={`ml-auto size-3.5 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {state.status === "loading" ? (
        <div className="ul-progress" aria-busy="true">
          <div className="ul-progress__track">
            <div className="ul-progress__fill" style={{ width: "0%" }} />
          </div>
        </div>
      ) : meters.length === 0 ? (
        <p className="m-0 text-xs text-muted-foreground">{usagePlainText(state.usage)}</p>
      ) : (
        <div className="ul-progress">
          {(open ? meters : lead ? [lead] : []).map((meter) => (
            <Meter key={meter.label} meter={meter} />
          ))}
          {open && (
            <p className="m-0 text-xs text-muted-foreground">
              {`${state.usage.objects} object${state.usage.objects === 1 ? "" : "s"}`}
              {state.usage.storageBudgetBasis === "shared" ? ` · ${BYO_USAGE_NOTE}` : ""}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
