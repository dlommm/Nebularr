import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

const PANEL_MIN_WIDTH = 240;
const PANEL_MAX_HEIGHT = 320;

type MultiSelectFilterProps = {
  /** Distinct values to offer; rendered in the given order. */
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
  /** Accessible name for the control, e.g. the column it filters. */
  label: string;
  /** Extra classes for the trigger button. */
  className?: string;
};

/** Compact multi-select dropdown: trigger shows "All" or "N selected"; the
    panel (portaled so overflow/scroll containers cannot clip it) offers
    search, checkbox options, and a clear action. */
export function MultiSelectFilter({ options, selected, onChange, label, className }: MultiSelectFilterProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);

  const filteredOptions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((option) => option.toLowerCase().includes(q));
  }, [options, query]);

  const place = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.max(rect.width, PANEL_MIN_WIDTH);
    const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8));
    const spaceBelow = window.innerHeight - rect.bottom;
    const top =
      spaceBelow >= PANEL_MAX_HEIGHT + 12 || rect.top < PANEL_MAX_HEIGHT + 12
        ? rect.bottom + 4
        : rect.top - PANEL_MAX_HEIGHT - 4;
    setPos({ top, left, width });
  }, []);

  useEffect(() => {
    if (!open) return;
    place();
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const toggle = (value: string): void => {
    onChange(selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value]);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Filter ${label}`}
        data-active={selected.length > 0}
        className={className}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="truncate">{selected.length === 0 ? "All" : `${selected.length} selected`}</span>
        <ChevronDown className="size-3 shrink-0 opacity-60" aria-hidden />
      </button>
      {open && pos
        ? createPortal(
            <div
              ref={panelRef}
              role="listbox"
              aria-multiselectable="true"
              aria-label={`${label} values`}
              style={{ position: "fixed", top: pos.top, left: pos.left, width: pos.width, zIndex: 60 }}
              className="flex flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-xl"
            >
              <div className="border-b border-border p-1.5">
                <input
                  autoFocus
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search values…"
                  aria-label={`Search ${label} values`}
                  className="h-7 w-full rounded-md border border-input bg-background px-2 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring"
                />
              </div>
              <div className="max-h-56 overflow-y-auto p-1" style={{ maxHeight: PANEL_MAX_HEIGHT - 90 }}>
                {filteredOptions.length === 0 ? (
                  <p className="px-2 py-3 text-center text-xs text-muted-foreground">No matching values.</p>
                ) : (
                  filteredOptions.map((option) => {
                    const checked = selected.includes(option);
                    return (
                      <button
                        key={option}
                        type="button"
                        role="option"
                        aria-selected={checked}
                        title={option.length > 60 ? option : undefined}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent",
                          checked ? "text-foreground" : "text-muted-foreground",
                        )}
                        onClick={() => toggle(option)}
                      >
                        <span
                          className={cn(
                            "flex size-3.5 shrink-0 items-center justify-center rounded-sm border",
                            checked ? "border-primary bg-primary text-primary-foreground" : "border-input",
                          )}
                          aria-hidden
                        >
                          {checked ? <Check className="size-2.5" strokeWidth={3} /> : null}
                        </span>
                        <span className="truncate">{option.length > 60 ? `${option.slice(0, 60)}…` : option}</span>
                      </button>
                    );
                  })
                )}
              </div>
              <div className="flex items-center justify-between gap-2 border-t border-border px-2 py-1.5 text-xs text-muted-foreground">
                <span>
                  {selected.length} of {options.length} selected
                </span>
                <button
                  type="button"
                  className="rounded-md px-1.5 py-0.5 font-medium text-primary hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
                  disabled={selected.length === 0}
                  onClick={() => onChange([])}
                >
                  Clear
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
