import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { api } from "../api";
import { usePageTitle } from "../hooks/usePageTitle";
import { useActionError } from "../hooks/useActionError";
import { queryKeys } from "../lib/queryKeys";
import { QueryErrorNotice } from "@/components/nebula/QueryErrorNotice";
import { useConfirmDialog } from "@/components/nebula/ConfirmDialog";
import { GlassCard } from "@/components/nebula/GlassCard";
import { Button } from "@/components/ui/button";
import { CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import type { AutomationRow, AutomationTemplate } from "../types";
import { AutomationEditor, type AutomationDraft } from "./automations/AutomationEditor";
import { AutomationList } from "./automations/AutomationList";
import { AutomationRunHistory } from "./automations/AutomationRunHistory";
import { TemplatePicker } from "./automations/TemplatePicker";

/**
 * The sheet is the one place where a single automation is worked on, so the
 * list underneath never reflows and the page never jumps. Previously the
 * editor mounted inline between the list and the template gallery: to create
 * anything you scrolled to the bottom of the page, and the editor then
 * appeared above where you were looking.
 */
type SheetState =
  | { kind: "template" }
  | { kind: "editor"; draft: AutomationDraft }
  | { kind: "history"; row: AutomationRow };

export function AutomationsPage(): JSX.Element {
  usePageTitle("Automations");
  const queryClient = useQueryClient();
  const { runAction } = useActionError();
  const { requestConfirm, confirmDialog } = useConfirmDialog();
  const automations = useQuery({ queryKey: queryKeys.automations, queryFn: api.automations });
  const templates = useQuery({ queryKey: queryKeys.automationTemplates, queryFn: api.automationTemplates });
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [saving, setSaving] = useState(false);
  const [valid, setValid] = useState(true);

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.automations });
  };

  const useTemplate = (template: AutomationTemplate): void => {
    const existingNames = new Set((automations.data?.automations ?? []).map((row) => row.name));
    const seededName = template.key === "custom" || existingNames.has(template.title) ? "" : template.title;
    setSheet({
      kind: "editor",
      draft: {
        name: seededName,
        template_key: template.key,
        params: template.default_params,
        cron: template.default_cron,
        timezone: "UTC",
        enabled: false,
        dry_run: true,
        budget_per_run: 10,
        cooldown_days: 7,
      },
    });
  };

  const editRow = (row: AutomationRow): void =>
    setSheet({
      kind: "editor",
      draft: {
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
      },
    });

  const saveDraft = async (draft: AutomationDraft): Promise<void> => {
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
    if (ok) setSheet(null);
  };

  const runNow = (row: AutomationRow): void => {
    void runAction(() => api.runAutomation(row.id), `run automation ${row.name}`, {
      successMessage: `${row.name} started${row.dry_run ? " (dry-run)" : ""}`,
      invalidate: [[...queryKeys.automations]],
    });
  };

  const deleteRow = (row: AutomationRow): void =>
    requestConfirm({
      title: `Delete “${row.name}”?`,
      description: "The rule and its run history are removed. This cannot be undone.",
      confirmLabel: "Delete",
      destructive: true,
      onConfirm: () =>
        void runAction(
          async () => {
            await api.deleteAutomation(row.id);
            await invalidate();
          },
          `delete automation ${row.name}`,
          { successMessage: "Automation deleted" },
        ),
    });

  const applyToggle = (row: AutomationRow, patch: { enabled?: boolean; dry_run?: boolean }): void => {
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

  const toggleRow = (row: AutomationRow, patch: { enabled?: boolean; dry_run?: boolean }): void => {
    // Leaving dry-run is the only control here that turns a simulation into
    // real searches against the user's indexers, so it asks first. Every other
    // toggle is trivially reversible and stays a single click.
    if (patch.dry_run === false) {
      requestConfirm({
        title: `Take “${row.name}” live?`,
        description:
          "It will stop simulating and start sending real searches and metadata changes to Sonarr/Radarr on its schedule.",
        confirmLabel: "Go live",
        onConfirm: () => applyToggle(row, patch),
      });
      return;
    }
    applyToggle(row, patch);
  };

  return (
    <div className="space-y-6">
      <GlassCard>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>Automations</CardTitle>
            <CardDescription>
              Each automation runs on its own schedule, capped by its per-run budget, the global
              daily search cap, and a per-item cooldown.
            </CardDescription>
          </div>
          <Button type="button" size="sm" onClick={() => setSheet({ kind: "template" })}>
            <Plus className="size-3.5" aria-hidden />
            New automation
          </Button>
        </CardHeader>
        <CardContent>
          {automations.isError ? (
            <QueryErrorNotice
              label="automations"
              retry={() => void automations.refetch()}
              error={automations.error}
            />
          ) : null}
          {automations.isLoading ? <Skeleton className="h-32 w-full" /> : null}
          {automations.data ? (
            <AutomationList
              automations={automations.data.automations}
              onEdit={editRow}
              onRun={runNow}
              onDelete={deleteRow}
              onToggle={toggleRow}
              onHistory={(row) => setSheet({ kind: "history", row })}
              onCreate={() => setSheet({ kind: "template" })}
            />
          ) : null}
        </CardContent>
      </GlassCard>

      <Sheet
        open={sheet !== null}
        onOpenChange={(open) => {
          if (!open) setSheet(null);
        }}
      >
        <SheetContent
          side="right"
          aria-label="Automation"
          className="flex w-full flex-col gap-0 border-border glass-panel-strong p-4 data-[side=right]:sm:max-w-xl"
        >
          <SheetTitle className="mb-3 pr-8 text-sm">
            {sheet?.kind === "template"
              ? "New automation"
              : sheet?.kind === "history"
                ? `Run history — ${sheet.row.name}`
                : sheet?.draft.id
                  ? `Edit ${sheet.draft.name || "automation"}`
                  : "New automation"}
          </SheetTitle>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {sheet?.kind === "template" && templates.data ? (
              <TemplatePicker templates={templates.data.templates} onUse={useTemplate} />
            ) : null}
            {sheet?.kind === "template" && templates.isLoading ? (
              <Skeleton className="h-64 w-full" />
            ) : null}
            {sheet?.kind === "template" && templates.isError ? (
              <QueryErrorNotice
                label="templates"
                retry={() => void templates.refetch()}
                error={templates.error}
              />
            ) : null}
            {sheet?.kind === "history" ? <AutomationRunHistory automation={sheet.row} /> : null}
            {sheet?.kind === "editor" ? (
              <AutomationEditor
                draft={sheet.draft}
                onChange={(draft) => setSheet({ kind: "editor", draft })}
                onValidityChange={setValid}
              />
            ) : null}
          </div>

          {sheet?.kind === "editor" ? (
            <div className="mt-3 flex items-center justify-end gap-2 border-t border-border pt-3">
              <Button type="button" size="sm" variant="ghost" onClick={() => setSheet(null)}>
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={!valid || saving}
                onClick={() => void saveDraft(sheet.draft)}
              >
                {sheet.draft.id ? "Save changes" : "Create automation"}
              </Button>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>

      {confirmDialog}
    </div>
  );
}
