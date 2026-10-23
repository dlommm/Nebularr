import { cn } from "@/lib/utils";
import { sectionAnchor } from "./sections";

export const SELECT_CLASS = "min-h-10 rounded-sm border border-border bg-muted px-2.5 text-sm text-foreground";
export const TEXTAREA_CLASS =
  "w-full rounded-sm border border-border bg-muted px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/** Shared shell for every Integrations page section: a condensed heading on a
    hairline, no card. */
export function SectionCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}): JSX.Element {
  const id = sectionAnchor(title);
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-24 border-t border-border pt-6 pb-10 first:border-t-0 first:pt-0">
      <h2 id={`${id}-title`} className="cond text-[30px] leading-none font-bold">
        {title}
      </h2>
      {description ? <p className="mt-2.5 max-w-2xl text-[13px] leading-relaxed text-muted-foreground">{description}</p> : null}
      <div className="mt-5 space-y-4">{children}</div>
    </section>
  );
}

/** One line of state at the top of a section: coloured dot and plain words,
    in place of boxed badges. */
export function SectionState({
  items,
}: {
  items: { label: string; tone?: "ok" | "warn" | "critical" | "muted" }[];
}): JSX.Element {
  return (
    <p className="flex flex-wrap gap-x-5 gap-y-1 text-[13px]">
      {items.map(({ label, tone = "muted" }) => (
        <span
          key={label}
          className={cn(
            "inline-flex items-center gap-2 before:size-2 before:shrink-0 before:rounded-full before:bg-current",
            tone === "ok" && "text-ok",
            tone === "warn" && "text-warn",
            tone === "critical" && "text-critical",
            tone === "muted" && "text-muted-foreground",
          )}
        >
          {label}
        </span>
      ))}
    </p>
  );
}

export const CHECK_ROW_CLASS = "flex min-h-11 items-center gap-2.5";
export const CHECK_LABEL_CLASS = "text-sm font-normal";
export const FIELD_LABEL_CLASS = "text-xs text-muted-foreground";
