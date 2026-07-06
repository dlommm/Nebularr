import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { isEpisodeRecord, mediaDetailSections, mediaTitle } from "../../lib/mediaDetail";
import type { DetailField, MediaRecord } from "../../lib/mediaDetail";
import { StatusBadge } from "./StatusBadge";

function FieldRow({ field }: { field: DetailField }): JSX.Element {
  return (
    <div className="flex items-start justify-between gap-3 py-1">
      <span className="shrink-0 text-xs text-muted-foreground">{field.label}</span>
      {field.badges && field.badges.length > 0 ? (
        <span className="flex flex-wrap justify-end gap-1">
          {field.badges.map((badge) => (
            <Badge key={badge} variant="secondary" className="text-[0.6rem]">
              {badge}
            </Badge>
          ))}
        </span>
      ) : (
        <span className="min-w-0 break-all text-right text-xs text-foreground">{field.value}</span>
      )}
    </div>
  );
}

export function MediaDetailSheet({
  row,
  onClose,
}: {
  row: MediaRecord;
  onClose: () => void;
}): JSX.Element {
  const sections = mediaDetailSections(row);
  const status = isEpisodeRecord(row) ? row.series_status : row.status;
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        side="right"
        aria-label="Media details"
        className="w-full gap-0 overflow-y-auto border-border glass-panel-strong p-4 data-[side=right]:sm:max-w-md"
      >
        <SheetTitle className="mb-1 pr-8 text-sm leading-snug">{mediaTitle(row)}</SheetTitle>
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          {typeof status === "string" && status ? <StatusBadge status={status} className="text-[0.6rem]" /> : null}
          {row.monitored ? (
            <span className="text-[0.6rem] font-medium uppercase text-primary">monitored</span>
          ) : null}
        </div>
        <div className="space-y-4">
          {sections.map((section) => (
            <section key={section.title}>
              <h4 className="mb-1 border-b border-border pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {section.title}
              </h4>
              {section.fields.map((field) => (
                <FieldRow key={field.label} field={field} />
              ))}
            </section>
          ))}
          <details className="rounded-lg border border-border bg-muted/30 p-2">
            <summary className="cursor-pointer text-xs text-muted-foreground">Raw JSON</summary>
            <pre className="mt-2 max-h-72 overflow-auto rounded-md bg-muted/50 p-2 text-[11px] text-foreground/90">
              {JSON.stringify(row, null, 2)}
            </pre>
          </details>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** Two rows side by side; differing values are highlighted. */
export function MediaCompareGrid({ a, b }: { a: MediaRecord; b: MediaRecord }): JSX.Element {
  const sectionsA = mediaDetailSections(a);
  const sectionsB = mediaDetailSections(b);
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 text-sm font-medium">
        <p className="truncate">A: {mediaTitle(a)}</p>
        <p className="truncate">B: {mediaTitle(b)}</p>
      </div>
      {sectionsA.map((sectionA, sIdx) => (
        <section key={sectionA.title}>
          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {sectionA.title}
          </h4>
          {sectionA.fields.map((fieldA, fIdx) => {
            const fieldB = sectionsB[sIdx]?.fields[fIdx];
            const differs = fieldB != null && fieldA.value !== fieldB.value;
            const cellClass = differs
              ? "rounded bg-warn/10 px-1.5 py-0.5 text-xs text-foreground"
              : "px-1.5 py-0.5 text-xs text-foreground";
            return (
              <div key={fieldA.label} className="grid grid-cols-[7rem_1fr_1fr] items-baseline gap-2 py-0.5">
                <span className="text-xs text-muted-foreground">{fieldA.label}</span>
                <span className={`min-w-0 break-all ${cellClass}`}>{fieldA.value}</span>
                <span className={`min-w-0 break-all ${cellClass}`}>{fieldB?.value ?? "—"}</span>
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}
