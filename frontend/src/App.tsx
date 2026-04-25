import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router-dom";
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
const RunsPage = lazy(() => import("./pages/RunsPage").then((m) => ({ default: m.RunsPage })));
const IntegrationsPage = lazy(() => import("./pages/IntegrationsPage").then((m) => ({ default: m.IntegrationsPage })));
const SchedulesPage = lazy(() => import("./pages/SchedulesPage").then((m) => ({ default: m.SchedulesPage })));
const WebhooksPage = lazy(() => import("./pages/WebhooksPage").then((m) => ({ default: m.WebhooksPage })));
const ActionsPage = lazy(() => import("./pages/ActionsPage").then((m) => ({ default: m.ActionsPage })));
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
            <Route path="runs" element={<RunsPage />} />
            <Route path="integrations" element={<IntegrationsPage />} />
            <Route path="schedules" element={<SchedulesPage />} />
            <Route path="webhooks" element={<WebhooksPage />} />
            <Route path="actions" element={<ActionsPage />} />
            <Route path="logs" element={<LogsPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Route>
      </Routes>
    </ActionErrorProvider>
  );
}
