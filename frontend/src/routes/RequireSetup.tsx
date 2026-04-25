import { Navigate, Outlet } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { PageFallback } from "../components/PageFallback";
import { PATHS } from "./paths";

export function RequireSetup(): JSX.Element {
  const setup = useQuery({
    queryKey: ["setup-status"],
    queryFn: api.setupStatus,
  });
  if (setup.isLoading || !setup.data) {
    return <PageFallback />;
  }
  if (!setup.data.completed) {
    return <Navigate to={PATHS.setup} replace />;
  }
  return <Outlet />;
}
