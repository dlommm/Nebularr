import { useEffect, useState } from "react";

export function useLocalStorageState<T>(key: string, initial: T): [T, (next: T) => void] {
  const [state, setState] = useState<T>(() => {
    const storage = window.localStorage as Storage | Record<string, unknown>;
    const getter = (storage as Storage).getItem;
    if (typeof getter !== "function") {
      return initial;
    }
    const raw = getter.call(storage, key);
    if (!raw) {
      return initial;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      return initial;
    }
  });

  useEffect(() => {
    const storage = window.localStorage as Storage | Record<string, unknown>;
    const setter = (storage as Storage).setItem;
    if (typeof setter === "function") {
      setter.call(storage, key, JSON.stringify(state));
    }
  }, [key, state]);

  return [state, setState];
}

export function fmtDate(value?: string | null): string {
  if (!value) return "-";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}

export function fmtDuration(seconds?: number | null): string {
  if (seconds === undefined || seconds === null) return "-";
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function fmtSize(bytes?: number | null): string {
  if (bytes === undefined || bytes === null) return "-";
  const gib = bytes / (1024 * 1024 * 1024);
  if (gib >= 1) return `${gib.toFixed(2)} GiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState<T>(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
