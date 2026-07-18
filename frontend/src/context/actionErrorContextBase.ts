import { createContext } from "react";

export type RunActionOptions = {
  /** Toast this on success; omit for quiet actions to avoid toast spam. */
  successMessage?: string;
  /** Extra react-query keys to invalidate on success. */
  invalidate?: string[][];
};

export type ActionErrorState = {
  lastError: string | null;
  setLastError: (m: string | null) => void;
  errorContext: string | null;
  setErrorContext: (m: string | null) => void;
};

export type ActionErrorActions = {
  setError: (err: unknown, context: string) => void;
  /** Runs `fn`, clearing/recording the shared error state; resolves `true`
      on success, `false` on failure (already toasted/recorded). */
  runAction: (fn: () => Promise<unknown>, context: string, opts?: RunActionOptions) => Promise<boolean>;
};

export type ActionErrorContextValue = ActionErrorState & ActionErrorActions;

/** Changes on every action attempt (lastError/errorContext) — components
    that render the current error should read this. */
export const ActionErrorStateContext = createContext<ActionErrorState | null>(null);

/** Stable across error-state changes (only recreated if the QueryClient
    changes) — components that only need to fire actions can read this
    without re-rendering whenever some other action's error state changes. */
export const ActionErrorActionsContext = createContext<ActionErrorActions | null>(null);
