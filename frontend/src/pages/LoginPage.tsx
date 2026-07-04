import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { GlassCard } from "@/components/nebula/GlassCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

function safeNextPath(raw: string | null): string {
  // Only same-origin path redirects; anything absolute or protocol-relative falls back to home.
  if (raw && raw.startsWith("/") && !raw.startsWith("//")) {
    return raw;
  }
  return "/";
}

export function LoginPage(): JSX.Element {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const authStatus = useQuery({ queryKey: ["auth-status"], queryFn: api.authStatus });

  const login = useMutation({
    mutationFn: () => api.authLogin(password),
    onSuccess: async () => {
      setError("");
      await queryClient.invalidateQueries();
      navigate(safeNextPath(searchParams.get("next")), { replace: true });
    },
    onError: (err: unknown) => {
      setError(err instanceof Error && err.message.includes("429") ? "Too many attempts. Try again shortly." : "Invalid password.");
    },
  });

  if (authStatus.data && !authStatus.data.enabled) {
    // Auth is off — nothing to log into.
    return <Navigate to="/" replace />;
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <GlassCard className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Nebularr</CardTitle>
          <CardDescription>Enter the admin password to continue.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!login.isPending && password) {
                login.mutate();
              }
            }}
          >
            <div className="grid gap-2">
              <Label htmlFor="login-password">Password</Label>
              <Input
                id="login-password"
                type="password"
                autoComplete="current-password"
                autoFocus
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <Button type="submit" disabled={login.isPending || !password}>
              {login.isPending ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </GlassCard>
    </div>
  );
}
