import { useCallback, useSyncExternalStore } from "react";

/** How strongly the top bar shades artwork behind it (blur and tint scale
    together). Kept per browser, like density and theme. */
export const HEADER_SCRIM_KEY = "nebularr.ui.headerScrim";
export const HEADER_SCRIM_DEFAULT = 1;
export const HEADER_SCRIM_MIN = 0.5;
export const HEADER_SCRIM_MAX = 1.5;

// Same-tab writes don't fire `storage`, so the header and the setting talk
// through this event instead.
const CHANGE_EVENT = "nebularr:header-scrim";

function clamp(value: number): number {
  return Math.min(HEADER_SCRIM_MAX, Math.max(HEADER_SCRIM_MIN, value));
}

function read(): number {
  try {
    const raw = window.localStorage.getItem(HEADER_SCRIM_KEY);
    const value = raw === null ? NaN : Number(JSON.parse(raw));
    return Number.isFinite(value) ? clamp(value) : HEADER_SCRIM_DEFAULT;
  } catch {
    return HEADER_SCRIM_DEFAULT;
  }
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent): void => {
    if (event.key === HEADER_SCRIM_KEY) onChange();
  };
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function useHeaderScrim(): [number, (value: number) => void] {
  const strength = useSyncExternalStore(subscribe, read, () => HEADER_SCRIM_DEFAULT);
  const setStrength = useCallback((value: number): void => {
    try {
      window.localStorage.setItem(HEADER_SCRIM_KEY, JSON.stringify(clamp(value)));
    } catch {
      // Storage blocked (private mode): the slider still moves for this tab.
    }
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);
  return [strength, setStrength];
}
