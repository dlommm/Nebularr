import { useCallback, useEffect, useRef, useState } from "react";

export type UseDraftSyncResult<T> = {
  /** Current draft value per key; server-derived until the row is edited. */
  drafts: Record<string, T>;
  /** Merge a partial patch into a row's draft and mark that row dirty. */
  setDraft: (key: string, patch: Partial<T>) => void;
  /** Keys with unsaved local edits — the server-merge effect leaves these alone. */
  dirtyKeys: Set<string>;
  /** Clear a row's dirty flag; if the row still exists server-side, re-sync its
      draft to the current server value (as of the latest render). */
  resetDraft: (key: string) => void;
};

/**
 * Keeps a keyed table of editable "draft" rows in sync with refetched server
 * data, without ever clobbering a row the user is actively editing.
 *
 * Every row in `serverData` merges into `drafts` on each call, *except* rows
 * whose key is in `dirtyKeys` — those keep whatever the user last typed.
 * Call `resetDraft(key)` after that row's own save succeeds (its refetch
 * will then land in `drafts` normally). This is what lets saving row A avoid
 * clobbering row B's in-progress edits, and ensures saving a row clears only
 * that row's dirty flag.
 */
export function useDraftSync<T>(serverData: T[] | undefined, keyOf: (item: T) => string): UseDraftSyncResult<T> {
  const [drafts, setDrafts] = useState<Record<string, T>>({});
  const [dirtyKeys, setDirtyKeys] = useState<Set<string>>(new Set());
  // Refs so the merge effect doesn't need `keyOf`/`dirtyKeys` as deps: `keyOf`
  // is frequently a fresh inline closure each render, and depending on
  // `dirtyKeys` would re-run the merge (and undo itself) on every edit.
  const keyOfRef = useRef(keyOf);
  keyOfRef.current = keyOf;
  const dirtyKeysRef = useRef(dirtyKeys);
  dirtyKeysRef.current = dirtyKeys;
  // resetDraft reads server data through a ref (like `dirtyKeysRef`) instead of
  // closing over `serverData` — otherwise a callback reference captured before a
  // refetch would re-sync to the stale value it was born with.
  const serverDataRef = useRef(serverData);
  serverDataRef.current = serverData;

  useEffect(() => {
    if (!serverData) return;
    const validKeys = new Set<string>();
    setDrafts((prev) => {
      const next: Record<string, T> = {};
      for (const item of serverData) {
        const key = keyOfRef.current(item);
        validKeys.add(key);
        next[key] = dirtyKeysRef.current.has(key) && prev[key] !== undefined ? prev[key] : item;
      }
      return next;
    });
    // Drop dirty flags for rows that no longer exist server-side — there is
    // nothing left to save them against.
    setDirtyKeys((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Set<string>();
      prev.forEach((key) => {
        if (validKeys.has(key)) next.add(key);
        else changed = true;
      });
      return changed ? next : prev;
    });
  }, [serverData]);

  const setDraft = useCallback((key: string, patch: Partial<T>): void => {
    setDrafts((prev) => {
      const base = prev[key];
      if (base === undefined) return prev;
      return { ...prev, [key]: { ...base, ...patch } };
    });
    setDirtyKeys((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
  }, []);

  const resetDraft = useCallback((key: string): void => {
    setDirtyKeys((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    const match = serverDataRef.current?.find((item) => keyOfRef.current(item) === key);
    if (match) {
      setDrafts((prev) => ({ ...prev, [key]: match }));
    }
  }, []);

  return { drafts, setDraft, dirtyKeys, resetDraft };
}
