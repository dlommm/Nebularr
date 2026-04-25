import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { usePageTitle } from "../hooks/usePageTitle";
import { fmtDate } from "../hooks";
import { useActionError } from "../hooks/useActionError";

export function IntegrationsPage(): JSX.Element {
  usePageTitle("Integrations");
  const queryClient = useQueryClient();
  const { setError, runAction } = useActionError();

  const integrations = useQuery({ queryKey: ["integrations"], queryFn: api.integrations });
  const malConfig = useQuery({ queryKey: ["mal-config"], queryFn: api.malConfig });
  const loggingConfig = useQuery({ queryKey: ["logging-config"], queryFn: api.loggingConfig });
  const webhookConfig = useQuery({ queryKey: ["webhook-config"], queryFn: api.webhookConfig });
  const alertWebhookConfig = useQuery({ queryKey: ["alert-webhook-config"], queryFn: api.alertWebhookConfig });

  const [integrationDrafts, setIntegrationDrafts] = useState<
    Record<string, { base_url: string; api_key: string; enabled: boolean; webhook_enabled: boolean }>
  >({});
  const [webhookSecretInput, setWebhookSecretInput] = useState("");
  const [malClientIdInput, setMalClientIdInput] = useState("");
  const [malClearClientId, setMalClearClientId] = useState(false);
  const [loggingLevelChoice, setLoggingLevelChoice] = useState<string>("INFO");
  const [loggingUseEnvDefault, setLoggingUseEnvDefault] = useState(false);
  const [alertWebhookDraft, setAlertWebhookDraft] = useState<{
    webhookUrlsText: string;
    clearUrls: boolean;
    timeoutSeconds: number;
    minState: "warning" | "critical";
    notifyRecovery: boolean;
  }>({
    webhookUrlsText: "",
    clearUrls: false,
    timeoutSeconds: 10,
    minState: "warning",
    notifyRecovery: true,
  });

  useEffect(() => {
    if (!integrations.data) return;
    const next: Record<string, { base_url: string; api_key: string; enabled: boolean; webhook_enabled: boolean }> = {};
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
    if (!alertWebhookConfig.data) return;
    setAlertWebhookDraft((prev) => ({
      ...prev,
      timeoutSeconds: alertWebhookConfig.data.timeout_seconds,
      minState: alertWebhookConfig.data.min_state,
      notifyRecovery: alertWebhookConfig.data.notify_recovery,
    }));
  }, [alertWebhookConfig.data]);

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
    if (!malClearClientId && !malClientIdInput.trim()) {
      setError("Enter a MyAnimeList client ID, or check remove stored ID to clear.", "save MyAnimeList client ID");
      return;
    }
    await runAction(
      async () => {
        await api.saveMalConfig({
          clear_client_id: malClearClientId,
          ...(malClearClientId ? {} : { client_id: malClientIdInput.trim() }),
        });
        setMalClientIdInput("");
        setMalClearClientId(false);
        await queryClient.invalidateQueries({ queryKey: ["mal-config"] });
      },
      "save MyAnimeList client ID",
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
        const payload: {
          webhook_urls?: string;
          clear_urls?: boolean;
          timeout_seconds: number;
          min_state: "warning" | "critical";
          notify_recovery: boolean;
        } = {
          timeout_seconds: alertWebhookDraft.timeoutSeconds,
          min_state: alertWebhookDraft.minState,
          notify_recovery: alertWebhookDraft.notifyRecovery,
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
        await queryClient.invalidateQueries({ queryKey: ["alert-webhook-config"] });
      },
      "save alert webhooks",
    );
  };

  return (
    <div className="card">
      <h3>Integrations</h3>
      <div className="stack">
        {(integrations.data ?? []).map((row) => (
          <div className="inner-card" key={`${row.source}-${row.name}`}>
            <div className="row">
              <strong>
                {row.source}/{row.name}
              </strong>
              <span className="muted">Updated {fmtDate(row.updated_at)}</span>
              <span className="pill">{row.api_key_set ? "API key set" : "API key missing"}</span>
              <span className="pill">{row.enabled ? "enabled" : "disabled"}</span>
            </div>
            <div className="row mt8">
              <input
                value={integrationDrafts[`${row.source}:${row.name}`]?.base_url ?? row.base_url}
                onChange={(event) =>
                  setIntegrationDrafts((prev) => ({
                    ...prev,
                    [`${row.source}:${row.name}`]: {
                      ...(prev[`${row.source}:${row.name}`] ?? {
                        base_url: row.base_url,
                        api_key: "",
                        enabled: row.enabled,
                        webhook_enabled: row.webhook_enabled,
                      }),
                      base_url: event.target.value,
                    },
                  }))
                }
              />
              <input
                placeholder="New API key (optional)"
                value={integrationDrafts[`${row.source}:${row.name}`]?.api_key ?? ""}
                onChange={(event) =>
                  setIntegrationDrafts((prev) => ({
                    ...prev,
                    [`${row.source}:${row.name}`]: {
                      ...(prev[`${row.source}:${row.name}`] ?? {
                        base_url: row.base_url,
                        api_key: "",
                        enabled: row.enabled,
                        webhook_enabled: row.webhook_enabled,
                      }),
                      api_key: event.target.value,
                    },
                  }))
                }
              />
            </div>
            <div className="row mt8">
              <label className="pill">
                <input
                  type="checkbox"
                  checked={integrationDrafts[`${row.source}:${row.name}`]?.enabled ?? row.enabled}
                  onChange={(event) =>
                    setIntegrationDrafts((prev) => ({
                      ...prev,
                      [`${row.source}:${row.name}`]: {
                        ...(prev[`${row.source}:${row.name}`] ?? {
                          base_url: row.base_url,
                          api_key: "",
                          enabled: row.enabled,
                          webhook_enabled: row.webhook_enabled,
                        }),
                        enabled: event.target.checked,
                      },
                    }))
                  }
                />
                enabled
              </label>
              <label className="pill">
                <input
                  type="checkbox"
                  checked={integrationDrafts[`${row.source}:${row.name}`]?.webhook_enabled ?? row.webhook_enabled}
                  onChange={(event) =>
                    setIntegrationDrafts((prev) => ({
                      ...prev,
                      [`${row.source}:${row.name}`]: {
                        ...(prev[`${row.source}:${row.name}`] ?? {
                          base_url: row.base_url,
                          api_key: "",
                          enabled: row.enabled,
                          webhook_enabled: row.webhook_enabled,
                        }),
                        webhook_enabled: event.target.checked,
                      },
                    }))
                  }
                />
                webhook enabled
              </label>
              <button type="button" className="secondary" onClick={() => void saveIntegration(row.source, row.name)}>
                Save
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="inner-card mt8">
        <h3>MyAnimeList API</h3>
        <div className="row">
          <span className="pill">
            {malConfig.data?.client_id_configured
              ? "client ID stored in database"
              : malConfig.data?.env_fallback_configured
                ? "using MAL_CLIENT_ID from environment"
                : "client ID not configured"}
          </span>
          <span className="muted">
            Stored in the database when set here (persists across restarts). Values in `MAL_CLIENT_ID` are used if nothing is
            stored.
          </span>
        </div>
        <div className="row mt8">
          <input
            type="password"
            autoComplete="off"
            placeholder="MyAnimeList API client ID (from myanimelist.net/apiconfig)"
            value={malClientIdInput}
            onChange={(event) => setMalClientIdInput(event.target.value)}
          />
          <button type="button" className="secondary" onClick={() => void saveMalConfig()}>
            Save
          </button>
        </div>
        <div className="row mt8">
          <label className="pill">
            <input type="checkbox" checked={malClearClientId} onChange={(event) => setMalClearClientId(event.target.checked)} />
            remove stored client ID (fall back to environment only)
          </label>
        </div>
      </div>
      <div className="inner-card mt8">
        <h3>Application logging</h3>
        <div className="row">
          <span className="pill">effective: {loggingConfig.data?.effective_level ?? "…"}</span>
          <span className="muted">
            {loggingConfig.data?.stored_level
              ? `Level stored in database (overrides LOG_LEVEL at startup and when changed here).`
              : `No database override; using process LOG_LEVEL (${loggingConfig.data?.environment_default ?? "…"}) until you save a level below.`}
          </span>
        </div>
        <div className="row mt8">
          <select
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
          <button type="button" className="secondary" onClick={() => void saveLoggingConfig()}>
            Apply log level
          </button>
        </div>
        <div className="row mt8">
          <label className="pill">
            <input
              type="checkbox"
              checked={loggingUseEnvDefault}
              onChange={(event) => setLoggingUseEnvDefault(event.target.checked)}
            />
            on save, clear database override and use LOG_LEVEL from the environment
          </label>
        </div>
      </div>
      <div className="inner-card mt8">
        <h3>Webhook shared secret</h3>
        <div className="row">
          <span className="pill">{webhookConfig.data?.secret_set ? "secret set" : "secret missing"}</span>
          <input
            placeholder="Set new webhook shared secret"
            value={webhookSecretInput}
            onChange={(event) => setWebhookSecretInput(event.target.value)}
          />
          <button type="button" className="secondary" onClick={() => void saveWebhookSecret()}>
            Save secret
          </button>
        </div>
      </div>
      <div className="inner-card mt8">
        <h3>Alert webhooks</h3>
        <div className="row">
          <span className="pill">
            {alertWebhookConfig.data?.urls_configured
              ? `${alertWebhookConfig.data.url_count} webhook URL${alertWebhookConfig.data.url_count === 1 ? "" : "s"} configured`
              : "no webhook URLs configured"}
          </span>
          <span className="muted">Stored in DB; URLs are encrypted when `APP_ENCRYPTION_KEY` is configured.</span>
        </div>
        <div className="stack mt8">
          <textarea
            rows={4}
            placeholder="Paste webhook URLs (one per line or comma-separated). Leave blank to keep existing URLs."
            value={alertWebhookDraft.webhookUrlsText}
            onChange={(event) =>
              setAlertWebhookDraft((prev) => ({
                ...prev,
                webhookUrlsText: event.target.value,
              }))
            }
          />
          <div className="row">
            <label className="pill">
              <input
                type="checkbox"
                checked={alertWebhookDraft.clearUrls}
                onChange={(event) =>
                  setAlertWebhookDraft((prev) => ({
                    ...prev,
                    clearUrls: event.target.checked,
                  }))
                }
              />
              clear stored webhook URLs
            </label>
            <label className="pill">
              minimum state
              <select
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
            </label>
            <label className="pill">
              timeout (seconds)
              <input
                type="number"
                min={1}
                step={1}
                value={alertWebhookDraft.timeoutSeconds}
                onChange={(event) =>
                  setAlertWebhookDraft((prev) => ({
                    ...prev,
                    timeoutSeconds: Number(event.target.value || 0),
                  }))
                }
              />
            </label>
            <label className="pill">
              <input
                type="checkbox"
                checked={alertWebhookDraft.notifyRecovery}
                onChange={(event) =>
                  setAlertWebhookDraft((prev) => ({
                    ...prev,
                    notifyRecovery: event.target.checked,
                  }))
                }
              />
              notify on recovery to ok
            </label>
            <button type="button" className="secondary" onClick={() => void saveAlertWebhooks()}>
              Save alert webhooks
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
