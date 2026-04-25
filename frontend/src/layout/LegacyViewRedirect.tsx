import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { PATHS } from "../routes/paths";

const LEGACY_VIEW_MAP: Record<string, string> = {
  overview: PATHS.dashboard,
  reporting: PATHS.reporting,
  integrations: PATHS.integrations,
  schedules: PATHS.schedules,
  runs: PATHS.runs,
  library: PATHS.library,
  webhooks: PATHS.webhooks,
  actions: PATHS.actions,
  logs: PATHS.logs,
};

/**
 * One-time migration from nebularr.active.view to real URLs; removes the key after redirect.
 */
export function LegacyViewRedirect(): null {
  const navigate = useNavigate();
  useEffect(() => {
    const storage = window.localStorage as Storage | Record<string, unknown>;
    const getItem = (storage as Storage).getItem;
    const removeItem = (storage as Storage).removeItem;
    if (typeof getItem !== "function" || typeof removeItem !== "function") return;
    const raw = getItem.call(storage, "nebularr.active.view");
    if (!raw) return;
    removeItem.call(storage, "nebularr.active.view");
    const target = LEGACY_VIEW_MAP[raw];
    if (target) {
      navigate(target, { replace: true });
    }
  }, [navigate]);
  return null;
}
