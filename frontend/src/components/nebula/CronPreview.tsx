import { useEffect, useState } from "react";
import { CheckCircle2, XCircle } from "lucide-react";
import { api } from "../../api";
import { fmtDate, useDebouncedValue } from "../../hooks";

type CronValidation =
  | { state: "idle" | "loading" }
  | { state: "valid"; times: string[] }
  | { state: "invalid"; error: string };

/**
 * Live cron validation + next-run preview for a schedule input. Debounces the
 * value and calls the server (APScheduler is the source of truth), so a typo is
 * caught as you type instead of at save/schedule time. `onValidityChange` lets
 * the parent disable Save while the expression is invalid.
 */
export function CronPreview({
  cron,
  timezone,
  onValidityChange,
}: {
  cron: string;
  timezone?: string;
  onValidityChange?: (valid: boolean) => void;
}): JSX.Element | null {
  const debouncedCron = useDebouncedValue(cron.trim(), 400);
  const debouncedTz = useDebouncedValue((timezone ?? "").trim(), 400);
  const [result, setResult] = useState<CronValidation>({ state: "idle" });

  useEffect(() => {
    if (!debouncedCron) {
      setResult({ state: "idle" });
      onValidityChange?.(true);
      return;
    }
    let cancelled = false;
    setResult({ state: "loading" });
    api
      .validateSchedule({ cron: debouncedCron, timezone: debouncedTz || undefined })
      .then((response) => {
        if (cancelled) return;
        if (response.valid) {
          setResult({ state: "valid", times: response.next_fire_times ?? [] });
          onValidityChange?.(true);
        } else {
          setResult({ state: "invalid", error: response.error ?? "invalid cron expression" });
          onValidityChange?.(false);
        }
      })
      .catch(() => {
        if (cancelled) return;
        // A transport failure shouldn't block saving; treat as unknown-but-valid.
        setResult({ state: "idle" });
        onValidityChange?.(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedCron, debouncedTz]);

  if (result.state === "invalid") {
    return (
      <p className="flex items-center gap-1.5 text-xs text-critical">
        <XCircle className="size-3.5 shrink-0" aria-hidden />
        {result.error}
      </p>
    );
  }
  if (result.state === "valid") {
    const times = result.times;
    return (
      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-ok" aria-hidden />
        <span>Next: {times.length === 0 ? "—" : times.map((t) => fmtDate(t)).join(", ")}</span>
      </p>
    );
  }
  return null;
}
