# Security Policy

## Reporting a vulnerability

Please open a [private security advisory](https://github.com/dlommm/Nebularr/security/advisories/new)
on GitHub, or if that is unavailable, open an issue asking for a private contact channel
(do not include exploit details in a public issue). You should receive a response within
a week. Please give us reasonable time to ship a fix before public disclosure.

## Supported versions

| Version | Supported |
| ------- | --------- |
| 2.x     | ✅        |
| < 2.0   | ❌ (upgrade; 2.0 is backwards compatible) |

## Threat model

Nebularr is a **LAN tool**: it talks to Sonarr/Radarr instances on your network, stores
their metadata in PostgreSQL, and serves a web UI. It is not designed to be exposed
directly to the internet. If you must reach it remotely, put it behind a VPN or an
authenticating reverse proxy (with TLS) in addition to the built-in login.

## Advisories

### v2.7.0 — asset path traversal (fixed)

`GET /assets/{path}` in versions prior to 2.7.0 did not sufficiently bound
`path` to the web asset directory, allowing an unauthenticated caller to read
arbitrary files readable by the container process. **Upgrade to 2.7.0 or
later.** If your instance was ever reachable from the internet (not just your
LAN), treat its secrets as compromised: rotate `APP_ENCRYPTION_KEY` (see
below — this forces re-entry of encrypted integration API keys, the MAL
client ID, and alert webhook URLs) and rotate your PostgreSQL credentials.
2.7.0 also adds a setup-bootstrap token requirement (`X-Setup-Token`) on
mutating `/api/setup/*` endpoints while auth is unconfigured, and gates
`/metrics` behind the bearer API token when auth is enabled — see the
2.7.0 CHANGELOG entry for the full list.

## Security features (2.0+)

- **Authentication** — session-cookie login for the web UI plus an optional bearer API
  token for automation, enforced on every `/api/*` route and the API docs. New installs
  are prompted for an admin password in the setup wizard; installs upgraded from 1.x
  keep working without auth but warn loudly at startup, on `/healthz`, and in the UI
  until you enable it (Integrations → Authentication).
  Lockout recovery: set `AUTH_ENABLED=false` (disables enforcement) or
  `AUTH_RECOVERY_PASSWORD=...` (temporary login) in the environment and restart.
- **Secrets encrypted at rest** — integration API keys, the MAL client ID, and alert
  webhook URLs are encrypted with a Fernet key. If `APP_ENCRYPTION_KEY` is unset,
  Nebularr generates one on first start and persists it (mode 0600) under
  `NEBULARR_RUNTIME_DIR`. Values stored in plaintext by 1.x keep working and are
  re-written encrypted the next time they are saved.
  Back up the runtime directory together with the database: losing the key makes the
  encrypted values unreadable (you would re-enter the API keys).
- **Egress policy** — user-configured outbound URLs (Sonarr/Radarr base URLs, alert
  webhooks) are validated against `EGRESS_POLICY`: `lan` (default) blocks link-local
  and cloud-metadata ranges while allowing LAN/loopback hosts; `strict` allows only
  globally-routable hosts; `open` restores shape-only validation.
  *Caveat:* validation happens at configuration time; DNS-rebinding after
  configuration is out of scope for this control.
- **Webhook authentication** — `/hooks/{source}` requires the shared secret in the
  `x-arr-shared-secret` header; body size is capped on the bytes actually received.
  The `changeme` default is still accepted for compatibility but warned about —
  set a real secret in the wizard or Integrations page.
- **Container hardening** — non-root (uid 1001), read-only root filesystem, all
  capabilities dropped, `no-new-privileges`, digest-pinned base image, and CI image
  scanning (Trivy + Grype + Hadolint).

## Hardening checklist

1. Set an admin password (setup wizard, or Integrations → Authentication).
2. Set a real webhook shared secret.
3. Keep port 8080 unexposed beyond your LAN; don't publish Postgres to the host.
4. Back up `NEBULARR_RUNTIME_DIR` (contains the generated encryption key) with your DB.
5. Leave `EGRESS_POLICY=lan` (or use `strict` if your Arrs resolve to public addresses).
6. Update via tagged releases; Dependabot + CI scans track CVEs in the base image.
