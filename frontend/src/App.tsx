import { lazy, Suspense, useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { ActionErrorProvider } from "./context/ActionErrorContext";
import { AppLayout } from "./layout/AppLayout";
import { PageFallback } from "./components/PageFallback";
import { RouteErrorBoundary } from "./components/RouteErrorBoundary";
import { SessionExpiredDialog } from "./components/SessionExpiredDialog";
import { RequireSetup } from "./routes/RequireSetup";
import { PATHS } from "./routes/paths";

const SetupPage = lazy(() => import("./pages/SetupPage").then((m) => ({ default: m.SetupPage })));
const HomePage = lazy(() => import("./pages/HomePage").then((m) => ({ default: m.HomePage })));
const DashboardPage = lazy(() => import("./pages/DashboardPage").then((m) => ({ default: m.DashboardPage })));
const ReportingPage = lazy(() => import("./pages/ReportingPage").then((m) => ({ default: m.ReportingPage })));
const LibraryPage = lazy(() => import("./pages/LibraryPage").then((m) => ({ default: m.LibraryPage })));
const SyncQueuePage = lazy(() => import("./pages/SyncQueuePage").then((m) => ({ default: m.SyncQueuePage })));
const MalPage = lazy(() => import("./pages/MalPage").then((m) => ({ default: m.MalPage })));
const IntegrationsPage = lazy(() => import("./pages/IntegrationsPage").then((m) => ({ default: m.IntegrationsPage })));
const SchedulesPage = lazy(() => import("./pages/SchedulesPage").then((m) => ({ default: m.SchedulesPage })));
const LogsPage = lazy(() => import("./pages/LogsPage").then((m) => ({ default: m.LogsPage })));
const NotFoundPage = lazy(() => import("./components/NotFoundPage").then((m) => ({ default: m.NotFoundPage })));
const LoginPage = lazy(() => import("./pages/LoginPage").then((m) => ({ default: m.LoginPage })));

export function App(): JSX.Element {
  const [sessionExpired, setSessionExpired] = useState(false);

  // Lives at App level (not inside AppLayout) so it covers every route —
  // including RequireSetup and login-adjacent states where AppLayout never
  // mounts. A non-exempt 401 anywhere dispatches this event (see api.ts).
  useEffect(() => {
    const onSessionExpired = (): void => setSessionExpired(true);
    window.addEventListener("nebularr:session-expired", onSessionExpired);
    return () => window.removeEventListener("nebularr:session-expired", onSessionExpired);
  }, []);

  return (
    <ActionErrorProvider>
      <SessionExpiredDialog open={sessionExpired} />
      <Routes>
        {/* Setup and Login render outside AppLayout's boundary; wrap them so a
            render error shows a recoverable message instead of a blank page. */}
        <Route
          path={PATHS.setup}
          element={
            <RouteErrorBoundary>
              <Suspense fallback={<PageFallback />}>
                <SetupPage />
              </Suspense>
            </RouteErrorBoundary>
          }
        />
        <Route
          path="/login"
          element={
            <RouteErrorBoundary>
              <Suspense fallback={<PageFallback />}>
                <LoginPage />
              </Suspense>
            </RouteErrorBoundary>
          }
        />
        <Route element={<RequireSetup />}>
          <Route
            path="/"
            element={
              <Suspense fallback={<PageFallback />}>
                <AppLayout />
              </Suspense>
            }
          >
            <Route index element={<HomePage />} />
            <Route path="dashboard" element={<DashboardPage />} />
            <Route path="reporting" element={<ReportingPage />} />
            <Route path="library" element={<LibraryPage />} />
            <Route path="sync" element={<SyncQueuePage />} />
            <Route path="mal" element={<MalPage />} />
            <Route path="runs" element={<Navigate to={`${PATHS.sync}?tab=runs`} replace />} />
            <Route path="webhooks" element={<Navigate to={`${PATHS.sync}?tab=webhooks`} replace />} />
            <Route path="actions" element={<Navigate to={`${PATHS.sync}?tab=manual`} replace />} />
            <Route path="integrations" element={<IntegrationsPage />} />
            <Route path="schedules" element={<SchedulesPage />} />
            <Route path="logs" element={<LogsPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Route>
      </Routes>
    </ActionErrorProvider>
  );
}
