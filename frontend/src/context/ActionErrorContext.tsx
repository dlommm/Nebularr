import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { queryKeys } from "../lib/queryKeys";
import {
  ActionErrorActionsContext,
  ActionErrorStateContext,
  type ActionErrorContextValue,
  type RunActionOptions,
} from "./actionErrorContextBase";

export type { ActionErrorContextValue };

export function ActionErrorProvider({ children }: { children: ReactNode }): JSX.Element {
  const queryClient = useQueryClient();
  const [lastError, setLastError] = useState<string | null>(null);
  const [errorContext, setErrorContext] = useState<string | null>(null);

  const setError = useCallback((err: unknown, context: string) => {
    const message = err instanceof Error ? err.message : String(err);
    setLastError(message);
    setErrorContext(context);
  }, []);

  const runAction = useCallback(
    async (fn: () => Promise<unknown>, context: string, opts?: RunActionOptions): Promise<boolean> => {
      try {
        await fn();
        setLastError(null);
        setErrorContext(null);
        if (opts?.successMessage) {
          toast.success(opts.successMessage);
        }
        const extraKeys = opts?.invalidate ?? [];
        await Promise.all(
          [queryKeys.status, queryKeys.syncActivity, queryKeys.runs, queryKeys.workStatus, ...extraKeys].map(
            (queryKey) => queryClient.invalidateQueries({ queryKey: queryKey as unknown[] }),
          ),
        );
        return true;
      } catch (err) {
        setError(err, context);
        toast.error(`${context} failed`);
        return false;
      }
    },
    [queryClient, setError],
  );

  // Stable regardless of lastError/errorContext, so consumers that only need
  // to fire actions (not read the shared error state) don't re-render on
  // every unrelated action's error.
  const actionsValue = useMemo(() => ({ setError, runAction }), [setError, runAction]);
  const stateValue = useMemo(
    () => ({ lastError, setLastError, errorContext, setErrorContext }),
    [lastError, errorContext],
  );

  return (
    <ActionErrorActionsContext.Provider value={actionsValue}>
      <ActionErrorStateContext.Provider value={stateValue}>{children}</ActionErrorStateContext.Provider>
    </ActionErrorActionsContext.Provider>
  );
}
