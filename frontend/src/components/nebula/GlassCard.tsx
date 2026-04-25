import * as React from "react";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type GlassCardProps = React.ComponentProps<typeof Card> & {
  /** Soft multi-stop glow behind the card */
  glow?: "none" | "cyan" | "violet" | "mixed";
};

const glowMap: Record<NonNullable<GlassCardProps["glow"]>, string> = {
  none: "",
  cyan: "before:pointer-events-none before:absolute before:inset-[-1px] before:rounded-xl before:bg-[radial-gradient(60%_80%_at_10%_0%,rgba(84,168,255,0.2),transparent_60%)] before:content-['']",
  violet:
    "before:pointer-events-none before:absolute before:inset-[-1px] before:rounded-xl before:bg-[radial-gradient(50%_70%_at_90%_0%,rgba(157,92,255,0.18),transparent_55%)] before:content-['']",
  mixed:
    "before:pointer-events-none before:absolute before:inset-[-1px] before:rounded-xl before:bg-[radial-gradient(50%_80%_at_15%_0%,rgba(84,168,255,0.16),transparent_55%),radial-gradient(45%_70%_at_85%_0%,rgba(108,124,255,0.2),transparent_55%)] before:content-['']",
};

export function GlassCard({ className, glow = "mixed", children, ...props }: GlassCardProps): JSX.Element {
  return (
    <Card
      className={cn(
        "relative w-full min-w-0 overflow-hidden border-white/10 bg-card/80 shadow-[0_8px_32px_rgba(0,0,0,0.25)] backdrop-blur-xl",
        glowMap[glow],
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
