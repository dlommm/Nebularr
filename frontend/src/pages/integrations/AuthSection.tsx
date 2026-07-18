import { useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "../../api";
import { useActionError } from "../../hooks/useActionError";
import { queryKeys } from "../../lib/queryKeys";
import type { AuthStatusResponse } from "../../types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SectionCard } from "./shared";

export function AuthSection({ authStatus }: { authStatus: UseQueryResult<AuthStatusResponse> }): JSX.Element {
  const queryClient = useQueryClient();
  const { setError, runAction } = useActionError();
  const [authPasswordInput, setAuthPasswordInput] = useState("");
  const [authPasswordConfirm, setAuthPasswordConfirm] = useState("");
  const [issuedApiToken, setIssuedApiToken] = useState("");

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
        await queryClient.invalidateQueries({ queryKey: queryKeys.authStatus });
      },
      "save admin password",
    );
  };

  const setAuthEnabled = async (enabled: boolean): Promise<void> => {
    await runAction(
      async () => {
        await api.saveAuthConfig({ enabled });
        await queryClient.invalidateQueries({ queryKey: queryKeys.authStatus });
      },
      enabled ? "enable authentication" : "disable authentication",
    );
  };

  const rotateApiToken = async (): Promise<void> => {
    await runAction(
      async () => {
        const result = await api.saveAuthConfig({ rotate_api_token: true });
        setIssuedApiToken(result.api_token ?? "");
        await queryClient.invalidateQueries({ queryKey: queryKeys.authStatus });
      },
      "generate API token",
    );
  };

  const revokeApiToken = async (): Promise<void> => {
    await runAction(
      async () => {
        await api.saveAuthConfig({ revoke_api_token: true });
        setIssuedApiToken("");
        await queryClient.invalidateQueries({ queryKey: queryKeys.authStatus });
      },
      "revoke API token",
    );
  };

  const copyApiToken = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(issuedApiToken);
      toast.success("API token copied");
    } catch {
      toast.error("Could not copy to clipboard");
    }
  };

  return (
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
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-muted-foreground">
              Copy this token now — it is shown only once. Send it as <code>Authorization: Bearer …</code>
            </p>
            <Button type="button" variant="outline" size="sm" onClick={() => void copyApiToken()}>
              Copy
            </Button>
          </div>
          <code className="mt-1 block break-all">{issuedApiToken}</code>
        </div>
      ) : null}
    </SectionCard>
  );
}
