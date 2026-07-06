import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { Bookmark, Link2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLocalStorageState } from "../../hooks";

type SavedView = {
  name: string;
  /** URL search string (without leading `?`) captured when the view was saved. */
  search: string;
};

/**
 * Named snapshots of the current page's URL search params. Because pages keep
 * their filter state in the URL, applying a view is just setting the params —
 * and "Copy link" shares the exact same state with anyone.
 */
export function SavedViews({ storageKey }: { storageKey: string }): JSX.Element {
  const [views, setViews] = useLocalStorageState<SavedView[]>(storageKey, []);
  const [searchParams, setSearchParams] = useSearchParams();
  const [open, setOpen] = useState(false);
  const [draftName, setDraftName] = useState("");
  const panelRef = useRef<HTMLDivElement | null>(null);

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
    setViews([...views.filter((view) => view.name !== name), { name, search }]);
    setDraftName("");
    toast.success(`Saved view "${name}"`);
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
                    onClick={() => {
                      setSearchParams(new URLSearchParams(view.search), { replace: false });
                      setOpen(false);
                    }}
                  >
                    {view.name}
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete saved view ${view.name}`}
                    className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-critical"
                    onClick={() => setViews(views.filter((entry) => entry.name !== view.name))}
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
