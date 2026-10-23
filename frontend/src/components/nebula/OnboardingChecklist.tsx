import { Link } from "react-router-dom";
import { CheckCircle2, Circle, X } from "lucide-react";
import { useLocalStorageState } from "../../hooks";
import { Button } from "@/components/ui/button";
import { useReadinessSteps } from "../../hooks/useReadinessSteps";

/**
 * First-run guidance on the Dashboard. Auto-hides once every step is done,
 * and is dismissable so returning operators don't keep seeing it.
 */
export function OnboardingChecklist(): JSX.Element | null {
  const [dismissed, setDismissed] = useLocalStorageState("nebularr.onboarding.dismissed", false);
  const { steps, loading } = useReadinessSteps();

  // Wait until the signals load so we never flash the checklist at a configured
  // instance (which would then vanish and read as a glitch).
  if (dismissed || loading) return null;

  if (steps.every((step) => step.done)) return null;

  return (
    <section aria-labelledby="get-started" className="panel px-6 pt-5 pb-3 sm:px-7">
      <div className="flex items-center justify-between gap-2">
        <h2 id="get-started" className="cond text-[30px] leading-none font-bold">
          Get started <span className="text-muted-foreground">· {steps.filter((s) => s.done).length} of {steps.length}</span>
        </h2>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Dismiss getting-started checklist"
          onClick={() => setDismissed(true)}
        >
          <X className="size-4" />
        </Button>
      </div>
      <div>
        <ul className="mt-3">
          {steps.map((step) => (
            <li key={step.label} className="flex min-h-14 items-center justify-between gap-3 border-t border-border py-2">
              <span className="flex items-center gap-3 text-[15px]">
                {step.done ? (
                  <CheckCircle2 className="size-4 text-ok" aria-hidden />
                ) : (
                  <Circle className="size-4 text-muted-foreground" aria-hidden />
                )}
                <span className={step.done ? "text-muted-foreground line-through" : "text-foreground"}>
                  {step.label}
                </span>
              </span>
              {!step.done ? (
                <Button type="button" variant="outline" size="sm" render={<Link to={step.to} />}>
                  {step.cta}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
