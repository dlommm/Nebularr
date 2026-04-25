import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ActionErrorContext, type ActionErrorContextValue } from "./actionErrorContextBase";

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
    async (fn: () => Promise<unknown>, context: string): Promise<void> => {
      try {
        await fn();
        setLastError(null);
        setErrorContext(null);
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["status"] }),
          queryClient.invalidateQueries({ queryKey: ["sync-activity"] }),
          queryClient.invalidateQueries({ queryKey: ["runs"] }),
        ]);
      } catch (err) {
        setError(err, context);
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
