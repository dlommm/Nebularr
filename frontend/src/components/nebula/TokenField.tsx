import { useState } from "react";
import { X } from "lucide-react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * A list of short values entered as discrete chips rather than a
 * comma-separated string.
 *
 * The CSV inputs this replaces made the values look like one magic incantation
 * ("english, eng") when they are really a set — you could not tell how many
 * values you had, nor remove one without editing text mid-string.
 */
export function TokenField({
  id,
  label,
  hint,
  values,
  onChange,
  placeholder,
}: {
  id: string;
  label: string;
  hint?: string;
  values: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
}): JSX.Element {
  const [entry, setEntry] = useState("");

  const commit = (raw: string): void => {
    // Accept a pasted "a, b, c" in one go — splitting here means paste behaves
    // the way the old CSV field did, without the field itself being CSV.
    const additions = raw
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0 && !values.includes(value));
    if (additions.length > 0) onChange([...values, ...additions]);
    setEntry("");
  };

  const remove = (value: string): void => onChange(values.filter((item) => item !== value));

  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <div
        className={cn(
          "flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1.5",
          "focus-within:border-ring",
        )}
      >
        {values.map((value) => (
          <span
            key={value}
            className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-xs"
          >
            {value}
            <button
              type="button"
              aria-label={`Remove ${value}`}
              onClick={() => remove(value)}
              className="rounded-sm opacity-60 hover:opacity-100"
            >
              <X className="size-3" aria-hidden />
            </button>
          </span>
        ))}
        <input
          id={id}
          value={entry}
          placeholder={values.length === 0 ? placeholder : undefined}
          onChange={(event) => {
            // A typed comma is a commit, matching the muscle memory of the
            // CSV field it replaces.
            if (event.target.value.includes(",")) commit(event.target.value);
            else setEntry(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit(entry);
            } else if (event.key === "Backspace" && entry === "" && values.length > 0) {
              remove(values[values.length - 1]);
            }
          }}
          // Committing on blur means a half-typed value isn't silently lost
          // when the user tabs away or hits Save.
          onBlur={() => commit(entry)}
          className="min-w-24 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
