import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { usePageTitle } from "../hooks/usePageTitle";
import { useActionError } from "../hooks/useActionError";
import { queryKeys } from "../lib/queryKeys";
import { QueryErrorNotice } from "@/components/nebula/QueryErrorNotice";
import { Skeleton } from "@/components/ui/skeleton";
import type { AutomationRow, AutomationTemplate } from "../types";
import { AutomationEditor, type AutomationDraft } from "./automations/AutomationEditor";
import { AutomationList } from "./automations/AutomationList";
import { AutomationRunHistory } from "./automations/AutomationRunHistory";
import { TemplateGallery } from "./automations/TemplateGallery";

export function AutomationsPage(): JSX.Element {
  usePageTitle("Automations");
  const queryClient = useQueryClient();
  const { runAction } = useActionError();
  const automations = useQuery({ queryKey: queryKeys.automations, queryFn: api.automations });
  const templates = useQuery({ queryKey: queryKeys.automationTemplates, queryFn: api.automationTemplates });
  const [draft, setDraft] = useState<AutomationDraft | null>(null);
  const [historyRow, setHistoryRow] = useState<AutomationRow | null>(null);
  const [saving, setSaving] = useState(false);

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.automations });
  };

  const useTemplate = (template: AutomationTemplate): void =>
    setDraft({
      name: template.key === "custom" ? "" : template.title,
      template_key: template.key,
      params: template.default_params,
      cron: template.default_cron,
      timezone: "UTC",
      enabled: false,
      dry_run: true,
      budget_per_run: 10,
      cooldown_days: 7,
    });

  const editRow = (row: AutomationRow): void =>
    setDraft({
      id: row.id,
      name: row.name,
      template_key: row.template_key,
      params: row.params,
      cron: row.cron,
      timezone: row.timezone,
      enabled: row.enabled,
      dry_run: row.dry_run,
      budget_per_run: row.budget_per_run,
      cooldown_days: row.cooldown_days,
    });

  const saveDraft = async (): Promise<void> => {
    if (!draft) return;
    setSaving(true);
    const ok = await runAction(
      async () => {
        if (draft.id) {
          await api.saveAutomation(draft.id, draft);
        } else {
          await api.createAutomation(draft);
        }
        await invalidate();
      },
      draft.id ? `save automation ${draft.name}` : "create automation",
      { successMessage: draft.id ? "Automation saved" : "Automation created (dry-run)" },
    );
    setSaving(false);
    if (ok) setDraft(null);
  };

  const runNow = (row: AutomationRow): void => {
    void runAction(() => api.runAutomation(row.id), `run automation ${row.name}`, {
      successMessage: `${row.name} started${row.dry_run ? " (dry-run)" : ""}`,
      invalidate: [[...queryKeys.automations]],
    });
  };

  const deleteRow = (row: AutomationRow): void => {
    void runAction(
      async () => {
        await api.deleteAutomation(row.id);
        await invalidate();
      },
      `delete automation ${row.name}`,
      { successMessage: "Automation deleted" },
    );
  };

  const toggleRow = (row: AutomationRow, patch: { enabled?: boolean; dry_run?: boolean }): void => {
    void runAction(
      async () => {
        await api.saveAutomation(row.id, {
          name: row.name,
          template_key: row.template_key,
          params: row.params,
          cron: row.cron,
          timezone: row.timezone,
          enabled: patch.enabled ?? row.enabled,
          dry_run: patch.dry_run ?? row.dry_run,
          budget_per_run: row.budget_per_run,
          cooldown_days: row.cooldown_days,
        });
        await invalidate();
      },
      `toggle automation ${row.name}`,
    );
  };

  return (
    <div className="space-y-6">
      {automations.isError ? (
        <QueryErrorNotice label="automations" retry={() => void automations.refetch()} error={automations.error} />
      ) : null}
      {automations.isLoading ? <Skeleton className="h-32 w-full" /> : null}
      {automations.data ? (
        <AutomationList
          automations={automations.data.automations}
          onEdit={editRow}
          onRun={runNow}
          onDelete={deleteRow}
          onToggle={toggleRow}
          onHistory={setHistoryRow}
        />
      ) : null}
      {historyRow ? (
        <AutomationRunHistory automation={historyRow} onClose={() => setHistoryRow(null)} />
      ) : null}
      {draft ? (
        <AutomationEditor
          draft={draft}
          onChange={setDraft}
          onSave={() => void saveDraft()}
          onCancel={() => setDraft(null)}
          saving={saving}
        />
      ) : null}
      {templates.data ? <TemplateGallery templates={templates.data.templates} onUse={useTemplate} /> : null}
    </div>
  );
}
