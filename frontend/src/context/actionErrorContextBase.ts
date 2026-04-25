import { createContext } from "react";

export type ActionErrorContextValue = {
  lastError: string | null;
  setLastError: (m: string | null) => void;
  errorContext: string | null;
  setErrorContext: (m: string | null) => void;
  setError: (err: unknown, context: string) => void;
  runAction: (fn: () => Promise<unknown>, context: string) => Promise<void>;
};

export const ActionErrorContext = createContext<ActionErrorContextValue | null>(null);
