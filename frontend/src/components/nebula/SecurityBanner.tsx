import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ShieldAlert, X } from "lucide-react";
import { api } from "../../api";
import { PATHS } from "../../routes/paths";
import { Button } from "@/components/ui/button";

const DISMISS_KEY = "nebularr.security-banner.dismissed";

export function SecurityBanner(): JSX.Element | null {
  const [dismissed, setDismissed] = useState(() => sessionStorage.getItem(DISMISS_KEY) === "true");
  const authStatus = useQuery({ queryKey: ["auth-status"], queryFn: api.authStatus, staleTime: 60_000 });
  const healthz = useQuery({ queryKey: ["healthz"], queryFn: api.healthz, staleTime: 60_000 });

  if (dismissed || !authStatus.data) {
    return null;
  }
  const warnings: string[] = [];
  if (!authStatus.data.enabled) {
    warnings.push("Authentication is disabled — anyone on your network can change this server's configuration.");
  }
  if (healthz.data?.encryption === "plaintext") {
    warnings.push("Secrets are stored unencrypted (no encryption key available).");
  }
  if (warnings.length === 0) {
    return null;
  }
  return (
    <div
      role="alert"
      className="mb-4 flex items-start gap-3 rounded-lg border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-sm text-amber-100"
    >
      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" aria-hidden />
      <div className="flex-1">
        {warnings.map((warning) => (
          <p key={warning}>{warning}</p>
        ))}
        {!authStatus.data.enabled ? (
          <p className="mt-1">
            <Link to={PATHS.integrations} className="font-medium underline underline-offset-2">
              Set an admin password in Integrations → Authentication
            </Link>
          </p>
        ) : null}
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6 shrink-0 text-amber-200"
        aria-label="Dismiss security warning for this session"
        onClick={() => {
          sessionStorage.setItem(DISMISS_KEY, "true");
          setDismissed(true);
        }}
      >
        <X className="h-4 w-4" aria-hidden />
      </Button>
    </div>
  );
}
