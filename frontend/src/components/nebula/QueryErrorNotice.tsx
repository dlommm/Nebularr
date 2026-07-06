import { Button } from "@/components/ui/button";

export function QueryErrorNotice({
  label,
  retry,
  error,
}: {
  label: string;
  retry: () => void;
  error: unknown;
}): JSX.Element {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm"
    >
      <span>
        Could not load {label}: {error instanceof Error ? error.message : "unknown error"}
      </span>
      <Button size="sm" variant="secondary" onClick={retry}>
        Retry
      </Button>
    </div>
  );
}
