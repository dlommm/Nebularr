import { useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import { useActionError } from "../../hooks/useActionError";
import { queryKeys } from "../../lib/queryKeys";
import { QueryErrorNotice } from "@/components/nebula/QueryErrorNotice";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SectionCard } from "./shared";

export function WebhookSecretSection({
  webhookConfig,
}: {
  webhookConfig: UseQueryResult<{ secret_set: boolean }>;
}): JSX.Element {
  const queryClient = useQueryClient();
  const { setError, runAction } = useActionError();
  const [webhookSecretInput, setWebhookSecretInput] = useState("");

  const saveWebhookSecret = async (): Promise<void> => {
    if (!webhookSecretInput.trim()) {
      setError("Webhook secret cannot be empty", "save webhook secret");
      return;
    }
    await runAction(
      async () => {
        await api.saveWebhookConfig(webhookSecretInput.trim());
        setWebhookSecretInput("");
        await queryClient.invalidateQueries({ queryKey: queryKeys.webhookConfig });
      },
      "save webhook secret",
    );
  };

  return (
    <SectionCard title="Webhook shared secret" description="Sonarr/Radarr must send this value in the x-arr-shared-secret header.">
      {webhookConfig.isError ? (
        <QueryErrorNotice label="webhook settings" retry={() => void webhookConfig.refetch()} error={webhookConfig.error} />
      ) : null}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <Badge variant={webhookConfig.data?.secret_set ? "outline" : "destructive"} className="self-start sm:self-center">
          {webhookConfig.data?.secret_set ? "secret set" : "secret missing"}
        </Badge>
        <div className="grid w-full gap-1.5">
          <Label htmlFor="webhook-secret" className="text-xs text-muted-foreground">
            Set new webhook shared secret
          </Label>
          <Input
            id="webhook-secret"
            type="password"
            autoComplete="off"
            value={webhookSecretInput}
            onChange={(event) => setWebhookSecretInput(event.target.value)}
          />
        </div>
        <Button type="button" variant="secondary" className="shrink-0" onClick={() => void saveWebhookSecret()}>
          Save secret
        </Button>
      </div>
    </SectionCard>
  );
}
