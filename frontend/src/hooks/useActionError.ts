import { useContext } from "react";
import {
  ActionErrorActionsContext,
  ActionErrorStateContext,
  type ActionErrorContextValue,
} from "../context/actionErrorContextBase";

/** Combined view over both the (frequently-changing) error state and the
    (stable) actions context — the common case for components that read
    `lastError`/`errorContext` and call `runAction`. Components that only
    need to fire actions can instead read `ActionErrorActionsContext`
    directly to avoid re-rendering on unrelated error-state changes. */
export function useActionError(): ActionErrorContextValue {
  const state = useContext(ActionErrorStateContext);
  const actions = useContext(ActionErrorActionsContext);
  if (!state || !actions) throw new Error("useActionError must be used within ActionErrorProvider");
  return { ...state, ...actions };
}
