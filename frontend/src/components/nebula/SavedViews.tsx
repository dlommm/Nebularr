import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Bookmark, Link2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "../../api";
import type { SavedViewEntry } from "../../types";
import { pageKeyFromStorageKey } from "./savedViewsShared";

function readLegacyLocalViews(storageKey: string): SavedViewEntry[] {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (entry): entry is SavedViewEntry =>
          !!entry && typeof entry === "object" && typeof (entry as SavedViewEntry).name === "string",
      )
      .map((entry) => ({ name: entry.name, search: String(entry.search ?? "") }));
  } catch {
    return [];
  }
}

/**
 * Named snapshots of the current page's URL search params, persisted server-side
 * (app settings) so they survive browser changes; pre-2.6 localStorage views are
 * migrated on first load. Applying a view is just setting the params — and
 * "Copy link" shares the exact same state with anyone.
 */
export function SavedViews({ storageKey }: { storageKey: string }): JSX.Element {
  const pageKey = pageKeyFromStorageKey(storageKey);
  const queryClient = useQueryClient();
  const serverViews = useQuery({ queryKey: ["saved-views"], queryFn: api.savedViews, staleTime: 30_000 });
  const [searchParams, setSearchParams] = useSearchParams();
  const [open, setOpen] = useState(false);
  const [draftName, setDraftName] = useState("");
  const panelRef = useRef<HTMLDivElement | null>(null);
  const migratedRef = useRef(false);

  const views: SavedViewEntry[] = serverViews.data?.views?.[pageKey] ?? readLegacyLocalViews(storageKey);

  const persist = useMutation({
    mutationFn: (next: SavedViewEntry[]) => api.saveSavedViews(pageKey, next),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["saved-views"] }),
    onError: (_err, next) => {
      // Server unreachable: keep the views usable locally and say so once.
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        // storage full/blocked — nothing else to do
      }
      toast.error("Could not sync views to the server; kept locally");
    },
  });

  // One-time migration: pre-2.6 localStorage views move to the server.
  useEffect(() => {
    if (migratedRef.current || !serverViews.data) return;
    const serverHas = (serverViews.data.views?.[pageKey] ?? []).length > 0;
    const legacy = readLegacyLocalViews(storageKey);
    if (!serverHas && legacy.length > 0) {
      migratedRef.current = true;
      persist.mutate(legacy);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverViews.data, pageKey, storageKey]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const saveCurrent = (): void => {
    const name = draftName.trim();
    if (!name) return;
    const search = searchParams.toString();
    persist.mutate([...views.filter((view) => view.name !== name), { name, search }]);
    setDraftName("");
    toast.success(`Saved view "${name}"`);
  };

  const applyView = (view: SavedViewEntry): void => {
    // A view saved at default state has an empty search string; the pages'
    // URL→state effects skip empty URLs (mount guard), so force a run with a
    // sentinel — the canonicalization effect strips it right after.
    setSearchParams(new URLSearchParams(view.search || "reset=1"), { replace: false });
    setOpen(false);
  };

  const copyLink = async (): Promise<void> => {
    const url = `${window.location.origin}${window.location.pathname}${
      searchParams.toString() ? `?${searchParams.toString()}` : ""
    }`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied to clipboard");
    } catch {
      toast.error("Could not access the clipboard");
    }
  };

  return (
    <div className="relative" ref={panelRef}>
      <Button type="button" variant="secondary" size="sm" onClick={() => setOpen((prev) => !prev)}>
        <Bookmark className="size-3.5" aria-hidden />
        Views
      </Button>
      {open ? (
        <div className="absolute right-0 top-full z-50 mt-1 w-72 rounded-lg border border-border bg-popover p-2 shadow-lg">
          {views.length === 0 ? (
            <p className="px-1 py-2 text-xs text-muted-foreground">No saved views yet.</p>
          ) : (
            <ul className="mb-2 max-h-56 space-y-0.5 overflow-y-auto">
              {views.map((view) => (
                <li key={view.name} className="flex items-center gap-1">
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate rounded-md px-2 py-1.5 text-left text-sm text-foreground hover:bg-muted"
                    onClick={() => applyView(view)}
                  >
                    {view.name}
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete saved view ${view.name}`}
                    className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-critical"
                    onClick={() => persist.mutate(views.filter((entry) => entry.name !== view.name))}
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center gap-1.5 border-t border-border pt-2">
            <Input
              className="h-8 flex-1"
              placeholder="Name this view…"
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") saveCurrent();
              }}
            />
            <Button type="button" size="sm" onClick={saveCurrent} disabled={!draftName.trim()}>
              Save
            </Button>
          </div>
          <Button type="button" variant="ghost" size="sm" className="mt-1.5 w-full justify-start" onClick={() => void copyLink()}>
            <Link2 className="size-3.5" aria-hidden />
            Copy link to current view
          </Button>
        </div>
      ) : null}
    </div>
  );
}
