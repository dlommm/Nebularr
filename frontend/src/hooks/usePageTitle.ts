import { useEffect } from "react";

const BASE = "Nebularr Control Plane";

/**
 * Set document title for the current view; restores base on unmount.
 */
export function usePageTitle(segment: string): void {
  useEffect(() => {
    const t = segment ? `Nebularr — ${segment}` : BASE;
    document.title = t;
    return () => {
      document.title = BASE;
    };
  }, [segment]);
}
