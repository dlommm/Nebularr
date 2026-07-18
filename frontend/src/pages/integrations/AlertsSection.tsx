import { useEffect, useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import { useActionError } from "../../hooks/useActionError";
import { queryKeys } from "../../lib/queryKeys";
import type { AlertWebhookConfig } from "../../types";
import { QueryErrorNotice } from "@/components/nebula/QueryErrorNotice";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SectionCard, SELECT_CLASS, TEXTAREA_CLASS } from "./shared";

export function AlertsSection({
  alertWebhookConfig,
}: {
  alertWebhookConfig: UseQueryResult<AlertWebhookConfig>;
}): JSX.Element {
  const queryClient = useQueryClient();
  const { setError, runAction } = useActionError();
  const [alertTestResults, setAlertTestResults] = useState<Record<string, { ok: boolean; error: string | null }>>({});
  const [alertTesting, setAlertTesting] = useState(false);
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

  const runAlertTest = async (): Promise<void> => {
    setAlertTesting(true);
    try {
      const response = await api.sendAlertWebhookTest();
      const byTarget: Record<string, { ok: boolean; error: string | null }> = {};
      for (const result of response.results) {
        byTarget[result.target] = { ok: result.ok, error: result.error };
      }
      setAlertTestResults(byTarget);
      if (response.results.length === 0) {
        setError("No alert channels are configured", "send test notification");
      }
    } catch (err) {
      setError(err, "send test notification");
    } finally {
      setAlertTesting(false);
    }
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
        await queryClient.invalidateQueries({ queryKey: queryKeys.alertWebhookConfig });
      },
      "save alert webhooks",
    );
  };

  return (
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
          {alertWebhookConfig.data?.email?.password_set ? <Badge variant="outline">password stored</Badge> : null}
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
        <Button type="button" variant="outline" size="sm" disabled={alertTesting} onClick={() => void runAlertTest()}>
          {alertTesting ? "Testing…" : "Test all channels"}
        </Button>
      </div>
      {Object.keys(alertTestResults).length > 0 ? (
        <ul className="mt-2 space-y-1 text-xs">
          {Object.entries(alertTestResults).map(([target, result]) => (
            <li key={target} className={`flex items-start gap-1.5 ${result.ok ? "text-ok" : "text-critical"}`}>
              <span aria-hidden>{result.ok ? "✓" : "✗"}</span>
              <span className="min-w-0 break-all">
                {target}
                {result.error ? ` — ${result.error}` : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </SectionCard>
  );
}
