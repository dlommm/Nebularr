import { api } from "../api";
import type { IntegrityAuditResult } from "../types";
import { useConfirmDialog } from "../components/nebula/ConfirmDialog";
import { useActionError } from "./useActionError";

export type SyncSource = "sonarr" | "radarr";

const SOURCE_LABELS: Record<SyncSource, string> = { sonarr: "Sonarr", radarr: "Radarr" };

export type UseSyncActionsResult = {
  /** Fires immediately — no confirmation, matches the existing incremental buttons. */
  runIncrementalSync: (source: SyncSource) => void;
  /** Confirms first: a full sync re-fetches the entire library. */
  runFullSync: (source: SyncSource) => void;
  /** Confirms first: a reconcile cross-checks and repairs drift for the entire library. */
  runReconcileSync: (source: SyncSource) => void;
  /** `onResult` receives the per-instance results on success, for pages that render them. */
  runIntegrityAudit: (onResult?: (results: IntegrityAuditResult[]) => void) => void;
  /** Render once near the bottom of the page — backs the confirm dialogs above. */
  confirmDialog: JSX.Element;
};

/**
 * Sync-trigger callbacks shared by every page that can kick off a Sonarr/
 * Radarr sync or an integrity audit. Dashboard and Sync & Queue previously
 * each carried their own copy of this confirm+toast logic; this hook is the
 * single source of the trigger copy so the two stay in sync.
 */
export function useSyncActions(): UseSyncActionsResult {
  const { runAction } = useActionError();
  const { requestConfirm, confirmDialog } = useConfirmDialog();

  const runIncrementalSync = (source: SyncSource): void => {
    const name = SOURCE_LABELS[source];
    void runAction(() => api.runSync(source, "incremental"), `sync ${source}/incremental`, {
      successMessage: `${name} incremental sync queued`,
    });
  };

  const runFullSync = (source: SyncSource): void => {
    const name = SOURCE_LABELS[source];
    requestConfirm({
      title: `Run ${name} full sync?`,
      description: `This re-fetches the entire ${name} library and can take a long time on large libraries.`,
      confirmLabel: "Run full sync",
      onConfirm: () =>
        void runAction(() => api.runSync(source, "full"), `sync ${source}/full`, {
          successMessage: `${name} full sync queued`,
        }),
    });
  };

  const runReconcileSync = (source: SyncSource): void => {
    const name = SOURCE_LABELS[source];
    requestConfirm({
      title: `Run ${name} full reconcile?`,
      description: `Cross-checks and repairs drift between ${name} and the warehouse for the entire library. This can take longer than a full sync.`,
      confirmLabel: "Run reconcile",
      onConfirm: () =>
        void runAction(() => api.runSync(source, "reconcile"), `sync ${source}/reconcile`, {
          successMessage: `${name} reconcile queued`,
        }),
    });
  };

  const runIntegrityAudit = (onResult?: (results: IntegrityAuditResult[]) => void): void => {
    void runAction(
      async () => {
        const result = await api.runIntegrityAudit("all");
        onResult?.(result.results);
        return result;
      },
      "run integrity audit",
      { successMessage: "Integrity audit finished" },
    );
  };

  return { runIncrementalSync, runFullSync, runReconcileSync, runIntegrityAudit, confirmDialog };
}
