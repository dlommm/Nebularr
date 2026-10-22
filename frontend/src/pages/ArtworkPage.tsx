import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { usePageTitle } from "../hooks/usePageTitle";
import { fmtSize } from "../hooks";
import { useActionError } from "../hooks/useActionError";
import { queryKeys } from "../lib/queryKeys";
import { useConfirmDialog } from "@/components/nebula/ConfirmDialog";
import { QueryErrorNotice } from "@/components/nebula/QueryErrorNotice";
import { Figure, Figures, SectionHead } from "@/components/ns/Page";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { relTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { ArtworkConfig, ArtworkMode } from "@/types";

const CAP_OPTIONS: { mb: number; label: string }[] = [
  { mb: 0, label: "No limit" },
  { mb: 1024, label: "1 GB" },
  { mb: 2048, label: "2 GB" },
  { mb: 5120, label: "5 GB" },
  { mb: 10240, label: "10 GB" },
  { mb: 25600, label: "25 GB" },
];

function Choice({
  name,
  checked,
  onChange,
  title,
  body,
  disabled,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  title: string;
  body: string;
  disabled?: boolean;
}): JSX.Element {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-md border px-4 py-3.5 transition-colors",
        checked ? "border-signal bg-signal/5" : "border-border hover:border-input",
        disabled && "pointer-events-none opacity-50",
      )}
    >
      <input type="radio" name={name} checked={checked} onChange={onChange} disabled={disabled} className="mt-1 size-4 accent-[var(--signal)]" />
      <span>
        <span className="block text-[15px]">{title}</span>
        <span className="mt-1 block text-[13px] text-muted-foreground">{body}</span>
      </span>
    </label>
  );
}

export function ArtworkPage(): JSX.Element {
  usePageTitle("Artwork");
  const queryClient = useQueryClient();
  const { runAction } = useActionError();
  const { requestConfirm, confirmDialog } = useConfirmDialog();
  const config = useQuery({
    queryKey: queryKeys.artworkConfig,
    queryFn: api.artworkConfig,
    refetchInterval: (query) => (query.state.data?.prefetch_running ? 3_000 : 30_000),
  });

  const save = (patch: Partial<Pick<ArtworkConfig, "enabled" | "mode" | "remote_fallback" | "cache_max_mb">>, what: string): void => {
    void runAction(
      async () => {
        const next = await api.saveArtworkConfig(patch);
        queryClient.setQueryData(queryKeys.artworkConfig, next);
      },
      `save artwork ${what}`,
      { successMessage: "Artwork settings saved" },
    );
  };

  if (config.isError) {
    return <QueryErrorNotice label="artwork settings" error={config.error} retry={() => void config.refetch()} />;
  }
  const c = config.data;
  if (!c) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const setMode = (mode: ArtworkMode): void => {
    if (mode === c.mode) return;
    if (mode === "live" && c.cache.files > 0) {
      requestConfirm({
        title: "Load artwork live?",
        description: `This frees ${fmtSize(c.cache.bytes)} by deleting the cache (a small poster sample stays for the sign-in page). Pages will load art from Sonarr and Radarr every time, which is slower.`,
        confirmLabel: "Switch to live",
        onConfirm: () => save({ mode }, "mode"),
      });
      return;
    }
    save({ mode }, "mode");
  };

  const last = c.last_prefetch;
  const posters = c.cache.by_cover.poster?.files ?? 0;
  const fanart = c.cache.by_cover.fanart?.files ?? 0;

  return (
    <div className="space-y-12">
      <section aria-labelledby="art-h">
        <SectionHead id="art-h" title="Artwork" />
        <p className="max-w-2xl text-[15px] text-muted-foreground">
          Posters and fanart come from your own Sonarr and Radarr. Nebularr fetches them with the stored API key, so your
          browser never talks to those servers directly.
        </p>
        <label className="mt-5 inline-flex min-h-11 cursor-pointer items-center gap-3 text-[15px]">
          <input
            type="checkbox"
            role="switch"
            checked={c.enabled}
            onChange={(e) => save({ enabled: e.target.checked }, "visibility")}
            className="size-5 accent-[var(--signal)]"
          />
          Show artwork
        </label>
      </section>

      <section aria-labelledby="mode-h" className={cn(!c.enabled && "opacity-60")}>
        <SectionHead id="mode-h" title="How to load it" />
        <div className="grid gap-3 md:grid-cols-2">
          <Choice
            name="art-mode"
            checked={c.mode === "cache"}
            onChange={() => setMode("cache")}
            disabled={!c.enabled}
            title="Cache it on this server (recommended)"
            body="Fastest pages. Posters and fanart are saved under the runtime volume, fetched in the background and as you browse."
          />
          <Choice
            name="art-mode"
            checked={c.mode === "live"}
            onChange={() => setMode("live")}
            disabled={!c.enabled}
            title="Load it live"
            body="Uses almost no disk. Every image is fetched from Sonarr or Radarr when a page needs it, so pages fill in more slowly."
          />
        </div>

        <div className="mt-8 grid gap-3 md:grid-cols-2">
          <Choice
            name="art-source"
            checked={!c.remote_fallback}
            onChange={() => save({ remote_fallback: false }, "source")}
            disabled={!c.enabled}
            title="Only my Sonarr and Radarr"
            body="No requests leave your network."
          />
          <Choice
            name="art-source"
            checked={c.remote_fallback}
            onChange={() => save({ remote_fallback: true }, "source")}
            disabled={!c.enabled}
            title="Also TheTVDB and TMDB"
            body="Fills gaps your servers haven’t cached yet. Makes outbound requests; your API keys are never sent."
          />
        </div>
      </section>

      <section aria-labelledby="cache-h" className={cn((!c.enabled || c.mode === "live") && "opacity-60")}>
        <SectionHead
          id="cache-h"
          title="The cache"
          aside={c.prefetch_running ? <span className="text-signal">Fetching artwork now…</span> : undefined}
        />
        <Figures>
          <Figure value={c.cache.files.toLocaleString()} label="images cached" size="md" />
          <Figure value={fmtSize(c.cache.bytes)} label="on disk" size="md" />
          <Figure value={posters.toLocaleString()} label="posters" size="md" />
          <Figure value={fanart.toLocaleString()} label="fanart" size="md" />
        </Figures>
        <p className="mt-4 text-[13px] text-muted-foreground">
          {last
            ? `Last background fetch ${last.finished_at ? relTime(last.finished_at) : "is running"} (${last.reason}): ${last.fetched} new, ${last.already_cached} already cached, ${last.unavailable} unavailable${last.pruned ? `, ${last.pruned} removed` : ""}${last.evicted ? `, ${last.evicted} evicted for space` : ""}.`
            : "The cache fills in the background after start-up, every six hours, and as you browse."}
        </p>

        <div className="mt-6 flex flex-wrap items-end gap-4">
          <label className="flex flex-col gap-1.5 text-xs text-subtle-foreground">
            Keep the cache under
            <select
              value={c.cache_max_mb}
              onChange={(e) => save({ cache_max_mb: Number(e.target.value) }, "cache limit")}
              disabled={!c.enabled || c.mode === "live"}
              className="h-10 rounded-md border border-border bg-muted px-3 text-sm text-foreground"
            >
              {CAP_OPTIONS.some((o) => o.mb === c.cache_max_mb) ? null : (
                <option value={c.cache_max_mb}>{fmtSize(c.cache_max_mb * 1024 * 1024)}</option>
              )}
              {CAP_OPTIONS.map((o) => (
                <option key={o.mb} value={o.mb}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <Button
            type="button"
            disabled={!c.enabled || c.prefetch_running}
            onClick={() =>
              void runAction(
                async () => {
                  const res = await api.prefetchArtwork();
                  await queryClient.invalidateQueries({ queryKey: queryKeys.artworkConfig });
                  return res;
                },
                "start artwork prefetch",
                { successMessage: "Fetching artwork in the background" },
              )
            }
          >
            {c.mode === "live" ? "Refresh sign-in posters" : "Fetch everything now"}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={c.prefetch_running || c.cache.files === 0}
            onClick={() =>
              requestConfirm({
                title: "Clear the artwork cache?",
                description: `Deletes ${c.cache.files.toLocaleString()} images (${fmtSize(c.cache.bytes)}). They are fetched again as needed.`,
                confirmLabel: "Clear cache",
                destructive: true,
                onConfirm: () =>
                  void runAction(
                    async () => {
                      const next = await api.clearArtworkCache();
                      queryClient.setQueryData(queryKeys.artworkConfig, next);
                    },
                    "clear artwork cache",
                    { successMessage: "Artwork cache cleared" },
                  ),
              })
            }
          >
            Clear cache
          </Button>
        </div>
      </section>
      {confirmDialog}
    </div>
  );
}
