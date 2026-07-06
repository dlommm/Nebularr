export function PageFallback(): JSX.Element {
  return (
    <div className="flex min-h-[220px] items-center justify-center p-6" aria-busy="true" aria-label="Loading page">
      <div className="flex items-center gap-2.5 text-muted-foreground">
        <span className="size-2 animate-pulse rounded-full bg-primary" />
        <span>Loading…</span>
      </div>
    </div>
  );
}
