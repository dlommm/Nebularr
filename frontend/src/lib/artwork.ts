/** Artwork URLs (proxied by Nebularr from Sonarr/Radarr) and the title-card
    fallback used whenever an item has no art, art is off, or it is loading. */

export type ArtKind = "series" | "movie";
export type ArtCover = "poster" | "fanart" | "banner" | "clearlogo";

export function artUrl(kind: ArtKind, instanceName: string, itemId: number, cover: ArtCover, size?: number): string {
  const base = `/api/art/${kind}/${encodeURIComponent(instanceName)}/${itemId}/${cover}`;
  return size ? `${base}?size=${size}` : base;
}

export type TitleCardShape = "sun" | "band" | "column";

export type TitleCardStyle = { bg: string; fg: string; shape: TitleCardShape };

/** Deep ground + light ink pairs. Every pair keeps the title legible (fg on bg
    is at least 4.5:1) and none leans on indigo/violet, which the rest of the UI
    avoids. */
const PALETTE: readonly (readonly [string, string])[] = [
  ["#1f3a4a", "#d9a55b"],
  ["#3b4a2a", "#e8dcc0"],
  ["#5a2230", "#f0c9a8"],
  ["#22303a", "#c8d3d9"],
  ["#2c3e50", "#9bc1c9"],
  ["#4a3b2a", "#e4b98c"],
  ["#183338", "#8fd1c7"],
  ["#3a2e3e", "#d8c7b0"],
  ["#3a2a20", "#e09a6a"],
  ["#1d2b3a", "#7db9e8"],
  ["#4a2238", "#f2a9c4"],
  ["#26343d", "#dce6ea"],
  ["#5b1e1a", "#f0a07a"],
  ["#3e3320", "#d9c27a"],
  ["#2a3530", "#a9c9b5"],
];

const SHAPES: readonly TitleCardShape[] = ["sun", "band", "column"];

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Same title, same card — so a show is recognisable before its art loads. */
export function titleCardStyle(title: string): TitleCardStyle {
  const h = hash(title.trim().toLowerCase());
  const [bg, fg] = PALETTE[h % PALETTE.length];
  return { bg, fg, shape: SHAPES[(h >>> 8) % SHAPES.length] };
}

/** First word(s) of a title for the oversized outline text on fanart cards. */
export function ghostWord(title: string): string {
  const words = title.replace(/^(the|a|an)\s+/i, "").split(/\s+/).filter(Boolean);
  return (words[0] ?? title).slice(0, 12);
}
