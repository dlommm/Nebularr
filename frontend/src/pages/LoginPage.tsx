import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function safeNextPath(raw: string | null): string {
  // Only same-origin path redirects; anything absolute or protocol-relative falls back to home.
  if (raw && raw.startsWith("/") && !raw.startsWith("//")) {
    return raw;
  }
  return "/";
}

/** Deep grounds used when the cache has no posters yet (fresh install). */
const EMPTY_WALL_TONES = ["#1f3a4a", "#3b4a2a", "#5a2230", "#22303a", "#2c3e50", "#4a3b2a", "#183338", "#3a2e3e"];
const WALL_TILES = 60;

/** A slowly drifting wall of the library's own posters — a different random
    set every visit, served only from Nebularr's artwork cache. */
function PosterWall(): JSX.Element {
  const wall = useQuery({ queryKey: queryKeys.artWall, queryFn: () => api.artWall(WALL_TILES), staleTime: Infinity, retry: false });
  const [broken, setBroken] = useState<Set<string>>(() => new Set());
  const tiles = useMemo(() => {
    const urls = (wall.data?.items ?? []).filter((u) => !broken.has(u));
    if (!urls.length) return EMPTY_WALL_TONES.flatMap((tone) => Array.from({ length: 8 }, () => ({ url: null, tone })));
    // Repeat a small cache to fill the wall, so a fresh install still looks whole.
    return Array.from({ length: Math.max(WALL_TILES, urls.length) }, (_, i) => ({ url: urls[i % urls.length], tone: null }));
  }, [wall.data, broken]);
  return (
    <div aria-hidden className="absolute -inset-x-[10%] -inset-y-[20%] grid animate-pan grid-cols-5 gap-3.5 sm:grid-cols-10">
      {tiles.map((tile, i) =>
        tile.url ? (
          <img
            key={`${tile.url}-${i}`}
            src={tile.url}
            alt=""
            decoding="async"
            className="aspect-[2/3] w-full rounded-[3px] object-cover"
            onError={() => setBroken((prev) => new Set(prev).add(tile.url as string))}
          />
        ) : (
          <div key={i} className="aspect-[2/3] rounded-[3px] opacity-70" style={{ background: tile.tone ?? undefined }} />
        ),
      )}
    </div>
  );
}

export function LoginPage(): JSX.Element {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const authStatus = useQuery({ queryKey: queryKeys.authStatus, queryFn: api.authStatus });

  const login = useMutation({
    mutationFn: () => api.authLogin(password),
    onSuccess: async () => {
      setError("");
      await queryClient.invalidateQueries();
      navigate(safeNextPath(searchParams.get("next")), { replace: true });
    },
    onError: (err: unknown) => {
      setError(err instanceof ApiError && err.status === 429 ? "Too many attempts. Try again shortly." : "Invalid password.");
    },
  });

  if (authStatus.data && !authStatus.data.enabled) {
    // Auth is off — nothing to log into.
    return <Navigate to="/" replace />;
  }

  return (
    <div className="relative isolate flex min-h-svh items-center justify-center overflow-hidden bg-background px-4 py-12">
      <div aria-hidden className="absolute inset-0 -z-10 overflow-hidden">
        <PosterWall />
        <div
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(ellipse 60% 70% at 50% 50%, rgba(var(--scrim), 0.94) 30%, rgba(var(--scrim), 0.6) 100%)",
          }}
        />
      </div>
      <main className="w-full max-w-[420px] animate-rise">
        <h1 className="cond text-center text-[clamp(72px,18vw,108px)] leading-[0.82] font-[780]">Nebularr</h1>
        <p className="mt-3.5 mb-9 text-center text-base text-foreground/80">Sign in to your library.</p>
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
            <Label htmlFor="login-password" className="text-[13px] font-normal text-foreground/80">
              Password
            </Label>
            <Input
              id="login-password"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-describedby={error ? "login-error" : undefined}
              className="h-12 bg-muted/85 text-base"
            />
          </div>
          {error ? (
            <p id="login-error" role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <Button type="submit" size="lg" className="h-12 text-[15px] font-semibold" disabled={login.isPending || !password}>
            {login.isPending ? "Signing in…" : "Sign in"}
          </Button>
        </form>
        <p className="mt-7 text-center font-mono text-[11px] text-subtle-foreground">artwork from your Sonarr and Radarr</p>
      </main>
    </div>
  );
}
