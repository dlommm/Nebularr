/** "nebularr.savedViews.reporting" -> "reporting" (server-side page key). */
export function pageKeyFromStorageKey(storageKey: string): string {
  const tail = storageKey.split(".").pop() ?? storageKey;
  return tail.toLowerCase().replace(/[^a-z0-9.-]/g, "-") || "page";
}
