import * as React from "react";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type GlassCardProps = React.ComponentProps<typeof Card> & {
  /** Kept for API compatibility; the redesign uses one flat surface, so the
      glow variants render identically. */
  glow?: "none" | "cyan" | "violet" | "mixed";
};

export function GlassCard({ className, glow, children, ...props }: GlassCardProps): JSX.Element {
  void glow;
  return (
    <Card
      className={cn(
        "relative w-full min-w-0 overflow-hidden border-border bg-card shadow-[var(--shadow-card)]",
        className,
      )}
      {...props}
    >
      {children}
    </Card>
  );
}

export { CardHeader, CardTitle, CardDescription, CardContent, CardFooter };
export type { GlassCardProps };
