import { useState } from "react";
import type { AutomationPayload, AutomationValidateResponse, RuleAction, RuleParams } from "../../types";
import { api } from "../../api";
import { CronPreview } from "@/components/nebula/CronPreview";
import { GlassCard } from "@/components/nebula/GlassCard";
import { Button } from "@/components/ui/button";
import { CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type AutomationDraft = AutomationPayload & { id?: number };

const csv = (values: string[] | undefined): string => (values ?? []).join(", ");
const parseCsv = (raw: string): string[] =>
  raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

function actionOfType(actions: RuleAction[] | undefined, type: RuleAction["type"]): RuleAction | undefined {
  return (actions ?? []).find((action) => action.type === type);
}

export function AutomationEditor({
  draft,
  onChange,
  onSave,
  onCancel,
  saving,
}: {
  draft: AutomationDraft;
  onChange: (next: AutomationDraft) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
}): JSX.Element {
  const [cronValid, setCronValid] = useState(true);
  const [preview, setPreview] = useState<AutomationValidateResponse | null>(null);
  const params: RuleParams = draft.params ?? {};
  const scope = params.scope ?? {};
  const require = params.require ?? {};
  const options = params.options ?? {};
  const actions = params.actions ?? [];

  const patchParams = (patch: Partial<RuleParams>): void =>
    onChange({ ...draft, params: { ...params, ...patch } });
  const toggleAction = (type: RuleAction["type"], extra?: Partial<RuleAction>): void => {
    const existing = actionOfType(actions, type);
    const next = existing
      ? actions.filter((action) => action.type !== type)
      : [...actions, { type, when: "non_conforming" as const, ...extra }];
    patchParams({ actions: next });
  };
  const patchAction = (type: RuleAction["type"], patch: Partial<RuleAction>): void =>
    patchParams({
      actions: actions.map((action) => (action.type === type ? { ...action, ...patch } : action)),
    });

  const validate = async (): Promise<void> => {
    try {
      setPreview(await api.validateAutomation(draft));
    } catch {
      setPreview({ valid: false, error: "validation request failed" });
    }
  };

  const tagAction = actionOfType(actions, "tag");
  const monitorAction = actionOfType(actions, "set_monitored");

  return (
    <GlassCard>
      <CardHeader>
        <CardTitle>{draft.id ? `Edit: ${draft.name}` : "New automation"}</CardTitle>
        <CardDescription>
          Items in scope that fail every requirement get the selected actions, within budget
          and cooldown. Rules start in dry-run.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="automation-name" className="text-xs text-muted-foreground">Name</Label>
            <Input id="automation-name" value={draft.name}
              onChange={(e) => onChange({ ...draft, name: e.target.value })} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="automation-media" className="text-xs text-muted-foreground">Media</Label>
            <select
              id="automation-media"
              className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
              value={scope.media ?? "both"}
              onChange={(e) => {
                const media = e.target.value as "movies" | "series" | "both";
                // The "conforming" set_monitored action is movie-only (backend
                // rejects it otherwise); drop any stale one in the same patch so
                // switching away from movies can never leave a hidden, invalid
                // action behind.
                const nextActions =
                  media === "movies" ? actions : actions.filter((action) => action.when !== "conforming");
                patchParams({ scope: { ...scope, media }, actions: nextActions });
              }}
            >
              <option value="both">Movies + Series</option>
              <option value="movies">Movies only</option>
              <option value="series">Series only</option>
            </select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="automation-cron" className="text-xs text-muted-foreground">Cron</Label>
            <Input id="automation-cron" value={draft.cron}
              onChange={(e) => onChange({ ...draft, cron: e.target.value })} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="automation-tz" className="text-xs text-muted-foreground">Timezone (IANA)</Label>
            <Input id="automation-tz" value={draft.timezone ?? "UTC"}
              onChange={(e) => onChange({ ...draft, timezone: e.target.value })} />
          </div>
        </div>
        <CronPreview cron={draft.cron} timezone={draft.timezone} onValidityChange={setCronValid} />

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="automation-budget" className="text-xs text-muted-foreground">
              Search budget per run (1–100)
            </Label>
            <Input id="automation-budget" type="number" min={1} max={100} value={draft.budget_per_run ?? 10}
              onChange={(e) => onChange({ ...draft, budget_per_run: Number(e.target.value) || 10 })} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="automation-cooldown" className="text-xs text-muted-foreground">
              Per-item cooldown (days, 1–90)
            </Label>
            <Input id="automation-cooldown" type="number" min={1} max={90} value={draft.cooldown_days ?? 7}
              onChange={(e) => onChange({ ...draft, cooldown_days: Number(e.target.value) || 7 })} />
          </div>
        </div>

        <fieldset className="grid gap-2 rounded-lg border border-border p-3">
          <legend className="px-1 text-xs text-muted-foreground">Scope</legend>
          {(
            [
              ["anime-only", "Anime only", scope.anime_only ?? false,
                (checked: boolean) => patchParams({ scope: { ...scope, anime_only: checked } })],
              ["monitored-only", "Monitored only", scope.monitored_only ?? true,
                (checked: boolean) => patchParams({ scope: { ...scope, monitored_only: checked } })],
            ] as const
          ).map(([id, label, checked, set]) => (
            <div key={id} className="flex items-center gap-2">
              <Checkbox id={`automation-${id}`} checked={checked}
                onCheckedChange={(value) => set(value === true)} />
              <Label htmlFor={`automation-${id}`} className="text-sm">{label}</Label>
            </div>
          ))}
          <div className="grid gap-1.5">
            <Label htmlFor="automation-genres" className="text-xs text-muted-foreground">
              Genres (any of, comma-separated; empty = all)
            </Label>
            <Input id="automation-genres" value={csv(scope.genres_any)}
              onChange={(e) => patchParams({ scope: { ...scope, genres_any: parseCsv(e.target.value) } })} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="automation-tags" className="text-xs text-muted-foreground">
              Sonarr/Radarr tags (any of, comma-separated labels)
            </Label>
            <Input id="automation-tags" value={csv(scope.tags_any)}
              onChange={(e) => patchParams({ scope: { ...scope, tags_any: parseCsv(e.target.value) } })} />
          </div>
        </fieldset>

        <fieldset className="grid gap-2 rounded-lg border border-border p-3">
          <legend className="px-1 text-xs text-muted-foreground">Requirements (item conforms when ALL hold)</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="automation-langs" className="text-xs text-muted-foreground">
                Audio language any-of (e.g. english, eng)
              </Label>
              <Input id="automation-langs" value={csv(require.audio_language_any)}
                onChange={(e) =>
                  patchParams({ require: { ...require, audio_language_any: parseCsv(e.target.value) } })
                } />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="automation-res" className="text-xs text-muted-foreground">
                Minimum resolution (empty = any)
              </Label>
              <Input id="automation-res" type="number" min={240} max={4320}
                value={require.resolution_min ?? ""}
                onChange={(e) =>
                  patchParams({
                    require: {
                      ...require,
                      resolution_min: e.target.value === "" ? null : Number(e.target.value),
                    },
                  })
                } />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="automation-codecs" className="text-xs text-muted-foreground">
                Video codec any-of (e.g. x265, hevc)
              </Label>
              <Input id="automation-codecs" value={csv(require.video_codec_any)}
                onChange={(e) =>
                  patchParams({ require: { ...require, video_codec_any: parseCsv(e.target.value) } })
                } />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="automation-quality" className="text-xs text-muted-foreground">
                Quality name any-of (e.g. WEBDL-1080p)
              </Label>
              <Input id="automation-quality" value={csv(require.quality_any)}
                onChange={(e) =>
                  patchParams({ require: { ...require, quality_any: parseCsv(e.target.value) } })
                } />
            </div>
          </div>
        </fieldset>

        <fieldset className="grid gap-2 rounded-lg border border-border p-3">
          <legend className="px-1 text-xs text-muted-foreground">Actions on non-conforming items</legend>
          <div className="flex items-center gap-2">
            <Checkbox id="automation-search-missing" checked={Boolean(actionOfType(actions, "search_missing"))}
              onCheckedChange={() => toggleAction("search_missing")} />
            <Label htmlFor="automation-search-missing" className="text-sm">Search items with no file</Label>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox id="automation-search-upgrade" checked={Boolean(actionOfType(actions, "search_upgrade"))}
              onCheckedChange={() => toggleAction("search_upgrade")} />
            <Label htmlFor="automation-search-upgrade" className="text-sm">
              Search upgrades for files failing the requirements
            </Label>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Checkbox id="automation-tag" checked={Boolean(tagAction)}
              onCheckedChange={() => toggleAction("tag", { label: "needs-upgrade" })} />
            <Label htmlFor="automation-tag" className="text-sm">Apply tag</Label>
            {tagAction ? (
              <Input className="h-8 w-48" value={tagAction.label ?? ""}
                onChange={(e) => patchAction("tag", { label: e.target.value })} />
            ) : null}
          </div>
          {(scope.media ?? "both") === "movies" ? (
            <div className="flex items-center gap-2">
              <Checkbox id="automation-unmonitor" checked={Boolean(monitorAction)}
                onCheckedChange={() => toggleAction("set_monitored", { value: false, when: "conforming" })} />
              <Label htmlFor="automation-unmonitor" className="text-sm">
                Unmonitor movies once they conform (stop caring when acquired)
              </Label>
            </div>
          ) : null}
          <div className="flex items-center gap-2">
            <Checkbox id="automation-dub-gate" checked={options.mal_dub_gate ?? false}
              onCheckedChange={(value) =>
                patchParams({ options: { ...options, mal_dub_gate: value === true } })
              } />
            <Label htmlFor="automation-dub-gate" className="text-sm">
              Skip items MAL dub lists say have no dub (saves indexer quota)
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox id="automation-new-dub" checked={options.new_dub_only ?? false}
              onCheckedChange={(value) =>
                patchParams({ options: { ...options, new_dub_only: value === true, mal_dub_gate: true } })
              } />
            <Label htmlFor="automation-new-dub" className="text-sm">
              Only act when a dub newly appears (new-dub watcher)
            </Label>
          </div>
        </fieldset>

        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <Checkbox id="automation-enabled" checked={draft.enabled ?? false}
              onCheckedChange={(value) => onChange({ ...draft, enabled: value === true })} />
            <Label htmlFor="automation-enabled" className="text-sm">Enabled (scheduled)</Label>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox id="automation-dry-run" checked={draft.dry_run ?? true}
              onCheckedChange={(value) => onChange({ ...draft, dry_run: value === true })} />
            <Label htmlFor="automation-dry-run" className="text-sm">Dry-run (simulate only)</Label>
          </div>
          <Button type="button" size="sm" variant="secondary" onClick={() => void validate()}>
            Validate & preview
          </Button>
          <Button type="button" size="sm" disabled={!cronValid || saving} onClick={onSave}>
            {draft.id ? "Save changes" : "Create automation"}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
        {preview ? (
          <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
            {preview.valid ? (
              <>
                <p>Rule is valid.</p>
                {preview.match_preview ? (
                  <p>
                    Would match now:{" "}
                    {Object.entries(preview.match_preview)
                      .map(([instance, count]) => `${instance}: ${count}`)
                      .join(", ") || "0 items"}
                  </p>
                ) : (
                  <p>{preview.preview_note ?? "No preview available."}</p>
                )}
              </>
            ) : (
              <p role="alert">Invalid rule: {preview.error}</p>
            )}
          </div>
        ) : null}
      </CardContent>
    </GlassCard>
  );
}
