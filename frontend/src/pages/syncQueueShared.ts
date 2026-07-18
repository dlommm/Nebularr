/**
 * Clamp a server-paginated offset back onto the last page that still has
 * rows. Used when `total` shrinks out from under the current page — e.g. a
 * bulk requeue empties the "dead letter" filter while the user is on page 2
 * — so the UI snaps back to real data instead of showing an empty page.
 */
export function clampPageOffset(offset: number, total: number, pageSize: number): number {
  if (total <= 0) return 0;
  if (offset < total) return Math.max(0, offset);
  return Math.max(0, Math.floor((total - 1) / pageSize) * pageSize);
}
