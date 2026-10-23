/** Integrations page sections in page order; the Setup side menu links to
    each one by its anchor. */
export const INTEGRATION_SECTIONS = [
  { title: "Sonarr and Radarr", label: "Sonarr and Radarr" },
  { title: "MyAnimeList API", label: "MyAnimeList" },
  { title: "Alert webhooks", label: "Alerts" },
  { title: "Authentication", label: "Sign-in" },
  { title: "Webhook shared secret", label: "Webhook secret" },
  { title: "Application logging", label: "Logging" },
] as const;

export function sectionAnchor(title: string): string {
  return `setup-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}
