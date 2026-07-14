import { createContext } from "react";

export type RunActionOptions = {
  /** Toast this on success; omit for quiet actions to avoid toast spam. */
  successMessage?: string;
  /** Extra react-query keys to invalidate on success. */
  invalidate?: string[][];
};

export type ActionErrorContextValue = {
  lastError: string | null;
  setLastError: (m: string | null) => void;
  errorContext: string | null;
  setErrorContext: (m: string | null) => void;
  setError: (err: unknown, context: string) => void;
  runAction: (fn: () => Promise<unknown>, context: string, opts?: RunActionOptions) => Promise<void>;
};

export const ActionErrorContext = createContext<ActionErrorContextValue | null>(null);
