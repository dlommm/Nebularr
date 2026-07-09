import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { usePageTitle } from "../hooks/usePageTitle";
import { fmtDate } from "../hooks";
import { useActionError } from "../hooks/useActionError";
import { GlassCard } from "@/components/nebula/GlassCard";
import { QueryErrorNotice } from "@/components/nebula/QueryErrorNotice";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const SELECT_CLASS = "h-9 rounded-md border border-input bg-background px-2 text-sm";
const TEXTAREA_CLASS =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

type IntegrationDraft = { base_url: string; api_key: string; enabled: boolean; webhook_enabled: boolean };

function SectionCard({
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

export function IntegrationsPage(): JSX.Element {
  usePageTitle("Integrations");
  const queryClient = useQueryClient();
  const { setError, runAction } = useActionError();

  const integrations = useQuery({ queryKey: ["integrations"], queryFn: api.integrations });
  const malConfig = useQuery({ queryKey: ["mal-config"], queryFn: api.malConfig });
  const loggingConfig = useQuery({ queryKey: ["logging-config"], queryFn: api.loggingConfig });
  const webhookConfig = useQuery({ queryKey: ["webhook-config"], queryFn: api.webhookConfig });
  const alertWebhookConfig = useQuery({ queryKey: ["alert-webhook-config"], queryFn: api.alertWebhookConfig });
  const authStatus = useQuery({ queryKey: ["auth-status"], queryFn: api.authStatus });

  const [integrationDrafts, setIntegrationDrafts] = useState<Record<string, IntegrationDraft>>({});
  const [webhookSecretInput, setWebhookSecretInput] = useState("");
  const [authPasswordInput, setAuthPasswordInput] = useState("");
  const [authPasswordConfirm, setAuthPasswordConfirm] = useState("");
  const [issuedApiToken, setIssuedApiToken] = useState("");
  const [malClientIdInput, setMalClientIdInput] = useState("");
  const [malClearClientId, setMalClearClientId] = useState(false);
  const [malIngestEnabled, setMalIngestEnabled] = useState(false);
  const [malMatcherEnabled, setMalMatcherEnabled] = useState(false);
  const [malTaggingEnabled, setMalTaggingEnabled] = useState(false);
  const [malAllowTitleYearMatch, setMalAllowTitleYearMatch] = useState(false);
  const [malSourceMalDubsEnabled, setMalSourceMalDubsEnabled] = useState(true);
  const [malSourceMydublistEnabled, setMalSourceMydublistEnabled] = useState(true);
  const [malCoverageTaggingEnabled, setMalCoverageTaggingEnabled] = useState(false);
  const [malMydublistTier, setMalMydublistTier] = useState("normal");
  const [loggingLevelChoice, setLoggingLevelChoice] = useState<string>("INFO");
  const [loggingUseEnvDefault, setLoggingUseEnvDefault] = useState(false);
  const [alertWebhookDraft, setAlertWebhookDraft] = useState<{
    webhookUrlsText: string;
    clearUrls: boolean;
    timeoutSeconds: number;
    minState: "warning" | "critical";
    notifyRecovery: boolean;
    events: { health: boolean; sync_failure: boolean; dead_letter: boolean };
  }>({
    webhookUrlsText: "",
    clearUrls: false,
    timeoutSeconds: 10,
    minState: "warning",
    notifyRecovery: true,
    events: { health: true, sync_failure: true, dead_letter: true },
  });
  const [alertEmailDraft, setAlertEmailDraft] = useState<{
    enabled: boolean;
    host: string;
    port: number;
    username: string;
    password: string;
    fromAddress: string;
    toAddressesText: string;
    starttls: boolean;
  }>({
    enabled: false,
    host: "",
    port: 587,
    username: "",
    password: "",
    fromAddress: "",
    toAddressesText: "",
    starttls: true,
  });

  useEffect(() => {
    if (!integrations.data) return;
    const next: Record<string, IntegrationDraft> = {};
    integrations.data.forEach((row) => {
      next[`${row.source}:${row.name}`] = {
        base_url: row.base_url ?? "",
        api_key: "",
        enabled: row.enabled,
        webhook_enabled: row.webhook_enabled,
      };
    });
    setIntegrationDrafts(next);
  }, [integrations.data]);

  useEffect(() => {
    if (!loggingConfig.data) return;
    setLoggingLevelChoice(loggingConfig.data.effective_level);
  }, [loggingConfig.data]);

  useEffect(() => {
    if (!malConfig.data) return;
    setMalIngestEnabled(Boolean(malConfig.data.ingest_enabled));
    setMalMatcherEnabled(Boolean(malConfig.data.matcher_enabled));
    setMalTaggingEnabled(Boolean(malConfig.data.tagging_enabled));
    setMalAllowTitleYearMatch(Boolean(malConfig.data.allow_title_year_match));
    setMalSourceMalDubsEnabled(Boolean(malConfig.data.source_mal_dubs_enabled));
    setMalSourceMydublistEnabled(Boolean(malConfig.data.source_mydublist_enabled));
    setMalCoverageTaggingEnabled(Boolean(malConfig.data.coverage_tagging_enabled));
    setMalMydublistTier(malConfig.data.mydublist_tier || "normal");
  }, [malConfig.data]);

  useEffect(() => {
    if (!alertWebhookConfig.data) return;
    setAlertWebhookDraft((prev) => ({
      ...prev,
      timeoutSeconds: alertWebhookConfig.data.timeout_seconds,
      minState: alertWebhookConfig.data.min_state,
      notifyRecovery: alertWebhookConfig.data.notify_recovery,
      events: alertWebhookConfig.data.events ?? prev.events,
    }));
    const email = alertWebhookConfig.data.email;
    if (email) {
      setAlertEmailDraft((prev) => ({
        ...prev,
        enabled: email.enabled,
        host: email.host,
        port: email.port,
        username: email.username,
        fromAddress: email.from_address,
        toAddressesText: email.to_addresses.join(", "),
        starttls: email.starttls,
      }));
    }
  }, [alertWebhookConfig.data]);

  const updateDraft = (key: string, fallback: IntegrationDraft, patch: Partial<IntegrationDraft>): void => {
    setIntegrationDrafts((prev) => ({
      ...prev,
      [key]: { ...(prev[key] ?? fallback), ...patch },
    }));
  };

  const saveIntegration = async (source: string, name: string): Promise<void> => {
    const key = `${source}:${name}`;
    const draft = integrationDrafts[key];
    if (!draft) return;
    await runAction(
      async () => {
        await api.saveIntegration(source, {
          name,
          base_url: draft.base_url,
          api_key: draft.api_key,
          enabled: draft.enabled,
          webhook_enabled: draft.webhook_enabled,
        });
        await queryClient.invalidateQueries({ queryKey: ["integrations"] });
      },
      `save integration ${source}/${name}`,
    );
  };

  const savePassword = async (): Promise<void> => {
    if (authPasswordInput.length < 8) {
      setError("Password must be at least 8 characters", "save admin password");
      return;
    }
    if (authPasswordInput !== authPasswordConfirm) {
      setError("Passwords do not match", "save admin password");
      return;
    }
    await runAction(
      async () => {
        await api.saveAuthConfig({ password: authPasswordInput, enabled: true });
        // Sign in with the new password so the session cookie exists before the next request.
        await api.authLogin(authPasswordInput);
        setAuthPasswordInput("");
        setAuthPasswordConfirm("");
        await queryClient.invalidateQueries({ queryKey: ["auth-status"] });
      },
      "save admin password",
    );
  };

  const setAuthEnabled = async (enabled: boolean): Promise<void> => {
    await runAction(
      async () => {
        await api.saveAuthConfig({ enabled });
        await queryClient.invalidateQueries({ queryKey: ["auth-status"] });
      },
      enabled ? "enable authentication" : "disable authentication",
    );
  };

  const rotateApiToken = async (): Promise<void> => {
    await runAction(
      async () => {
        const result = await api.saveAuthConfig({ rotate_api_token: true });
        setIssuedApiToken(result.api_token ?? "");
        await queryClient.invalidateQueries({ queryKey: ["auth-status"] });
      },
      "generate API token",
    );
  };

  const revokeApiToken = async (): Promise<void> => {
    await runAction(
      async () => {
        await api.saveAuthConfig({ revoke_api_token: true });
        setIssuedApiToken("");
        await queryClient.invalidateQueries({ queryKey: ["auth-status"] });
      },
      "revoke API token",
    );
  };

  const saveLoggingConfig = async (): Promise<void> => {
    await runAction(
      async () => {
        if (loggingUseEnvDefault) {
          await api.saveLoggingConfig({ use_environment_default: true });
        } else {
          await api.saveLoggingConfig({ level: loggingLevelChoice });
        }
        setLoggingUseEnvDefault(false);
        await queryClient.invalidateQueries({ queryKey: ["logging-config"] });
      },
      "save logging level",
    );
  };

  const saveMalConfig = async (): Promise<void> => {
    const changingClientId = malClearClientId || Boolean(malClientIdInput.trim());
    if (!changingClientId && !malConfig.data) {
      setError("MAL settings are still loading. Please try again.", "save MyAnimeList settings");
      return;
    }
    if (!changingClientId && malConfig.data) {
      const toggleChanged =
        malIngestEnabled !== Boolean(malConfig.data.ingest_enabled) ||
        malMatcherEnabled !== Boolean(malConfig.data.matcher_enabled) ||
        malTaggingEnabled !== Boolean(malConfig.data.tagging_enabled) ||
        malAllowTitleYearMatch !== Boolean(malConfig.data.allow_title_year_match) ||
        malSourceMalDubsEnabled !== Boolean(malConfig.data.source_mal_dubs_enabled) ||
        malSourceMydublistEnabled !== Boolean(malConfig.data.source_mydublist_enabled) ||
        malCoverageTaggingEnabled !== Boolean(malConfig.data.coverage_tagging_enabled) ||
        malMydublistTier !== (malConfig.data.mydublist_tier || "normal");
      if (!toggleChanged) {
        setError("Make a change before saving.", "save MyAnimeList settings");
        return;
      }
    }
    if (changingClientId && !malClearClientId && !malClientIdInput.trim()) {
      setError("Enter a MyAnimeList client ID, or check remove stored ID to clear.", "save MyAnimeList client ID");
      return;
    }
    await runAction(
      async () => {
        await api.saveMalConfig({
          clear_client_id: malClearClientId,
          ingest_enabled: malIngestEnabled,
          matcher_enabled: malMatcherEnabled,
          tagging_enabled: malTaggingEnabled,
          allow_title_year_match: malAllowTitleYearMatch,
          source_mal_dubs_enabled: malSourceMalDubsEnabled,
          source_mydublist_enabled: malSourceMydublistEnabled,
          coverage_tagging_enabled: malCoverageTaggingEnabled,
          mydublist_tier: malMydublistTier,
          ...(malClearClientId ? {} : { client_id: malClientIdInput.trim() }),
        });
        setMalClientIdInput("");
        setMalClearClientId(false);
        await queryClient.invalidateQueries({ queryKey: ["mal-config"] });
      },
      "save MyAnimeList settings",
    );
  };

  const saveWebhookSecret = async (): Promise<void> => {
    if (!webhookSecretInput.trim()) {
      setError("Webhook secret cannot be empty", "save webhook secret");
      return;
    }
    await runAction(
      async () => {
        await api.saveWebhookConfig(webhookSecretInput.trim());
        setWebhookSecretInput("");
        await queryClient.invalidateQueries({ queryKey: ["webhook-config"] });
      },
      "save webhook secret",
    );
  };

  const saveAlertWebhooks = async (): Promise<void> => {
    await runAction(
      async () => {
        const payload: Parameters<typeof api.saveAlertWebhookConfig>[0] = {
          timeout_seconds: alertWebhookDraft.timeoutSeconds,
          min_state: alertWebhookDraft.minState,
          notify_recovery: alertWebhookDraft.notifyRecovery,
          events: alertWebhookDraft.events,
          email: {
            enabled: alertEmailDraft.enabled,
            host: alertEmailDraft.host.trim(),
            port: alertEmailDraft.port,
            username: alertEmailDraft.username.trim(),
            from_address: alertEmailDraft.fromAddress.trim(),
            to_addresses: alertEmailDraft.toAddressesText
              .split(/[\n,]/)
              .map((address) => address.trim())
              .filter(Boolean),
            starttls: alertEmailDraft.starttls,
            // Blank means "keep the stored password".
            ...(alertEmailDraft.password ? { password: alertEmailDraft.password } : {}),
          },
        };
        const normalizedUrls = alertWebhookDraft.webhookUrlsText.trim();
        if (alertWebhookDraft.clearUrls) {
          payload.clear_urls = true;
        } else if (normalizedUrls) {
          payload.webhook_urls = normalizedUrls;
        }
        await api.saveAlertWebhookConfig(payload);
        setAlertWebhookDraft((prev) => ({
          ...prev,
          webhookUrlsText: "",
          clearUrls: false,
        }));
        setAlertEmailDraft((prev) => ({ ...prev, password: "" }));
        await queryClient.invalidateQueries({ queryKey: ["alert-webhook-config"] });
      },
      "save alert webhooks",
    );
  };

  return (
    <div className="space-y-6">
      <SectionCard
        title="Authentication"
        description="Protects every API endpoint with a login. API automation can use a bearer token instead."
      >
        <div className="flex flex-wrap gap-2">
          <Badge variant={authStatus.data?.enabled ? "default" : "destructive"}>
            {authStatus.data?.enabled ? "authentication enabled" : "authentication disabled"}
          </Badge>
          <Badge variant="outline">{authStatus.data?.password_set ? "password set" : "no password set"}</Badge>
          <Badge variant="outline">{authStatus.data?.api_token_set ? "API token issued" : "no API token"}</Badge>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="grid w-full gap-1.5">
            <Label htmlFor="auth-password" className="text-xs text-muted-foreground">
              {authStatus.data?.password_set ? "New admin password (min 8 chars)" : "Set admin password (min 8 chars)"}
            </Label>
            <Input
              id="auth-password"
              type="password"
              autoComplete="new-password"
              value={authPasswordInput}
              onChange={(event) => setAuthPasswordInput(event.target.value)}
            />
          </div>
          <div className="grid w-full gap-1.5">
            <Label htmlFor="auth-password-confirm" className="text-xs text-muted-foreground">
              Confirm password
            </Label>
            <Input
              id="auth-password-confirm"
              type="password"
              autoComplete="new-password"
              value={authPasswordConfirm}
              onChange={(event) => setAuthPasswordConfirm(event.target.value)}
            />
          </div>
          <Button type="button" className="shrink-0" onClick={() => void savePassword()}>
            {authStatus.data?.password_set ? "Change password & enable" : "Set password & enable"}
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={() => void rotateApiToken()}>
            {authStatus.data?.api_token_set ? "Rotate API token" : "Generate API token"}
          </Button>
          {authStatus.data?.api_token_set ? (
            <Button type="button" variant="secondary" size="sm" onClick={() => void revokeApiToken()}>
              Revoke API token
            </Button>
          ) : null}
          {authStatus.data?.enabled ? (
            <Button type="button" variant="destructive" size="sm" onClick={() => void setAuthEnabled(false)}>
              Disable authentication
            </Button>
          ) : null}
        </div>
        {issuedApiToken ? (
          <div className="rounded-lg border border-warn/35 bg-warn/10 px-4 py-3 text-sm">
            <p className="text-muted-foreground">
              Copy this token now — it is shown only once. Send it as <code>Authorization: Bearer …</code>
            </p>
            <code className="mt-1 block break-all">{issuedApiToken}</code>
          </div>
        ) : null}
      </SectionCard>

      <SectionCard title="Integrations" description="Sonarr and Radarr connections used for library sync and tagging.">
        {integrations.isLoading ? <Skeleton className="h-32 w-full" /> : null}
        {integrations.isError ? (
          <QueryErrorNotice label="integrations" retry={() => void integrations.refetch()} error={integrations.error} />
        ) : null}
        {(integrations.data ?? []).map((row) => {
          const key = `${row.source}:${row.name}`;
          const fallback: IntegrationDraft = {
            base_url: row.base_url,
            api_key: "",
            enabled: row.enabled,
            webhook_enabled: row.webhook_enabled,
          };
          return (
            <div className="rounded-xl border border-border bg-muted/40 p-4" key={key}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">
                  {row.source}/{row.name}
                </span>
                <Badge variant={row.api_key_set ? "outline" : "destructive"}>
                  {row.api_key_set ? "API key set" : "API key missing"}
                </Badge>
                <Badge variant="outline">{row.enabled ? "enabled" : "disabled"}</Badge>
                <span className="ml-auto text-xs text-muted-foreground">Updated {fmtDate(row.updated_at)}</span>
              </div>
              <div className="mt-3 flex flex-col gap-3 sm:flex-row">
                <div className="grid w-full gap-1.5">
                  <Label htmlFor={`integration-url-${key}`} className="text-xs text-muted-foreground">
                    Base URL
                  </Label>
                  <Input
                    id={`integration-url-${key}`}
                    value={integrationDrafts[key]?.base_url ?? row.base_url}
                    onChange={(event) => updateDraft(key, fallback, { base_url: event.target.value })}
                  />
                </div>
                <div className="grid w-full gap-1.5">
                  <Label htmlFor={`integration-key-${key}`} className="text-xs text-muted-foreground">
                    New API key (optional)
                  </Label>
                  <Input
                    id={`integration-key-${key}`}
                    type="password"
                    autoComplete="off"
                    value={integrationDrafts[key]?.api_key ?? ""}
                    onChange={(event) => updateDraft(key, fallback, { api_key: event.target.value })}
                  />
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-4">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id={`integration-enabled-${key}`}
                    checked={integrationDrafts[key]?.enabled ?? row.enabled}
                    onCheckedChange={(checked) => updateDraft(key, fallback, { enabled: checked === true })}
                  />
                  <Label htmlFor={`integration-enabled-${key}`} className="text-sm text-muted-foreground">
                    enabled
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id={`integration-webhook-${key}`}
                    checked={integrationDrafts[key]?.webhook_enabled ?? row.webhook_enabled}
                    onCheckedChange={(checked) => updateDraft(key, fallback, { webhook_enabled: checked === true })}
                  />
                  <Label htmlFor={`integration-webhook-${key}`} className="text-sm text-muted-foreground">
                    webhook enabled
                  </Label>
                </div>
                <Button type="button" variant="secondary" size="sm" onClick={() => void saveIntegration(row.source, row.name)}>
                  Save
                </Button>
              </div>
            </div>
          );
        })}
      </SectionCard>

      <SectionCard
        title="MyAnimeList API"
        description="Stored in the database when set here (persists across restarts). MAL_CLIENT_ID from the environment is used if nothing is stored."
      >
        {malConfig.isError ? (
          <QueryErrorNotice label="MAL settings" retry={() => void malConfig.refetch()} error={malConfig.error} />
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline">
            {malConfig.data?.client_id_configured
              ? "client ID stored in database"
              : malConfig.data?.env_fallback_configured
                ? "using MAL_CLIENT_ID from environment"
                : "client ID not configured"}
          </Badge>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="grid w-full gap-1.5">
            <Label htmlFor="mal-client-id" className="text-xs text-muted-foreground">
              MyAnimeList API client ID (from myanimelist.net/apiconfig)
            </Label>
            <Input
              id="mal-client-id"
              type="password"
              autoComplete="off"
              value={malClientIdInput}
              onChange={(event) => setMalClientIdInput(event.target.value)}
            />
          </div>
          <Button type="button" variant="secondary" className="shrink-0" onClick={() => void saveMalConfig()}>
            Save
          </Button>
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {(
            [
              ["mal-clear-client-id", "remove stored client ID (fall back to environment only)", malClearClientId, setMalClearClientId],
              ["mal-ingest", "enable MAL ingest scheduler", malIngestEnabled, setMalIngestEnabled],
              ["mal-matcher", "enable MAL matcher scheduler", malMatcherEnabled, setMalMatcherEnabled],
              ["mal-tagging", "enable MAL tag sync scheduler", malTaggingEnabled, setMalTaggingEnabled],
              [
                "mal-title-year",
                "allow title+year fallback matching (when ID linking is unavailable)",
                malAllowTitleYearMatch,
                setMalAllowTitleYearMatch,
              ],
              ["mal-source-mal-dubs", "use MAL-Dubs as a dub-list source", malSourceMalDubsEnabled, setMalSourceMalDubsEnabled],
              [
                "mal-source-mydublist",
                "use MyDubList as a dub-list source (CC BY 4.0)",
                malSourceMydublistEnabled,
                setMalSourceMydublistEnabled,
              ],
              [
                "mal-coverage-tagging",
                "enable coverage tag sync scheduler (fully-english / partial-english from your files)",
                malCoverageTaggingEnabled,
                setMalCoverageTaggingEnabled,
              ],
            ] as const
          ).map(([id, label, checked, setter]) => (
            <div className="flex items-center gap-2" key={id}>
              <Checkbox id={id} checked={checked} onCheckedChange={(value) => setter(value === true)} />
              <Label htmlFor={id} className="text-sm text-muted-foreground">
                {label}
              </Label>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Label htmlFor="mal-mydublist-tier" className="text-xs text-muted-foreground">
            MyDubList confidence tier (how many of its sources must agree a dub exists)
          </Label>
          <select
            id="mal-mydublist-tier"
            aria-label="MyDubList confidence tier"
            className={SELECT_CLASS}
            value={malMydublistTier}
            disabled={!malSourceMydublistEnabled}
            onChange={(event) => setMalMydublistTier(event.target.value)}
          >
            {(["low", "normal", "high", "very-high"] as const).map((tier) => (
              <option key={tier} value={tier}>
                {tier}
              </option>
            ))}
          </select>
        </div>
      </SectionCard>

      <SectionCard title="Application logging">
        {loggingConfig.isError ? (
          <QueryErrorNotice label="logging settings" retry={() => void loggingConfig.refetch()} error={loggingConfig.error} />
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">effective: {loggingConfig.data?.effective_level ?? "…"}</Badge>
          <span className="text-xs text-muted-foreground">
            {loggingConfig.data?.stored_level
              ? "Level stored in database (overrides LOG_LEVEL at startup and when changed here)."
              : `No database override; using process LOG_LEVEL (${loggingConfig.data?.environment_default ?? "…"}) until you save a level below.`}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <select
            aria-label="Log level"
            className={SELECT_CLASS}
            value={loggingLevelChoice}
            disabled={loggingUseEnvDefault}
            onChange={(event) => setLoggingLevelChoice(event.target.value)}
          >
            {(["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"] as const).map((lvl) => (
              <option key={lvl} value={lvl}>
                {lvl}
              </option>
            ))}
          </select>
          <Button type="button" variant="secondary" size="sm" onClick={() => void saveLoggingConfig()}>
            Apply log level
          </Button>
          <div className="flex items-center gap-2">
            <Checkbox
              id="logging-env-default"
              checked={loggingUseEnvDefault}
              onCheckedChange={(checked) => setLoggingUseEnvDefault(checked === true)}
            />
            <Label htmlFor="logging-env-default" className="text-sm text-muted-foreground">
              on save, clear database override and use LOG_LEVEL from the environment
            </Label>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Webhook shared secret" description="Sonarr/Radarr must send this value in the x-arr-shared-secret header.">
        {webhookConfig.isError ? (
          <QueryErrorNotice label="webhook settings" retry={() => void webhookConfig.refetch()} error={webhookConfig.error} />
        ) : null}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <Badge variant={webhookConfig.data?.secret_set ? "outline" : "destructive"} className="self-start sm:self-center">
            {webhookConfig.data?.secret_set ? "secret set" : "secret missing"}
          </Badge>
          <div className="grid w-full gap-1.5">
            <Label htmlFor="webhook-secret" className="text-xs text-muted-foreground">
              Set new webhook shared secret
            </Label>
            <Input
              id="webhook-secret"
              type="password"
              autoComplete="off"
              value={webhookSecretInput}
              onChange={(event) => setWebhookSecretInput(event.target.value)}
            />
          </div>
          <Button type="button" variant="secondary" className="shrink-0" onClick={() => void saveWebhookSecret()}>
            Save secret
          </Button>
        </div>
      </SectionCard>

      <SectionCard
        title="Alert webhooks"
        description="Health alerts POST to these URLs. Stored in the database; encrypted when an encryption key is configured."
      >
        {alertWebhookConfig.isError ? (
          <QueryErrorNotice
            label="alert webhook settings"
            retry={() => void alertWebhookConfig.refetch()}
            error={alertWebhookConfig.error}
          />
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline">
            {alertWebhookConfig.data?.urls_configured
              ? `${alertWebhookConfig.data.url_count} webhook URL${alertWebhookConfig.data.url_count === 1 ? "" : "s"} configured`
              : "no webhook URLs configured"}
          </Badge>
        </div>
        <textarea
          rows={4}
          aria-label="Alert webhook URLs"
          className={TEXTAREA_CLASS}
          placeholder="Paste webhook URLs (one per line or comma-separated). Leave blank to keep existing URLs."
          value={alertWebhookDraft.webhookUrlsText}
          onChange={(event) =>
            setAlertWebhookDraft((prev) => ({
              ...prev,
              webhookUrlsText: event.target.value,
            }))
          }
        />
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex items-center gap-2 pb-2">
            <Checkbox
              id="alert-clear-urls"
              checked={alertWebhookDraft.clearUrls}
              onCheckedChange={(checked) =>
                setAlertWebhookDraft((prev) => ({
                  ...prev,
                  clearUrls: checked === true,
                }))
              }
            />
            <Label htmlFor="alert-clear-urls" className="text-sm text-muted-foreground">
              clear stored webhook URLs
            </Label>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="alert-min-state" className="text-xs text-muted-foreground">
              minimum state
            </Label>
            <select
              id="alert-min-state"
              className={SELECT_CLASS}
              value={alertWebhookDraft.minState}
              onChange={(event) =>
                setAlertWebhookDraft((prev) => ({
                  ...prev,
                  minState: event.target.value as "warning" | "critical",
                }))
              }
            >
              <option value="warning">warning</option>
              <option value="critical">critical</option>
            </select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="alert-timeout" className="text-xs text-muted-foreground">
              timeout (seconds)
            </Label>
            <Input
              id="alert-timeout"
              type="number"
              min={1}
              step={1}
              className="w-28"
              value={alertWebhookDraft.timeoutSeconds}
              onChange={(event) =>
                setAlertWebhookDraft((prev) => ({
                  ...prev,
                  timeoutSeconds: Number(event.target.value || 0),
                }))
              }
            />
          </div>
          <div className="flex items-center gap-2 pb-2">
            <Checkbox
              id="alert-notify-recovery"
              checked={alertWebhookDraft.notifyRecovery}
              onCheckedChange={(checked) =>
                setAlertWebhookDraft((prev) => ({
                  ...prev,
                  notifyRecovery: checked === true,
                }))
              }
            />
            <Label htmlFor="alert-notify-recovery" className="text-sm text-muted-foreground">
              notify on recovery to ok
            </Label>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <span className="text-xs text-muted-foreground">Send notifications for</span>
          {(
            [
              ["health", "health changes"],
              ["sync_failure", "sync failures"],
              ["dead_letter", "dead-letter jobs"],
            ] as const
          ).map(([key, label]) => (
            <div className="flex items-center gap-2" key={key}>
              <Checkbox
                id={`alert-event-${key}`}
                checked={alertWebhookDraft.events[key]}
                onCheckedChange={(checked) =>
                  setAlertWebhookDraft((prev) => ({
                    ...prev,
                    events: { ...prev.events, [key]: checked === true },
                  }))
                }
              />
              <Label htmlFor={`alert-event-${key}`} className="text-sm text-muted-foreground">
                {label}
              </Label>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Discord, Slack, and ntfy URLs get native formatting automatically (use <code className="rounded bg-muted px-1">ntfy://host/topic</code>{" "}
          for self-hosted ntfy); other URLs receive a generic JSON payload.
        </p>
        <div className="space-y-3 rounded-xl border border-border bg-muted/40 p-4">
          <div className="flex items-center gap-2">
            <Checkbox
              id="alert-email-enabled"
              checked={alertEmailDraft.enabled}
              onCheckedChange={(checked) => setAlertEmailDraft((prev) => ({ ...prev, enabled: checked === true }))}
            />
            <Label htmlFor="alert-email-enabled" className="text-sm font-medium">
              Email (SMTP)
            </Label>
            {alertWebhookConfig.data?.email?.password_set ? (
              <Badge variant="outline">password stored</Badge>
            ) : null}
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="grid gap-1.5">
              <Label htmlFor="alert-email-host" className="text-xs text-muted-foreground">
                SMTP host
              </Label>
              <Input
                id="alert-email-host"
                placeholder="smtp.example.com"
                value={alertEmailDraft.host}
                onChange={(event) => setAlertEmailDraft((prev) => ({ ...prev, host: event.target.value }))}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="alert-email-port" className="text-xs text-muted-foreground">
                Port (465 uses implicit TLS)
              </Label>
              <Input
                id="alert-email-port"
                type="number"
                min={1}
                max={65535}
                value={alertEmailDraft.port}
                onChange={(event) =>
                  setAlertEmailDraft((prev) => ({
                    ...prev,
                    port: Math.max(1, Math.min(65535, Number(event.target.value) || 587)),
                  }))
                }
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="alert-email-username" className="text-xs text-muted-foreground">
                Username (optional)
              </Label>
              <Input
                id="alert-email-username"
                autoComplete="off"
                value={alertEmailDraft.username}
                onChange={(event) => setAlertEmailDraft((prev) => ({ ...prev, username: event.target.value }))}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="alert-email-password" className="text-xs text-muted-foreground">
                Password (blank keeps stored)
              </Label>
              <Input
                id="alert-email-password"
                type="password"
                autoComplete="new-password"
                value={alertEmailDraft.password}
                onChange={(event) => setAlertEmailDraft((prev) => ({ ...prev, password: event.target.value }))}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="alert-email-from" className="text-xs text-muted-foreground">
                From address
              </Label>
              <Input
                id="alert-email-from"
                placeholder="nebularr@example.com"
                value={alertEmailDraft.fromAddress}
                onChange={(event) => setAlertEmailDraft((prev) => ({ ...prev, fromAddress: event.target.value }))}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="alert-email-to" className="text-xs text-muted-foreground">
                To addresses (comma-separated)
              </Label>
              <Input
                id="alert-email-to"
                placeholder="you@example.com"
                value={alertEmailDraft.toAddressesText}
                onChange={(event) => setAlertEmailDraft((prev) => ({ ...prev, toAddressesText: event.target.value }))}
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="alert-email-starttls"
              checked={alertEmailDraft.starttls}
              onCheckedChange={(checked) => setAlertEmailDraft((prev) => ({ ...prev, starttls: checked === true }))}
            />
            <Label htmlFor="alert-email-starttls" className="text-sm text-muted-foreground">
              STARTTLS (ignored on port 465)
            </Label>
          </div>
          <p className="text-xs text-muted-foreground">
            Email uses the same event toggles and minimum state as the webhooks above. The password is encrypted at
            rest when an encryption key is configured.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={() => void saveAlertWebhooks()}>
            Save alert webhooks
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              void runAction(async () => {
                await api.sendAlertWebhookTest();
              }, "send test notification")
            }
          >
            Send test notification
          </Button>
        </div>
      </SectionCard>
    </div>
  );
}
