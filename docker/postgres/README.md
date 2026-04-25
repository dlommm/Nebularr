# PostgreSQL for Nebularr

The official `postgres` image only needs `POSTGRES_DB`, `POSTGRES_USER`, and `POSTGRES_PASSWORD`.

The `arrapp` database role is **not** created by container init scripts. Use the Web UI setup step **Database** (or the `POST /api/setup/bootstrap-database` API) once migrations have run: it runs the same SQL that used to live in `00_roles.sh`, then stores the `arrapp` connection string encrypted under the app data directory (`NEBULARR_RUNTIME_DIR`, default `/app/data`).
