# Compose Resource Hints

For full-sync spikes on larger libraries, consider limits/reservations.

## Workload vs capacity

```mermaid
flowchart LR
  subgraph phases [App CPU memory demand]
    full[Full sync spike]
    inc[Incremental steady state]
    wh[Webhook bursts]
  end
  subgraph caps [Compose or host limits]
    lim[CPU + memory limits]
    res[Reservations minimums]
  end
  full --> lim
  inc --> res
  wh --> lim
```

Example snippet:

```yaml
services:
  app:
    deploy:
      resources:
        limits:
          cpus: "2.0"
          memory: 2G
        reservations:
          cpus: "0.5"
          memory: 512M
```

Notes:

- `deploy.resources` is honored in Swarm; for plain Compose, use host-level constraints or container runtime flags as needed.
- Keep DB memory available for Postgres caches.
