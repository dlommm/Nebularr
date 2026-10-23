import { DiagnosticsPanel } from "../components/ui";
import { SecurityBanner } from "../components/nebula/SecurityBanner";
import { useActionError } from "../hooks/useActionError";

/** Security warnings and the last action error. The shell renders these above
    each page; full-bleed pages (the Overview) render them below their hero so
    the transparent header never covers them. */
export function ShellNotices(): JSX.Element {
  const { lastError, setLastError, errorContext } = useActionError();
  return (
    <>
      <SecurityBanner />
      <DiagnosticsPanel message={lastError} context={errorContext} clear={() => setLastError(null)} />
    </>
  );
}
