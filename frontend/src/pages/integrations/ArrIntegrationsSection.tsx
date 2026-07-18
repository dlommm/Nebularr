import { useMemo, useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import { fmtDate } from "../../hooks";
import { useActionError } from "../../hooks/useActionError";
import { useDraftSync } from "../../hooks/useDraftSync";
import { queryKeys } from "../../lib/queryKeys";
import type { IntegrationRow } from "../../types";
import { QueryErrorNotice } from "@/components/nebula/QueryErrorNotice";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { SectionCard } from "./shared";

type IntegrationDraft = IntegrationRow & { api_key: string };

const keyOf = (row: IntegrationDraft): string => `${row.source}:${row.name}`;

export function ArrIntegrationsSection({
  integrations,
}: {
  integrations: UseQueryResult<IntegrationRow[]>;
}): JSX.Element {
  const queryClient = useQueryClient();
  const { runAction } = useActionError();
  // The "new API key" field is never populated from the server (the stored
  // key isn't returned), so every server-derived draft starts it blank.
  const draftRows = useMemo(
    () => integrations.data?.map((row): IntegrationDraft => ({ ...row, api_key: "" })),
    [integrations.data],
  );
  const { drafts, setDraft, resetDraft } = useDraftSync(draftRows, keyOf);
  const [integrationTests, setIntegrationTests] = useState<
    Record<string, { status: "testing" | "ok" | "error"; detail?: string }>
  >({});

  const saveIntegration = async (source: string, name: string): Promise<void> => {
    const key = `${source}:${name}`;
    const draft = drafts[key];
    if (!draft) return;
    const ok = await runAction(
      async () => {
        await api.saveIntegration(source, {
          name,
          base_url: draft.base_url,
          api_key: draft.api_key,
          enabled: draft.enabled,
          webhook_enabled: draft.webhook_enabled,
        });
        await queryClient.invalidateQueries({ queryKey: queryKeys.integrations });
      },
      `save integration ${source}/${name}`,
    );
    if (ok) resetDraft(key);
  };

  const testIntegration = async (source: string, name: string): Promise<void> => {
    const key = `${source}:${name}`;
    const draft = drafts[key];
    setIntegrationTests((prev) => ({ ...prev, [key]: { status: "testing" } }));
    try {
      const result = await api.testIntegration(source, {
        name,
        // Send the edited values if present; blank falls back to stored server-side.
        base_url: draft?.base_url || undefined,
        api_key: draft?.api_key || undefined,
      });
      setIntegrationTests((prev) => ({
        ...prev,
        [key]: result.ok
          ? { status: "ok", detail: `${result.app_name ?? source} ${result.version ?? ""}`.trim() }
          : { status: "error", detail: result.error ?? "connection failed" },
      }));
    } catch (err) {
      setIntegrationTests((prev) => ({
        ...prev,
        [key]: { status: "error", detail: err instanceof Error ? err.message : String(err) },
      }));
    }
  };

  return (
    <SectionCard title="Integrations" description="Sonarr and Radarr connections used for library sync and tagging.">
      {integrations.isLoading ? <Skeleton className="h-32 w-full" /> : null}
      {integrations.isError ? (
        <QueryErrorNotice label="integrations" retry={() => void integrations.refetch()} error={integrations.error} />
      ) : null}
      {(integrations.data ?? []).map((row) => {
        const key = `${row.source}:${row.name}`;
        const draft = drafts[key] ?? { ...row, api_key: "" };
        return (
          <div className="rounded-xl border border-border bg-muted/40 p-4" key={key}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">
                {row.source}/{row.name}
              </span>
              <Badge variant={row.api_key_set ? "outline" : "destructive"}>
                {row.api_key_set ? "API key set" : "API key missing"}
              </Badge>
              <Badge variant="outline">{row.enabled ? "enabled" : "disabled"}</Badge>
              <span className="ml-auto text-xs text-muted-foreground">Updated {fmtDate(row.updated_at)}</span>
            </div>
            <div className="mt-3 flex flex-col gap-3 sm:flex-row">
              <div className="grid w-full gap-1.5">
                <Label htmlFor={`integration-url-${key}`} className="text-xs text-muted-foreground">
                  Base URL
                </Label>
                <Input
                  id={`integration-url-${key}`}
                  value={draft.base_url}
                  onChange={(event) => setDraft(key, { base_url: event.target.value })}
                />
              </div>
              <div className="grid w-full gap-1.5">
                <Label htmlFor={`integration-key-${key}`} className="text-xs text-muted-foreground">
                  New API key (optional)
                </Label>
                <Input
                  id={`integration-key-${key}`}
                  type="password"
                  autoComplete="off"
                  value={draft.api_key}
                  onChange={(event) => setDraft(key, { api_key: event.target.value })}
                />
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-2">
                <Checkbox
                  id={`integration-enabled-${key}`}
                  checked={draft.enabled}
                  onCheckedChange={(checked) => setDraft(key, { enabled: checked === true })}
                />
                <Label htmlFor={`integration-enabled-${key}`} className="text-sm text-muted-foreground">
                  enabled
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id={`integration-webhook-${key}`}
                  checked={draft.webhook_enabled}
                  onCheckedChange={(checked) => setDraft(key, { webhook_enabled: checked === true })}
                />
                <Label htmlFor={`integration-webhook-${key}`} className="text-sm text-muted-foreground">
                  webhook enabled
                </Label>
              </div>
              <Button type="button" variant="secondary" size="sm" onClick={() => void saveIntegration(row.source, row.name)}>
                Save
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={integrationTests[key]?.status === "testing"}
                onClick={() => void testIntegration(row.source, row.name)}
              >
                {integrationTests[key]?.status === "testing" ? "Testing…" : "Test connection"}
              </Button>
              {integrationTests[key] && integrationTests[key].status !== "testing" ? (
                <span
                  className={`text-xs ${integrationTests[key].status === "ok" ? "text-ok" : "text-critical"}`}
                  title={integrationTests[key].detail}
                >
                  {integrationTests[key].status === "ok"
                    ? `✓ ${integrationTests[key].detail}`
                    : `✗ ${integrationTests[key].detail}`}
                </span>
              ) : null}
            </div>
          </div>
        );
      })}
    </SectionCard>
  );
}
