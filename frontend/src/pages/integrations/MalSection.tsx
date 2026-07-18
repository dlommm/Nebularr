import { useEffect, useRef, useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import { useActionError } from "../../hooks/useActionError";
import { queryKeys } from "../../lib/queryKeys";
import type { MalConfigResponse } from "../../types";
import { QueryErrorNotice } from "@/components/nebula/QueryErrorNotice";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { SectionCard, SELECT_CLASS } from "./shared";

export function MalSection({ malConfig }: { malConfig: UseQueryResult<MalConfigResponse> }): JSX.Element {
  const queryClient = useQueryClient();
  const { setError, runAction } = useActionError();
  const [malClientIdInput, setMalClientIdInput] = useState("");
  const [malClearClientId, setMalClearClientId] = useState(false);
  const [malIngestEnabled, setMalIngestEnabled] = useState(false);
  const [malMatcherEnabled, setMalMatcherEnabled] = useState(false);
  const [malTaggingEnabled, setMalTaggingEnabled] = useState(false);
  const [malAllowTitleYearMatch, setMalAllowTitleYearMatch] = useState(false);
  const [malSourceMalDubsEnabled, setMalSourceMalDubsEnabled] = useState(true);
  const [malSourceMydublistEnabled, setMalSourceMydublistEnabled] = useState(true);
  const [malCoverageTaggingEnabled, setMalCoverageTaggingEnabled] = useState(false);
  const [malMydublistTier, setMalMydublistTier] = useState("normal");

  // Populate the toggle draft from the server exactly once: a naive
  // `[malConfig.data]` effect would resync (and clobber) in-progress edits
  // every time an unrelated refetch (poll, SSE invalidation) lands.
  const malPopulatedRef = useRef(false);
  useEffect(() => {
    if (!malConfig.data || malPopulatedRef.current) return;
    malPopulatedRef.current = true;
    setMalIngestEnabled(Boolean(malConfig.data.ingest_enabled));
    setMalMatcherEnabled(Boolean(malConfig.data.matcher_enabled));
    setMalTaggingEnabled(Boolean(malConfig.data.tagging_enabled));
    setMalAllowTitleYearMatch(Boolean(malConfig.data.allow_title_year_match));
    setMalSourceMalDubsEnabled(Boolean(malConfig.data.source_mal_dubs_enabled));
    setMalSourceMydublistEnabled(Boolean(malConfig.data.source_mydublist_enabled));
    setMalCoverageTaggingEnabled(Boolean(malConfig.data.coverage_tagging_enabled));
    setMalMydublistTier(malConfig.data.mydublist_tier || "normal");
  }, [malConfig.data]);

  const saveMalConfig = async (): Promise<void> => {
    const changingClientId = malClearClientId || Boolean(malClientIdInput.trim());
    if (!changingClientId && !malConfig.data) {
      setError("MAL settings are still loading. Please try again.", "save MyAnimeList settings");
      return;
    }
    if (!changingClientId && malConfig.data) {
      const toggleChanged =
        malIngestEnabled !== Boolean(malConfig.data.ingest_enabled) ||
        malMatcherEnabled !== Boolean(malConfig.data.matcher_enabled) ||
        malTaggingEnabled !== Boolean(malConfig.data.tagging_enabled) ||
        malAllowTitleYearMatch !== Boolean(malConfig.data.allow_title_year_match) ||
        malSourceMalDubsEnabled !== Boolean(malConfig.data.source_mal_dubs_enabled) ||
        malSourceMydublistEnabled !== Boolean(malConfig.data.source_mydublist_enabled) ||
        malCoverageTaggingEnabled !== Boolean(malConfig.data.coverage_tagging_enabled) ||
        malMydublistTier !== (malConfig.data.mydublist_tier || "normal");
      if (!toggleChanged) {
        setError("Make a change before saving.", "save MyAnimeList settings");
        return;
      }
    }
    if (changingClientId && !malClearClientId && !malClientIdInput.trim()) {
      setError("Enter a MyAnimeList client ID, or check remove stored ID to clear.", "save MyAnimeList client ID");
      return;
    }
    await runAction(
      async () => {
        await api.saveMalConfig({
          clear_client_id: malClearClientId,
          ...(malClientIdInput.trim() ? { client_id: malClientIdInput.trim() } : {}),
          // The toggles/tier below reflect this component's local draft state,
          // which only tracks real server values once `malConfig.data` has
          // loaded — sending them while it's still loading would overwrite
          // the stored settings with these fields' unloaded defaults.
          ...(malConfig.data
            ? {
                ingest_enabled: malIngestEnabled,
                matcher_enabled: malMatcherEnabled,
                tagging_enabled: malTaggingEnabled,
                allow_title_year_match: malAllowTitleYearMatch,
                source_mal_dubs_enabled: malSourceMalDubsEnabled,
                source_mydublist_enabled: malSourceMydublistEnabled,
                coverage_tagging_enabled: malCoverageTaggingEnabled,
                mydublist_tier: malMydublistTier,
              }
            : {}),
        });
        setMalClientIdInput("");
        setMalClearClientId(false);
        await queryClient.invalidateQueries({ queryKey: queryKeys.malConfig });
      },
      "save MyAnimeList settings",
    );
  };

  return (
    <SectionCard
      title="MyAnimeList API"
      description="Stored in the database when set here (persists across restarts). MAL_CLIENT_ID from the environment is used if nothing is stored."
    >
      {malConfig.isError ? (
        <QueryErrorNotice label="MAL settings" retry={() => void malConfig.refetch()} error={malConfig.error} />
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Badge variant="outline">
          {malConfig.data?.client_id_configured
            ? "client ID stored in database"
            : malConfig.data?.env_fallback_configured
              ? "using MAL_CLIENT_ID from environment"
              : "client ID not configured"}
        </Badge>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="grid w-full gap-1.5">
          <Label htmlFor="mal-client-id" className="text-xs text-muted-foreground">
            MyAnimeList API client ID (from myanimelist.net/apiconfig)
          </Label>
          <Input
            id="mal-client-id"
            type="password"
            autoComplete="off"
            value={malClientIdInput}
            onChange={(event) => setMalClientIdInput(event.target.value)}
          />
        </div>
        <Button type="button" variant="secondary" className="shrink-0" onClick={() => void saveMalConfig()}>
          Save
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox
          id="mal-clear-client-id"
          checked={malClearClientId}
          onCheckedChange={(value) => setMalClearClientId(value === true)}
        />
        <Label htmlFor="mal-clear-client-id" className="text-sm text-muted-foreground">
          remove stored client ID (fall back to environment only)
        </Label>
      </div>
      {malConfig.isLoading || !malConfig.data ? (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-9 w-64" />
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            {(
              [
                ["mal-ingest", "enable MAL ingest scheduler", malIngestEnabled, setMalIngestEnabled],
                ["mal-matcher", "enable MAL matcher scheduler", malMatcherEnabled, setMalMatcherEnabled],
                ["mal-tagging", "enable MAL tag sync scheduler", malTaggingEnabled, setMalTaggingEnabled],
                [
                  "mal-title-year",
                  "allow title+year fallback matching (when ID linking is unavailable)",
                  malAllowTitleYearMatch,
                  setMalAllowTitleYearMatch,
                ],
                ["mal-source-mal-dubs", "use MAL-Dubs as a dub-list source", malSourceMalDubsEnabled, setMalSourceMalDubsEnabled],
                [
                  "mal-source-mydublist",
                  "use MyDubList as a dub-list source (CC BY 4.0)",
                  malSourceMydublistEnabled,
                  setMalSourceMydublistEnabled,
                ],
                [
                  "mal-coverage-tagging",
                  "enable coverage tag sync scheduler (fully-english / partial-english from your files)",
                  malCoverageTaggingEnabled,
                  setMalCoverageTaggingEnabled,
                ],
              ] as const
            ).map(([id, label, checked, setter]) => (
              <div className="flex items-center gap-2" key={id}>
                <Checkbox id={id} checked={checked} onCheckedChange={(value) => setter(value === true)} />
                <Label htmlFor={id} className="text-sm text-muted-foreground">
                  {label}
                </Label>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Label htmlFor="mal-mydublist-tier" className="text-xs text-muted-foreground">
              MyDubList confidence tier (how many of its sources must agree a dub exists)
            </Label>
            <select
              id="mal-mydublist-tier"
              aria-label="MyDubList confidence tier"
              className={SELECT_CLASS}
              value={malMydublistTier}
              disabled={!malSourceMydublistEnabled}
              onChange={(event) => setMalMydublistTier(event.target.value)}
            >
              {(["low", "normal", "high", "very-high"] as const).map((tier) => (
                <option key={tier} value={tier}>
                  {tier}
                </option>
              ))}
            </select>
          </div>
        </>
      )}
    </SectionCard>
  );
}
