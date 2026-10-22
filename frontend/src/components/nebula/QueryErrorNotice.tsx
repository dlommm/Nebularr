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
      className="flex flex-wrap items-center gap-3 border-y border-destructive/40 py-3 text-sm text-destructive"
    >
      <span>
        Could not load {label}: {error instanceof Error ? error.message : "unknown error"}
      </span>
      <Button size="sm" variant="outline" onClick={retry}>
        Retry
      </Button>
    </div>
  );
}
