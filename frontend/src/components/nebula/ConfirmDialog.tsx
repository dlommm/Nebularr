import { useEffect, useState, type ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type ConfirmRequest = {
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  /** Require typing this phrase (case-insensitive) before the action is enabled. */
  typedPhrase?: string;
  onConfirm: () => void;
};

/**
 * Page-level confirmation dialog. Render `confirmDialog` once and call
 * `requestConfirm` from any action that needs confirmation.
 */
export function useConfirmDialog(): {
  requestConfirm: (request: ConfirmRequest) => void;
  confirmDialog: JSX.Element;
} {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  return {
    requestConfirm: setRequest,
    confirmDialog: <ConfirmDialog request={request} onClose={() => setRequest(null)} />,
  };
}

// eslint-disable-next-line react-refresh/only-export-components -- the hook is the public API; the dialog belongs with it
function ConfirmDialog({
  request,
  onClose,
}: {
  request: ConfirmRequest | null;
  onClose: () => void;
}): JSX.Element {
  const [typed, setTyped] = useState("");
  useEffect(() => {
    if (request == null) setTyped("");
  }, [request]);
  const phraseOk =
    !request?.typedPhrase || typed.trim().toUpperCase() === request.typedPhrase.toUpperCase();

  return (
    <Dialog
      open={request != null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{request?.title}</DialogTitle>
          <DialogDescription>{request?.description}</DialogDescription>
        </DialogHeader>
        {request?.typedPhrase ? (
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">
              Type <code className="rounded bg-muted px-1 font-mono">{request.typedPhrase}</code> to
              enable the action.
            </p>
            <Input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoFocus
              aria-label={`Type ${request.typedPhrase} to confirm`}
            />
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={request?.destructive ? "destructive" : "default"}
            disabled={!phraseOk}
            onClick={() => {
              request?.onConfirm();
              onClose();
            }}
          >
            {request?.confirmLabel ?? "Confirm"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
