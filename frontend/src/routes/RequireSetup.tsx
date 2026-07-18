import { Navigate, Outlet } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../api";
import { PageFallback } from "../components/PageFallback";
import { QueryErrorNotice } from "../components/nebula/QueryErrorNotice";
import { queryKeys } from "../lib/queryKeys";
import { PATHS } from "./paths";

export function RequireSetup(): JSX.Element {
  const setup = useQuery({
    queryKey: queryKeys.setupStatus,
    queryFn: api.setupStatus,
  });
  if (setup.isError) {
    // /api/setup/status isn't auth-exempt, so a session-less cold load on an
    // auth-enabled box 401s here. Go straight to login rather than a dead-end
    // error notice whose retry can only 401 again.
    if (setup.error instanceof ApiError && setup.error.status === 401) {
      return <Navigate to={PATHS.login} replace />;
    }
    return (
      <div className="flex min-h-svh items-center justify-center p-6">
        <QueryErrorNotice label="setup status" retry={() => void setup.refetch()} error={setup.error} />
      </div>
    );
  }
  if (setup.isLoading || !setup.data) {
    return <PageFallback />;
  }
  if (!setup.data.completed) {
    return <Navigate to={PATHS.setup} replace />;
  }
  return <Outlet />;
}
