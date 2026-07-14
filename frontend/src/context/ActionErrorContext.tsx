import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ActionErrorContext,
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
    async (fn: () => Promise<unknown>, context: string, opts?: RunActionOptions): Promise<void> => {
      try {
        await fn();
        setLastError(null);
        setErrorContext(null);
        if (opts?.successMessage) {
          toast.success(opts.successMessage);
        }
        const extraKeys = opts?.invalidate ?? [];
        await Promise.all(
          [["status"], ["sync-activity"], ["runs"], ["work-status"], ...extraKeys].map((queryKey) =>
            queryClient.invalidateQueries({ queryKey }),
          ),
        );
      } catch (err) {
        setError(err, context);
        toast.error(`${context} failed`);
      }
    },
    [queryClient, setError],
  );

  const value = useMemo(
    () => ({
      lastError,
      setLastError,
      errorContext,
      setErrorContext,
      setError,
      runAction,
    }),
    [lastError, errorContext, setError, runAction],
  );

  return <ActionErrorContext.Provider value={value}>{children}</ActionErrorContext.Provider>;
}
