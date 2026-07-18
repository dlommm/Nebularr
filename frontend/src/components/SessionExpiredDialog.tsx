import { useLocation, useNavigate } from "react-router-dom";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

/**
 * Forced re-login prompt shown when `/api/*` returns a 401 outside of the
 * login flow itself. No dismiss path — the session really is gone, so the
 * only way out is signing back in; the button carries the current location
 * as `?next=` so login returns the user where they left off.
 */
export function SessionExpiredDialog({ open }: { open: boolean }): JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();

  // Never cover the login page with its own re-login prompt: a 401 elsewhere
  // (e.g. a cold-load setup-status check) can both flip this open and route to
  // /login, and the login form must stay unobstructed.
  const showDialog = open && location.pathname !== "/login";

  const goToLogin = (): void => {
    const next = encodeURIComponent(location.pathname + location.search);
    navigate(`/login?next=${next}`, { replace: true });
  };

  return (
    <Dialog open={showDialog}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Session expired — log in again</DialogTitle>
          <DialogDescription>Your session has ended. Sign in again to keep going.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" onClick={goToLogin}>
            Log in
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
