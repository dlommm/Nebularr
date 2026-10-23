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
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { SectionCard } from "./shared";
import { cn } from "@/lib/utils";

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
  const [editing, setEditing] = useState<string | null>(null);

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
    <SectionCard
      title="Sonarr and Radarr"
      description="Connections used for library sync and tagging. Test one any time; a sync also checks it before it starts."
    >
      {integrations.isLoading ? <Skeleton className="h-32 w-full" /> : null}
      {integrations.isError ? (
        <QueryErrorNotice label="integrations" retry={() => void integrations.refetch()} error={integrations.error} />
      ) : null}
      <ul className="border-b border-border">
        {(integrations.data ?? []).map((row) => {
          const key = `${row.source}:${row.name}`;
          const draft = drafts[key] ?? { ...row, api_key: "" };
          const test = integrationTests[key];
          const open = editing === key;
          return (
            <li key={key} className="border-t border-border">
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-2 py-4 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1.4fr)_minmax(0,1fr)_auto]">
                <div className="min-w-0">
                  <div className="truncate text-base">{row.name}</div>
                  <div className="text-[13px] text-subtle-foreground">
                    {row.source === "radarr" ? "Radarr · movies" : "Sonarr · TV"}
                    {row.enabled ? "" : " · disabled"}
                  </div>
                </div>
                <div className="hidden min-w-0 truncate font-mono text-xs text-muted-foreground md:block" title={row.base_url}>
                  {row.base_url || "no URL"}
                </div>
                <div className="hidden min-w-0 md:block">
                  {test && test.status !== "testing" ? (
                    <span className={cn("text-[13px]", test.status === "ok" ? "text-ok" : "text-critical")} title={test.detail}>
                      {test.status === "ok" ? test.detail : `failed · ${test.detail}`}
                    </span>
                  ) : (
                    <span className={cn("text-[13px]", row.api_key_set ? "text-muted-foreground" : "text-critical")}>
                      {row.api_key_set ? "API key set" : "API key missing"}
                    </span>
                  )}
                  <div className="text-xs text-subtle-foreground">updated {fmtDate(row.updated_at)}</div>
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    disabled={test?.status === "testing"}
                    onClick={() => void testIntegration(row.source, row.name)}
                  >
                    {test?.status === "testing" ? "Testing…" : "Test connection"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    aria-expanded={open}
                    aria-controls={`integration-edit-${key}`}
                    onClick={() => setEditing(open ? null : key)}
                  >
                    {open ? "Close" : "Edit"}
                  </Button>
                </div>
                {test && test.status !== "testing" ? (
                  <p className={cn("col-span-full text-[13px] md:hidden", test.status === "ok" ? "text-ok" : "text-critical")}>
                    {test.status === "ok" ? test.detail : `failed · ${test.detail}`}
                  </p>
                ) : null}
              </div>
              {open ? (
                <div id={`integration-edit-${key}`} className="animate-rise pb-5">
                  <div className="flex flex-col gap-3 sm:flex-row">
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
                  <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
                    <div className="flex min-h-11 items-center gap-2">
                      <Checkbox
                        id={`integration-enabled-${key}`}
                        checked={draft.enabled}
                        onCheckedChange={(checked) => setDraft(key, { enabled: checked === true })}
                      />
                      <Label htmlFor={`integration-enabled-${key}`} className="text-sm font-normal text-muted-foreground">
                        enabled
                      </Label>
                    </div>
                    <div className="flex min-h-11 items-center gap-2">
                      <Checkbox
                        id={`integration-webhook-${key}`}
                        checked={draft.webhook_enabled}
                        onCheckedChange={(checked) => setDraft(key, { webhook_enabled: checked === true })}
                      />
                      <Label htmlFor={`integration-webhook-${key}`} className="text-sm font-normal text-muted-foreground">
                        webhook enabled
                      </Label>
                    </div>
                    <Button type="button" className="min-h-11" onClick={() => void saveIntegration(row.source, row.name)}>
                      Save
                    </Button>
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </SectionCard>
  );
}
