import { useContext } from "react";
import { ActionErrorContext, type ActionErrorContextValue } from "../context/actionErrorContextBase";

export function useActionError(): ActionErrorContextValue {
  const v = useContext(ActionErrorContext);
  if (!v) throw new Error("useActionError must be used within ActionErrorProvider");
  return v;
}
