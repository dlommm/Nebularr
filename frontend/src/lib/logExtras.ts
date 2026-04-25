export function formatLogExtras(entry: Record<string, unknown>): string | null {
  const skip = new Set(["ts", "level", "logger", "message"]);
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entry)) {
    if (!skip.has(k)) rest[k] = v;
  }
  if (Object.keys(rest).length === 0) return null;
  try {
    return JSON.stringify(rest, null, 2);
  } catch {
    return String(rest);
  }
}
