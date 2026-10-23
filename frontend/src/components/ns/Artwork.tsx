import { useState } from "react";
import { cn } from "@/lib/utils";
import { artUrl, ghostWord, titleCardStyle, type ArtKind, type TitleCardShape } from "@/lib/artwork";

function Shape({ shape, color, variant }: { shape: TitleCardShape; color: string; variant: "poster" | "fanart" }): JSX.Element {
  if (shape === "sun") {
    return (
      <span
        aria-hidden
        className={cn(
          "absolute aspect-square rounded-full opacity-85",
          variant === "poster" ? "top-[14%] -right-[20%] w-[80%]" : "top-[10%] right-[10%] w-[24%] min-w-40",
        )}
        style={{ background: color }}
      />
    );
  }
  if (shape === "band") {
    return (
      <>
        <span aria-hidden className="absolute inset-x-0 top-[34%] h-[16%] opacity-85" style={{ background: color }} />
        <span aria-hidden className="absolute inset-x-0 top-[56%] h-[3%] opacity-50" style={{ background: color }} />
      </>
    );
  }
  return (
    <>
      <span aria-hidden className="absolute top-0 bottom-[42%] left-[58%] w-[14%] opacity-85" style={{ background: color }} />
      <span aria-hidden className="absolute top-0 bottom-[42%] left-[76%] w-[4%] opacity-50" style={{ background: color }} />
    </>
  );
}

/** Designed fallback for a missing poster: the show's own colours, a shape,
    and its title — also what shows while the real poster loads. */
export function TitleCard({ title, year, className }: { title: string; year?: number | string | null; className?: string }): JSX.Element {
  const style = titleCardStyle(title);
  // Size the title so its longest word fits the card width: condensed caps run
  // about 0.55em per letter, and the text box is 84% of the card.
  const longestWord = Math.max(4, ...title.split(/\s+/).map((word) => word.length));
  const fitCqi = Math.min(14, Math.floor((84 / (longestWord * 0.55)) * 10) / 10);
  return (
    <div className={cn("@container relative overflow-hidden", className)} style={{ background: style.bg, color: style.fg }}>
      <Shape shape={style.shape} color={style.fg} variant="poster" />
      {year ? <span className="absolute top-[6%] left-[8%] font-mono text-[10px] opacity-80">{year}</span> : null}
      <span
        className="cond absolute inset-x-[8%] bottom-[6%] line-clamp-4 leading-[0.86] font-[760] break-words"
        style={{ fontSize: `clamp(7px, ${fitCqi}cqi, 30px)` }}
      >
        {title}
      </span>
    </div>
  );
}

type ArtProps = {
  kind: ArtKind;
  instanceName: string;
  itemId: number;
  title: string;
  year?: number | string | null;
  className?: string;
  /** Turn off the real image, e.g. when artwork is disabled in Setup. */
  disabled?: boolean;
};

/** Poster at 2:3 with the title card underneath; the image fades in over it. */
export function Poster({ kind, instanceName, itemId, title, year, className, disabled, size = 500 }: ArtProps & { size?: 250 | 500 }): JSX.Element {
  const [state, setState] = useState<"loading" | "loaded" | "failed">("loading");
  return (
    <div className={cn("relative aspect-[2/3] overflow-hidden rounded-[3px] bg-muted", className)}>
      <TitleCard title={title} year={year} className="absolute inset-0" />
      {!disabled && state !== "failed" ? (
        <img
          src={artUrl(kind, instanceName, itemId, "poster", size)}
          alt=""
          loading="lazy"
          decoding="async"
          onLoad={() => setState("loaded")}
          onError={() => setState("failed")}
          className={cn(
            "absolute inset-0 size-full object-cover transition-opacity duration-500",
            state === "loaded" ? "opacity-100" : "opacity-0",
          )}
        />
      ) : null}
    </div>
  );
}

/** Full-bleed fanart. Falls back to the title card's colours with the title as
    oversized outline type, so the hero never looks empty. */
export function Fanart({ kind, instanceName, itemId, title, className, disabled, eager }: ArtProps & { eager?: boolean }): JSX.Element {
  const [state, setState] = useState<"loading" | "loaded" | "failed">("loading");
  const style = titleCardStyle(title);
  return (
    <div aria-hidden className={cn("absolute inset-0 overflow-hidden", className)} style={{ background: style.bg }}>
      <div className="absolute inset-0 animate-slow-zoom">
        <Shape shape={style.shape} color={style.fg} variant="fanart" />
        <span
          className="cond absolute top-[2%] -left-[1%] text-[clamp(160px,28vw,520px)] leading-[0.8] font-[800] whitespace-nowrap text-transparent"
          style={{ WebkitTextStroke: `2px color-mix(in srgb, ${style.fg} 16%, transparent)` }}
        >
          {ghostWord(title)}
        </span>
        {!disabled && state !== "failed" ? (
          <img
            src={artUrl(kind, instanceName, itemId, "fanart")}
            alt=""
            loading={eager ? "eager" : "lazy"}
            decoding="async"
            onLoad={() => setState("loaded")}
            onError={() => setState("failed")}
            className={cn(
              "absolute inset-0 size-full object-cover transition-opacity duration-700",
              state === "loaded" ? "opacity-100" : "opacity-0",
            )}
          />
        ) : null}
      </div>
    </div>
  );
}
