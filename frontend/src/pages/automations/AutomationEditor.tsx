import { useEffect, useState } from "react";
import { AlertCircle, Loader2, Target } from "lucide-react";
import type {
  AutomationPayload,
  AutomationRootFolder,
  AutomationValidateResponse,
  RuleAction,
  RuleParams,
} from "../../types";
import { api } from "../../api";
import { useDebouncedValue } from "../../hooks";
import { CronPreview } from "@/components/nebula/CronPreview";
import { MultiSelectFilter } from "@/components/nebula/MultiSelectFilter";
import { TokenField } from "@/components/nebula/TokenField";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { describeLimits, summarizeAutomation } from "./automationSummary";

export type AutomationDraft = AutomationPayload & { id?: number };

/** Schedules that cover almost every rule, so most users never type crontab. */
const CRON_PRESETS: { label: string; cron: string }[] = [
  { label: "Every day at 06:00", cron: "0 6 * * *" },
  { label: "Every 2 days at 06:00", cron: "0 6 */2 * *" },
  { label: "Every Saturday at 05:00", cron: "0 5 * * 6" },
  { label: "Every Monday at 05:00", cron: "0 5 * * 1" },
  { label: "Every hour", cron: "0 * * * *" },
];

const SELECT_CLASS = "h-9 rounded-md border border-input bg-background px-2 text-sm";

/** The unit the server counted in, singularised for a count of one. A completeness
 *  rule counts shows, not episodes, so the number needs its noun to be read right. */
function previewUnit(preview: AutomationValidateResponse | null, count: number): string {
  const unit = preview?.preview_unit ?? "items";
  if (count === 1) return unit === "series" ? "series" : unit.replace(/s$/, "");
  return unit;
}

function actionOfType(actions: RuleAction[] | undefined, type: RuleAction["type"]): RuleAction | undefined {
  return (actions ?? []).find((action) => action.type === type);
}

/** A titled, collapsible group. Native <details> keeps this keyboard- and
 *  screen-reader-friendly without pulling in another primitive. */
function Section({
  title,
  summary,
  defaultOpen = true,
  children,
}: {
  title: string;
  summary: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <details open={defaultOpen} className="group rounded-lg border border-border bg-muted/30">
      <summary className="cursor-pointer list-none px-3 py-2 [&::-webkit-details-marker]:hidden">
        <span className="flex items-baseline justify-between gap-2">
          <span className="text-sm font-medium">{title}</span>
          <span className="truncate text-xs text-muted-foreground">{summary}</span>
        </span>
      </summary>
      <div className="grid gap-3 border-t border-border p-3">{children}</div>
    </details>
  );
}

export function AutomationEditor({
  draft,
  onChange,
  onValidityChange,
}: {
  draft: AutomationDraft;
  onChange: (next: AutomationDraft) => void;
  onValidityChange?: (valid: boolean) => void;
}): JSX.Element {
  const [rootFolders, setRootFolders] = useState<AutomationRootFolder[] | null>(null);
  const [preview, setPreview] = useState<AutomationValidateResponse | null>(null);
  const [checking, setChecking] = useState(false);

  const params: RuleParams = draft.params ?? {};
  const scope = params.scope ?? {};
  const require = params.require ?? {};
  const options = params.options ?? {};
  const actions = params.actions ?? [];
  const media = scope.media ?? "both";

  const patchParams = (patch: Partial<RuleParams>): void =>
    onChange({ ...draft, params: { ...params, ...patch } });
  const patchScope = (patch: Partial<NonNullable<RuleParams["scope"]>>): void =>
    patchParams({ scope: { ...scope, ...patch } });
  const patchRequire = (patch: Partial<NonNullable<RuleParams["require"]>>): void =>
    patchParams({ require: { ...require, ...patch } });
  const toggleAction = (type: RuleAction["type"], extra?: Partial<RuleAction>): void => {
    const existing = actionOfType(actions, type);
    patchParams({
      actions: existing
        ? actions.filter((action) => action.type !== type)
        : [...actions, { type, when: "non_conforming" as const, ...extra }],
    });
  };
  /** Patches only the FIRST action of this type — which is the one the editor's
   *  single control is bound to. Patching every match would rewrite a sibling the
   *  UI cannot show: a rule may carry a conforming and a non-conforming tag at
   *  once (valid, and useful — "tag the finished shows, tag what needs fixing"),
   *  and editing the label would otherwise collapse both onto one label. */
  const patchAction = (type: RuleAction["type"], patch: Partial<RuleAction>): void => {
    const target = actions.findIndex((action) => action.type === type);
    if (target === -1) return;
    patchParams({
      actions: actions.map((action, index) =>
        index === target ? { ...action, ...patch } : action,
      ),
    });
  };

  useEffect(() => {
    let cancelled = false;
    api
      .automationRootFolders()
      .then((res) => {
        if (!cancelled) setRootFolders(res.root_folders);
      })
      .catch(() => {
        if (!cancelled) setRootFolders([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Live validation replaces the old "Validate & preview" button: the rule is
  // checked as you edit, so an invalid rule or an empty match set is visible
  // before you commit rather than after.
  const debounced = useDebouncedValue(JSON.stringify(draft), 500);
  useEffect(() => {
    let cancelled = false;
    setChecking(true);
    api
      .validateAutomation(JSON.parse(debounced) as AutomationDraft)
      .then((response) => {
        if (cancelled) return;
        setPreview(response);
        onValidityChange?.(response.valid);
      })
      .catch(() => {
        if (cancelled) return;
        // A transport failure must not block saving — the server revalidates.
        setPreview(null);
        onValidityChange?.(true);
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const selectedFolders = scope.root_folders_any ?? [];
  // Union of discovered and already-selected so a folder the library no longer
  // reports stays visible (and removable) instead of vanishing from the picker.
  const folderOptions = Array.from(
    new Set([
      ...(rootFolders ?? [])
        .filter((folder) => media === "both" || folder.media === media)
        .map((folder) => folder.path),
      ...selectedFolders,
    ]),
  );

  const tagAction = actionOfType(actions, "tag");
  const monitorAction = actionOfType(actions, "set_monitored");
  const matched = preview?.match_preview
    ? Object.values(preview.match_preview).reduce((sum, count) => sum + count, 0)
    : null;
  const limits = describeLimits(draft);

  return (
    <div className="grid gap-4">
      <div className="grid gap-1.5">
        <Label htmlFor="automation-name" className="text-xs text-muted-foreground">
          Name
        </Label>
        <Input
          id="automation-name"
          value={draft.name}
          placeholder="e.g. Anime dub hunt"
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
        />
      </div>

      {/* The rule as a sentence, so the model ("things that fail the
          requirements get the actions") never has to be reassembled from the
          controls below. */}
      <div className="rounded-lg border border-border bg-muted/40 p-3">
        <p className="text-sm leading-relaxed">{summarizeAutomation(draft)}</p>
        {limits ? <p className="mt-1 text-xs text-muted-foreground">{limits}</p> : null}
        <p className="mt-2 flex items-center gap-1.5 text-xs" aria-live="polite">
          {checking ? (
            <>
              <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden />
              <span className="text-muted-foreground">Checking…</span>
            </>
          ) : preview && !preview.valid ? (
            <>
              <AlertCircle className="size-3.5 shrink-0 text-critical" aria-hidden />
              <span className="text-critical">{preview.error}</span>
            </>
          ) : matched !== null ? (
            <>
              <Target className="size-3.5 shrink-0 text-ok" aria-hidden />
              <span className="text-muted-foreground">
                Would act on {matched} {previewUnit(preview, matched)} right now
                {preview?.preview_sense === "conforming"
                  ? " — the ones already fully in spec."
                  : " — the ones that fall short."}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">
              {preview?.preview_note ?? "Rule is valid."}
            </span>
          )}
        </p>
      </div>

      <Section title="What & where" summary={media === "both" ? "movies + series" : media}>
        <div className="grid gap-1.5">
          <Label htmlFor="automation-media" className="text-xs text-muted-foreground">
            Media
          </Label>
          <select
            id="automation-media"
            className={SELECT_CLASS}
            value={media}
            onChange={(e) => {
              const next = e.target.value as "movies" | "series" | "both";
              // Conforming actions now work for series too (a whole-show
              // completeness check), so nothing is stripped here any more. The
              // remaining asymmetry runs the other way: series status is a
              // series-only filter the backend rejects for movies, so drop it in
              // the same patch rather than stranding a rule that cannot save.
              patchParams({
                scope:
                  next === "movies"
                    ? { ...scope, media: next, series_status_any: [] }
                    : { ...scope, media: next },
              });
            }}
          >
            <option value="both">Movies + Series</option>
            <option value="movies">Movies only</option>
            <option value="series">Series only</option>
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          {(
            [
              ["anime-only", "Anime only", scope.anime_only ?? false,
                (checked: boolean) => patchScope({ anime_only: checked })],
              ["monitored-only", "Monitored only", scope.monitored_only ?? true,
                (checked: boolean) => patchScope({ monitored_only: checked })],
            ] as const
          ).map(([id, label, checked, set]) => (
            <div key={id} className="flex items-center gap-2">
              <Checkbox id={`automation-${id}`} checked={checked} onCheckedChange={(v) => set(v === true)} />
              <Label htmlFor={`automation-${id}`} className="text-sm font-normal">{label}</Label>
            </div>
          ))}
        </div>
        {media !== "movies" ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Label className="text-xs text-muted-foreground">Series status</Label>
              <MultiSelectFilter
                label="series status"
                options={["ended", "continuing", "upcoming"]}
                selected={scope.series_status_any ?? []}
                onChange={(next) =>
                  patchScope({
                    series_status_any: next as NonNullable<
                      NonNullable<RuleParams["scope"]>["series_status_any"]
                    >,
                  })
                }
              />
              <span className="text-xs text-muted-foreground">
                {(scope.series_status_any ?? []).length === 0
                  ? "any status"
                  : "only these"}
              </span>
            </div>
            <div className="grid gap-2">
              <div className="flex items-start gap-2">
                <Checkbox
                  id="automation-no-specials"
                  checked={!(scope.include_specials ?? true)}
                  onCheckedChange={(v) => patchScope({ include_specials: v !== true })}
                />
                <Label htmlFor="automation-no-specials" className="text-sm font-normal">
                  Ignore specials (season 0)
                  <span className="block text-xs text-muted-foreground">
                    A missing special is the most common reason a finished show never
                    counts as complete.
                  </span>
                </Label>
              </div>
              <div className="flex items-start gap-2">
                <Checkbox
                  id="automation-count-unmonitored-eps"
                  checked={scope.include_unmonitored_episodes ?? false}
                  onCheckedChange={(v) =>
                    patchScope({ include_unmonitored_episodes: v === true })
                  }
                />
                <Label
                  htmlFor="automation-count-unmonitored-eps"
                  className="text-sm font-normal"
                >
                  Count episodes you have unmonitored
                  <span className="block text-xs text-muted-foreground">
                    Otherwise a gap you unmonitored stops counting as a gap. Leave on
                    for “do I have every episode” rules.
                  </span>
                </Label>
              </div>
            </div>
          </>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Label className="text-xs text-muted-foreground">Folder location</Label>
          <MultiSelectFilter
            label="folder location"
            options={folderOptions}
            selected={selectedFolders}
            onChange={(next) => patchScope({ root_folders_any: next })}
          />
          <span className="text-xs text-muted-foreground">
            {selectedFolders.length === 0 ? "every folder" : `${selectedFolders.length} selected`}
          </span>
        </div>
        <TokenField
          id="automation-genres"
          label="Genres"
          hint="Any of these; leave empty for all genres."
          values={scope.genres_any ?? []}
          onChange={(next) => patchScope({ genres_any: next })}
          placeholder="anime, drama…"
        />
        <TokenField
          id="automation-tags"
          label="Sonarr/Radarr tags"
          hint="Any of these labels; resolved per instance at run time."
          values={scope.tags_any ?? []}
          onChange={(next) => patchScope({ tags_any: next })}
          placeholder="keep, favourite…"
        />
      </Section>

      <Section title="Must have" summary="what counts as good enough">
        <div className="grid gap-3 sm:grid-cols-2">
          <TokenField
            id="automation-langs"
            label="Audio language"
            values={require.audio_language_any ?? []}
            onChange={(next) => patchRequire({ audio_language_any: next })}
            placeholder="english, eng…"
          />
          <div className="grid gap-1.5">
            <Label htmlFor="automation-res" className="text-xs text-muted-foreground">
              Minimum resolution
            </Label>
            <Input
              id="automation-res"
              type="number"
              min={240}
              max={4320}
              placeholder="any"
              value={require.resolution_min ?? ""}
              onChange={(e) =>
                patchRequire({ resolution_min: e.target.value === "" ? null : Number(e.target.value) })
              }
            />
          </div>
          <TokenField
            id="automation-subs"
            label="Subtitle language"
            hint="For libraries with no dub: keep the original audio and require these subs."
            values={require.subtitle_language_any ?? []}
            onChange={(next) => patchRequire({ subtitle_language_any: next })}
            placeholder="eng, english…"
          />
          <TokenField
            id="automation-codecs"
            label="Video codec"
            values={require.video_codec_any ?? []}
            onChange={(next) => patchRequire({ video_codec_any: next })}
            placeholder="x265, hevc…"
          />
          <TokenField
            id="automation-quality"
            label="Quality name"
            values={require.quality_any ?? []}
            onChange={(next) => patchRequire({ quality_any: next })}
            placeholder="WEBDL-1080p…"
          />
        </div>
      </Section>

      <Section title="Otherwise do" summary={`${actions.length} action${actions.length === 1 ? "" : "s"}`}>
        <div className="flex items-center gap-2">
          <Checkbox
            id="automation-search-missing"
            checked={Boolean(actionOfType(actions, "search_missing"))}
            onCheckedChange={() => toggleAction("search_missing")}
          />
          <Label htmlFor="automation-search-missing" className="text-sm font-normal">
            Search items with no file
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id="automation-search-upgrade"
            checked={Boolean(actionOfType(actions, "search_upgrade"))}
            onCheckedChange={() => toggleAction("search_upgrade")}
          />
          <Label htmlFor="automation-search-upgrade" className="text-sm font-normal">
            Search upgrades for files below the bar
          </Label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Checkbox
            id="automation-tag"
            checked={Boolean(tagAction)}
            onCheckedChange={() => toggleAction("tag", { label: "needs-upgrade" })}
          />
          <Label htmlFor="automation-tag" className="text-sm font-normal">Apply tag</Label>
          {tagAction ? (
            <>
              <Input
                className="h-8 w-48"
                aria-label="Tag label"
                value={tagAction.label ?? ""}
                onChange={(e) => patchAction("tag", { label: e.target.value })}
              />
              <select
                className={SELECT_CLASS}
                aria-label="Tag which items"
                value={tagAction.when ?? "non_conforming"}
                onChange={(e) =>
                  patchAction("tag", { when: e.target.value as RuleAction["when"] })
                }
              >
                <option value="non_conforming">to what falls short</option>
                <option value="conforming">
                  {media === "series" ? "to shows fully in spec" : "to what is fully in spec"}
                </option>
              </select>
            </>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id="automation-unmonitor"
            checked={Boolean(monitorAction)}
            onCheckedChange={() => toggleAction("set_monitored", { value: false, when: "conforming" })}
          />
          <Label htmlFor="automation-unmonitor" className="text-sm font-normal">
            {media === "series"
              ? "Unmonitor a show once every aired episode is in spec"
              : media === "movies"
                ? "Unmonitor movies once they conform"
                : "Unmonitor once everything is in spec"}
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id="automation-dub-gate"
            checked={options.mal_dub_gate ?? false}
            onCheckedChange={(v) => patchParams({ options: { ...options, mal_dub_gate: v === true } })}
          />
          <Label htmlFor="automation-dub-gate" className="text-sm font-normal">
            Skip items MAL says have no dub (saves indexer quota)
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id="automation-new-dub"
            checked={options.new_dub_only ?? false}
            onCheckedChange={(v) =>
              patchParams({
                options: {
                  ...options,
                  new_dub_only: v === true,
                  ...(v === true ? { mal_dub_gate: true } : {}),
                },
              })
            }
          />
          <Label htmlFor="automation-new-dub" className="text-sm font-normal">
            Only act when a dub newly appears
          </Label>
        </div>
      </Section>

      <Section title="Schedule & limits" summary={draft.cron} defaultOpen={false}>
        <div className="grid gap-1.5">
          <Label htmlFor="automation-cron-preset" className="text-xs text-muted-foreground">
            Runs
          </Label>
          <select
            id="automation-cron-preset"
            className={SELECT_CLASS}
            value={CRON_PRESETS.some((p) => p.cron === draft.cron) ? draft.cron : "custom"}
            onChange={(e) => {
              if (e.target.value !== "custom") onChange({ ...draft, cron: e.target.value });
            }}
          >
            {CRON_PRESETS.map((preset) => (
              <option key={preset.cron} value={preset.cron}>{preset.label}</option>
            ))}
            <option value="custom">Custom…</option>
          </select>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="automation-cron" className="text-xs text-muted-foreground">
              Cron expression
            </Label>
            <Input
              id="automation-cron"
              value={draft.cron}
              onChange={(e) => onChange({ ...draft, cron: e.target.value })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="automation-tz" className="text-xs text-muted-foreground">
              Timezone (IANA)
            </Label>
            <Input
              id="automation-tz"
              value={draft.timezone ?? "UTC"}
              onChange={(e) => onChange({ ...draft, timezone: e.target.value })}
            />
          </div>
        </div>
        <CronPreview cron={draft.cron} timezone={draft.timezone} />
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="automation-budget" className="text-xs text-muted-foreground">
              Search budget per run (1–100)
            </Label>
            <Input
              id="automation-budget"
              type="number"
              min={1}
              max={100}
              value={draft.budget_per_run ?? 10}
              onChange={(e) => onChange({ ...draft, budget_per_run: Number(e.target.value) || 10 })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="automation-cooldown" className="text-xs text-muted-foreground">
              Per-item cooldown (days, 1–90)
            </Label>
            <Input
              id="automation-cooldown"
              type="number"
              min={1}
              max={90}
              value={draft.cooldown_days ?? 7}
              onChange={(e) => onChange({ ...draft, cooldown_days: Number(e.target.value) || 7 })}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <Checkbox
              id="automation-enabled"
              checked={draft.enabled ?? false}
              onCheckedChange={(v) => onChange({ ...draft, enabled: v === true })}
            />
            <Label htmlFor="automation-enabled" className="text-sm font-normal">Enabled (scheduled)</Label>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="automation-dry-run"
              checked={draft.dry_run ?? true}
              onCheckedChange={(v) => onChange({ ...draft, dry_run: v === true })}
            />
            <Label htmlFor="automation-dry-run" className="text-sm font-normal">Dry-run (simulate only)</Label>
          </div>
        </div>
      </Section>
    </div>
  );
}
