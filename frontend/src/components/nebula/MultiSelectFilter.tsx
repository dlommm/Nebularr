import { useEffect, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

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
    menu (built on the shared shadcn dropdown-menu) offers search, checkbox
    options with real keyboard navigation, and a clear action. */
export function MultiSelectFilter({ options, selected, onChange, label, className }: MultiSelectFilterProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const filteredOptions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((option) => option.toLowerCase().includes(q));
  }, [options, query]);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const toggle = (value: string): void => {
    onChange(selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value]);
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        aria-label={`Filter ${label}`}
        data-active={selected.length > 0}
        className={cn(
          "inline-flex items-center gap-1 rounded-md border border-input bg-background px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground data-popup-open:bg-accent data-popup-open:text-accent-foreground",
          className,
        )}
      >
        <span className="truncate">{selected.length === 0 ? "All" : `${selected.length} selected`}</span>
        <ChevronDown className="size-3 shrink-0 opacity-60" aria-hidden />
      </DropdownMenuTrigger>
      {/* No aria-label here: base-ui already labels the menu via
          aria-labelledby pointing at the trigger (whose own aria-label is
          "Filter {label}"), and aria-labelledby wins over aria-label in
          accessible-name computation, so an explicit one here would be
          silently ignored. */}
      <DropdownMenuContent className="w-64 min-w-64 gap-0 p-0">
        <div className="border-b border-border p-1.5">
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            // Stop the menu's typeahead/roving-focus handling from
            // hijacking normal typing — but let Escape (close) and Enter
            // bubble so the menu's own keyboard handling still applies.
            onKeyDown={(event) => {
              if (event.key !== "Escape" && event.key !== "Enter") event.stopPropagation();
            }}
            placeholder="Search values…"
            aria-label={`Search ${label} values`}
            className="h-7 w-full rounded-md border border-input bg-background px-2 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring"
          />
        </div>
        <div className="max-h-56 overflow-y-auto p-1">
          {filteredOptions.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs text-muted-foreground">No matching values.</p>
          ) : (
            filteredOptions.map((option) => (
              <DropdownMenuCheckboxItem
                key={option}
                checked={selected.includes(option)}
                onCheckedChange={() => toggle(option)}
                closeOnClick={false}
                className="text-xs"
              >
                <span className="truncate" title={option.length > 60 ? option : undefined}>
                  {option.length > 60 ? `${option.slice(0, 60)}…` : option}
                </span>
              </DropdownMenuCheckboxItem>
            ))
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
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
