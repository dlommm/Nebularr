import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { api } from "../api";
import { usePageTitle } from "../hooks/usePageTitle";
import { useActionError } from "../hooks/useActionError";
import { queryKeys } from "../lib/queryKeys";
import { QueryErrorNotice } from "@/components/nebula/QueryErrorNotice";
import { useConfirmDialog } from "@/components/nebula/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { AutomationRow, AutomationTemplate } from "../types";
import { AutomationEditor, type AutomationDraft } from "./automations/AutomationEditor";
import { AutomationList, ModeTag } from "./automations/AutomationList";
import { AutomationRunHistory } from "./automations/AutomationRunHistory";
import { TemplatePicker } from "./automations/TemplatePicker";
import { PageHead } from "@/components/ns/Page";

/**
 * The panel beside the list is the one place where a single rule is worked
 * on, so the list never reflows and the page never jumps. (An earlier layout
 * mounted the editor inline between the list and the template gallery, so it
 * appeared above wherever you were looking.)
 */
type SheetState =
  | { kind: "template" }
  | { kind: "editor"; draft: AutomationDraft }
  | { kind: "history"; row: AutomationRow };

export function AutomationsPage(): JSX.Element {
  usePageTitle("Rules");
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

  // Validity belongs to the rule being edited, not to the page — without this
  // reset a rule left invalid would disable Save on the *next* rule opened,
  // until its own validation round-trip came back.
  const openEditor = (draft: AutomationDraft): void => {
    setValid(true);
    setSheet({ kind: "editor", draft });
  };

  const useTemplate = (template: AutomationTemplate): void => {
    const existingNames = new Set((automations.data?.automations ?? []).map((row) => row.name));
    const seededName = template.key === "custom" || existingNames.has(template.title) ? "" : template.title;
    openEditor({
      name: seededName,
      template_key: template.key,
      params: template.default_params,
      cron: template.default_cron,
      timezone: "UTC",
      enabled: false,
      dry_run: true,
      budget_per_run: 10,
      cooldown_days: 7,
    });
  };

  const editRow = (row: AutomationRow): void =>
    openEditor({
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

  const rows = automations.data?.automations ?? [];
  const selectedId = sheet?.kind === "history" ? sheet.row.id : sheet?.kind === "editor" ? sheet.draft.id : undefined;
  const selectedRow = selectedId != null ? rows.find((row) => row.id === selectedId) : undefined;
  const liveCount = rows.filter((row) => row.enabled && !row.dry_run).length;

  return (
    <div className="pb-16">
      <PageHead
        title="Rules"
        lead="Rules search, tag or retire. New rules start as dry runs and change nothing until you go live."
        aside={
          <Button type="button" className="min-h-11" onClick={() => setSheet({ kind: "template" })}>
            <Plus className="size-4" aria-hidden />
            New rule
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-12 pt-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
        <nav aria-label="Rules" className="min-w-0">
          {automations.isError ? (
            <QueryErrorNotice label="automations" retry={() => void automations.refetch()} error={automations.error} />
          ) : null}
          {automations.isLoading ? <Skeleton className="h-32 w-full" /> : null}
          {automations.data ? (
            <AutomationList
              automations={rows}
              selectedId={selectedId}
              onEdit={editRow}
              onRun={runNow}
              onDelete={deleteRow}
              onToggle={toggleRow}
              onHistory={(row) => setSheet({ kind: "history", row })}
              onCreate={() => setSheet({ kind: "template" })}
            />
          ) : null}
          {rows.length > 0 ? (
            <p className="mt-4 text-[13px] leading-relaxed text-muted-foreground">
              {rows.length} rule{rows.length === 1 ? "" : "s"}, {liveCount} live. Each runs on its own schedule, capped by its per-run
              budget, the global daily search cap, and a per-item cooldown.
            </p>
          ) : null}
        </nav>

        <section
          aria-labelledby="rule-panel-title"
          // Keyed so each rule opened gets the entrance again rather than a
          // silent content swap.
          key={sheet?.kind === "template" ? "template" : (selectedId ?? "new")}
          className="panel min-w-0 animate-rise self-start px-4 py-6 sm:px-8 sm:py-7"
        >
          {sheet === null ? (
            <div className="py-6">
              <h2 id="rule-panel-title" className="cond text-[44px] leading-[0.9] font-[760]">
                Pick a rule
              </h2>
              <p className="mt-3 max-w-md text-[15px] text-muted-foreground">
                Choose a rule on the left to edit it and see what it would change, or start a new one from a template.
              </p>
              <Button type="button" variant="outline" className="mt-6 min-h-11" onClick={() => setSheet({ kind: "template" })}>
                Start from a template
              </Button>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <h2 id="rule-panel-title" className="cond min-w-0 text-[44px] leading-[0.9] font-[760] break-words">
                  {sheet.kind === "template"
                    ? "New rule"
                    : sheet.kind === "history"
                      ? sheet.row.name
                      : sheet.draft.name || "Untitled rule"}
                </h2>
                {selectedRow ? <ModeTag row={selectedRow} /> : null}
              </div>

              <div className="mt-6">
                {sheet.kind === "template" && templates.data ? (
                  <TemplatePicker templates={templates.data.templates} onUse={useTemplate} />
                ) : null}
                {sheet.kind === "template" && templates.isLoading ? <Skeleton className="h-64 w-full" /> : null}
                {sheet.kind === "template" && templates.isError ? (
                  <QueryErrorNotice label="templates" retry={() => void templates.refetch()} error={templates.error} />
                ) : null}
                {sheet.kind === "history" ? (
                  <>
                    <h3 className="cond mb-2 text-[22px] leading-none font-bold">Run history</h3>
                    <AutomationRunHistory automation={sheet.row} />
                  </>
                ) : null}
                {sheet.kind === "editor" ? (
                  <AutomationEditor
                    draft={sheet.draft}
                    onChange={(draft) => setSheet({ kind: "editor", draft })}
                    onValidityChange={setValid}
                  />
                ) : null}
              </div>

              {sheet.kind === "editor" ? (
                <div className="mt-6 flex flex-wrap items-center gap-2.5 border-t border-border pt-5">
                  <Button type="button" className="min-h-11" disabled={!valid || saving} onClick={() => void saveDraft(sheet.draft)}>
                    {sheet.draft.id ? "Save changes" : "Create rule"}
                  </Button>
                  {selectedRow ? (
                    <>
                      <Button type="button" variant="outline" className="min-h-11" onClick={() => runNow(selectedRow)}>
                        {selectedRow.dry_run ? "Dry run now" : "Run now"}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-11"
                        onClick={() => setSheet({ kind: "history", row: selectedRow })}
                      >
                        Run history
                      </Button>
                    </>
                  ) : null}
                  <Button type="button" variant="ghost" className="min-h-11" onClick={() => setSheet(null)}>
                    Cancel
                  </Button>
                  {selectedRow ? (
                    <Button type="button" variant="destructive" className="ml-auto min-h-11" onClick={() => deleteRow(selectedRow)}>
                      Delete rule
                    </Button>
                  ) : null}
                </div>
              ) : sheet.kind === "history" ? (
                <div className="mt-6 flex flex-wrap gap-2.5 border-t border-border pt-5">
                  <Button type="button" variant="outline" className="min-h-11" onClick={() => editRow(sheet.row)}>
                    Edit rule
                  </Button>
                  <Button type="button" variant="ghost" className="min-h-11" onClick={() => setSheet(null)}>
                    Close
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </section>
      </div>

      {confirmDialog}
    </div>
  );
}
