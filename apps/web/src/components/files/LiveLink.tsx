/**
 * Live-link UI for the Files views: the private-items confirm (shadcn
 * AlertDialog), the copy toast, and the row overflow menu. `useLiveLink`
 * wires runCopyLiveLink to the real API and clipboard.
 */
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@uploads/ui/components/ui/alert-dialog";
import { Button } from "@uploads/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@uploads/ui/components/ui/dropdown-menu";
import { EllipsisIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createLiveLink, loadShareInfo } from "../../lib/files-api";
import { linksHref } from "../../lib/files-view-state";
import {
  liveLinkScopeKey,
  liveLinkScopeLabel,
  liveLinkToast,
  privateConfirmText,
  runCopyLiveLink,
  writeClipboardUrl,
  type CopyLiveLinkOutcome,
  type LiveLinkScope,
  type ScopeShareInfo,
  type ToastMessage,
} from "../../lib/live-link-flow";

/** Starts the write now; the caller is inside the user's click. */
function copyUrlToClipboard(url: Promise<string>): Promise<boolean> {
  return writeClipboardUrl(
    typeof navigator === "undefined" ? undefined : navigator.clipboard,
    typeof ClipboardItem === "undefined" ? undefined : ClipboardItem,
    url,
  );
}

/** Polite live region; always mounted so screen readers announce inserts. */
export function Toast({
  message,
  onDismiss,
}: {
  message: ToastMessage | null;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    setCopied(false);
    if (!message || message.sticky) return;
    const timer = window.setTimeout(onDismiss, 8000);
    return () => window.clearTimeout(timer);
  }, [message, onDismiss]);
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4"
    >
      {message && (
        <div className="pointer-events-auto flex max-w-xl items-center gap-3 rounded-[6px] border border-line bg-panel px-3.5 py-2.5 text-[13px] text-fg shadow-[0_8px_24px_rgb(0_0_0_/_0.25)]">
          <span className="min-w-0 [overflow-wrap:anywhere]">{message.text}</span>
          {message.link && (
            <a
              className="text-btn min-w-0 [overflow-wrap:anywhere]"
              href={message.link.href}
              {...(message.link.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
            >
              {message.link.label}
            </a>
          )}
          {message.copyText !== undefined && (
            <button
              type="button"
              className="text-btn flex-none"
              onClick={() => {
                // A fresh click, so the browser allows the write.
                void copyUrlToClipboard(Promise.resolve(message.copyText!)).then(setCopied);
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          )}
          <button
            type="button"
            className="text-btn flex-none"
            aria-label="Dismiss"
            onClick={onDismiss}
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}

interface PendingConfirm {
  count: number;
  label: string;
}

function LiveLinkConfirmDialog({
  pending,
  onDone,
}: {
  pending: PendingConfirm | null;
  onDone: (ok: boolean) => void;
}) {
  return (
    <AlertDialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) onDone(false);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {pending ? `Copy live link for ${pending.label}?` : "Copy live link?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {pending ? privateConfirmText(pending.count) : null}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel variant="outline" size="default">
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction size="default" onClick={() => onDone(true)}>
            Copy anyway
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export interface LiveLinkControls {
  /**
   * Call straight from the click handler (no await first): the clipboard
   * write starts inside that gesture. One copy runs at a time; a call while
   * another is running is a no-op that resolves `cancelled`.
   */
  copy: (scope: LiveLinkScope, known?: ScopeShareInfo | null) => Promise<CopyLiveLinkOutcome>;
  /** True while any copy runs: disable every Copy control, not just one row's. */
  busy: boolean;
  /** `liveLinkScopeKey` of the scope being copied. */
  busyKey: string | null;
  dialog: ReactNode;
  toast: ReactNode;
}

export function useLiveLink(apiOrigin: string, workspace: string): LiveLinkControls {
  const confirmed = useRef(new Set<string>());
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  const inFlight = useRef(false);
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const dismissToast = useCallback(() => setToast(null), []);

  const settle = (ok: boolean) => {
    const resolve = resolver.current;
    resolver.current = null;
    setPending(null);
    resolve?.(ok);
  };

  const copy = async (
    scope: LiveLinkScope,
    known?: ScopeShareInfo | null,
  ): Promise<CopyLiveLinkOutcome> => {
    if (inFlight.current) return { kind: "cancelled" };
    inFlight.current = true;
    setBusyKey(liveLinkScopeKey(scope));
    setToast(null);
    let outcome: CopyLiveLinkOutcome;
    try {
      outcome = await runCopyLiveLink(
        {
          loadShareInfo: (s) => loadShareInfo(apiOrigin, workspace, s),
          create: (s) => createLiveLink(apiOrigin, workspace, s),
          confirmPrivate: (count) =>
            new Promise<boolean>((resolve) => {
              resolver.current = resolve;
              setPending({ count, label: liveLinkScopeLabel(scope) });
            }),
          copyText: copyUrlToClipboard,
        },
        scope,
        { known: known ?? null, confirmed: confirmed.current },
      );
    } catch {
      outcome = { kind: "error" };
    } finally {
      inFlight.current = false;
      setBusyKey(null);
    }
    setToast(liveLinkToast(outcome, scope, linksHref(workspace)));
    return outcome;
  };

  return {
    copy,
    busy: busyKey !== null,
    busyKey,
    dialog: <LiveLinkConfirmDialog pending={pending} onDone={settle} />,
    toast: <Toast message={toast} onDismiss={dismissToast} />,
  };
}

/** PR and repo rows: Copy live link, Open on GitHub. */
export function RowOverflowMenu({
  label,
  githubUrl,
  busy,
  onCopyLiveLink,
}: {
  label: string;
  githubUrl: string;
  busy: boolean;
  onCopyLiveLink: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Actions for ${label}`}
            disabled={busy}
          >
            <EllipsisIcon aria-hidden="true" />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuItem onClick={onCopyLiveLink}>Copy live link</DropdownMenuItem>
        <DropdownMenuItem render={<a href={githubUrl} target="_blank" rel="noopener noreferrer" />}>
          Open on GitHub
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
