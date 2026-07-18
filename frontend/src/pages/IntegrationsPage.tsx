import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { usePageTitle } from "../hooks/usePageTitle";
import { queryKeys } from "../lib/queryKeys";
import { AuthSection } from "./integrations/AuthSection";
import { ArrIntegrationsSection } from "./integrations/ArrIntegrationsSection";
import { MalSection } from "./integrations/MalSection";
import { LoggingSection } from "./integrations/LoggingSection";
import { WebhookSecretSection } from "./integrations/WebhookSecretSection";
import { AlertsSection } from "./integrations/AlertsSection";

export function IntegrationsPage(): JSX.Element {
  usePageTitle("Integrations");

  const authStatus = useQuery({ queryKey: queryKeys.authStatus, queryFn: api.authStatus });
  const integrations = useQuery({ queryKey: queryKeys.integrations, queryFn: api.integrations });
  const malConfig = useQuery({ queryKey: queryKeys.malConfig, queryFn: api.malConfig });
  const loggingConfig = useQuery({ queryKey: queryKeys.loggingConfig, queryFn: api.loggingConfig });
  const webhookConfig = useQuery({ queryKey: queryKeys.webhookConfig, queryFn: api.webhookConfig });
  const alertWebhookConfig = useQuery({ queryKey: queryKeys.alertWebhookConfig, queryFn: api.alertWebhookConfig });

  return (
    <div className="space-y-6">
      <AuthSection authStatus={authStatus} />
      <ArrIntegrationsSection integrations={integrations} />
      <MalSection malConfig={malConfig} />
      <LoggingSection loggingConfig={loggingConfig} />
      <WebhookSecretSection webhookConfig={webhookConfig} />
      <AlertsSection alertWebhookConfig={alertWebhookConfig} />
    </div>
  );
}
