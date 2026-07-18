import { GlassCard } from "@/components/nebula/GlassCard";
import { CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const SELECT_CLASS = "h-9 rounded-md border border-input bg-background px-2 text-sm";
export const TEXTAREA_CLASS =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/** Shared card shell for every Integrations page section. */
export function SectionCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <GlassCard glow="none">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </GlassCard>
  );
}
