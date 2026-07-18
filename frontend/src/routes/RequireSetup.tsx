import { Navigate, Outlet } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
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
