import type { HealthDimensions } from "@/types";

export const DIM_LABELS: Record<keyof HealthDimensions, string> = {
  webhooks: "Queues",
  sync: "Sync",
  integrations: "Arr",
  mal: "MAL",
};
