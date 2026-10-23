import { cn } from "@/lib/utils";
import { fmtSize } from "@/hooks";
import type { EpisodeRow } from "@/types";
import { QUALITY_TIERS, groupSeasons, qualityTier } from "@/lib/quality";

/** Every episode as a cell, shaded by quality; missing ones are outlined. */
export function SeasonGrid({
  episodes,
  selectedId,
  newestId,
  onSelect,
  size = "lg",
  showSummary = true,
}: {
  episodes: EpisodeRow[];
  selectedId?: number | null;
  newestId?: number | null;
  onSelect?: (episode: EpisodeRow) => void;
  size?: "sm" | "md" | "lg";
  showSummary?: boolean;
}): JSX.Element {
  const seasons = groupSeasons(episodes);
  const cell = size === "lg" ? "size-[30px] text-[10px]" : size === "md" ? "size-4" : "size-[11px]";
  return (
    <div className={cn("flex flex-col", size === "sm" ? "gap-1" : "gap-2")}>
      {seasons.map((season, si) => (
        <div key={season.number} className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className={cn("cond w-8 font-[640] text-muted-foreground", size === "lg" ? "text-lg" : "text-sm")}>
            {season.number === 0 ? "SP" : `S${season.number}`}
          </span>
          <div className={cn("flex flex-wrap", size === "lg" ? "gap-1" : "gap-[3px]")}>
            {season.episodes.map((ep, ei) => {
              const tier = qualityTier(ep.has_file, ep.quality);
              const code = `S${String(ep.season_number).padStart(2, "0")}E${String(ep.episode_number).padStart(2, "0")}`;
              const label = `${code}${ep.episode_title ? ` · ${ep.episode_title}` : ""} — ${ep.has_file ? ep.quality ?? "on disk" : "missing"}`;
              const classes = cn(
                "ns-cell flex items-center justify-center font-mono",
                cell,
                `ns-${tier}`,
                (ep.episode_id === selectedId || ep.episode_id === newestId) && "ns-qn",
              );
              const style = { animationDelay: `${150 + si * 60 + ei * 14}ms` };
              return onSelect ? (
                <button
                  key={ep.episode_id}
                  type="button"
                  className={cn(classes, "cursor-pointer transition-transform hover:scale-110")}
                  style={style}
                  title={label}
                  aria-label={label}
                  aria-pressed={ep.episode_id === selectedId}
                  onClick={() => onSelect(ep)}
                >
                  {size === "lg" ? ep.episode_number : null}
                </button>
              ) : (
                <span key={ep.episode_id} className={classes} style={style} title={label} />
              );
            })}
          </div>
          {showSummary && size !== "sm" ? (
            <span className="ml-auto text-[13px] text-subtle-foreground tabular-nums">
              {season.have}/{season.episodes.length}
              {season.bytes ? ` · ${fmtSize(season.bytes)}` : ""}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function QualityLegend({ className }: { className?: string }): JSX.Element {
  return (
    <div className={cn("flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground", className)}>
      {QUALITY_TIERS.map(({ tier, label }) => (
        <span key={tier} className="inline-flex items-center gap-2">
          <span className={cn("size-2.5", `ns-${tier}`)} aria-hidden />
          {label}
        </span>
      ))}
      <span className="inline-flex items-center gap-2">
        <span className="ns-qm size-2.5" aria-hidden />
        missing
      </span>
    </div>
  );
}
