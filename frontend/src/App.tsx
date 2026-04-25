import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { ActionErrorProvider } from "./context/ActionErrorContext";
import { AppLayout } from "./layout/AppLayout";
import { PageFallback } from "./components/PageFallback";
import { RequireSetup } from "./routes/RequireSetup";
import { PATHS } from "./routes/paths";
import { SetupPage } from "./pages/SetupPage";

const HomePage = lazy(() => import("./pages/HomePage").then((m) => ({ default: m.HomePage })));
const DashboardPage = lazy(() => import("./pages/DashboardPage").then((m) => ({ default: m.DashboardPage })));
const ReportingPage = lazy(() => import("./pages/ReportingPage").then((m) => ({ default: m.ReportingPage })));
const LibraryPage = lazy(() => import("./pages/LibraryPage").then((m) => ({ default: m.LibraryPage })));
const SyncQueuePage = lazy(() => import("./pages/SyncQueuePage").then((m) => ({ default: m.SyncQueuePage })));
const IntegrationsPage = lazy(() => import("./pages/IntegrationsPage").then((m) => ({ default: m.IntegrationsPage })));
const SchedulesPage = lazy(() => import("./pages/SchedulesPage").then((m) => ({ default: m.SchedulesPage })));
const LogsPage = lazy(() => import("./pages/LogsPage").then((m) => ({ default: m.LogsPage })));
const NotFoundPage = lazy(() => import("./components/NotFoundPage").then((m) => ({ default: m.NotFoundPage })));

export function App(): JSX.Element {
  return (
    <ActionErrorProvider>
      <Routes>
        <Route path={PATHS.setup} element={<SetupPage />} />
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
