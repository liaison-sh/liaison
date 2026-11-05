# @liaison/db-gate

A standalone, read-only query sidecar you drop next to your database. It lets
a Liaison `database` connector read curated data over HTTP + a bearer token —
zero PRs to your backend, Postgres never exposed directly to Liaison.

See `docs/database-connector.md` (in the `liaison` repo) for the full
connectivity-ladder writeup and setup walkthrough. Quick reference:

```yaml
db-gate:
  image: liaison/db-gate
  environment:
    DB_GATE_DSN: postgres://liaison_readonly:***@postgres:5432/yourdb
    DB_GATE_TOKEN: <openssl rand -hex 32>
    DB_GATE_ALLOW_QUERY: "false"   # opt-in only
  volumes:
    - ./catalog.yaml:/catalog.yaml:ro
  ports:
    - "8478:8478"
```

## Env vars

| Var | Required | Default | Notes |
|---|---|---|---|
| `DB_GATE_DSN` | yes | — | Postgres connection string. Should point at a read-only role (see `scripts/db-readonly-role.ts` in the main repo). |
| `DB_GATE_TOKEN` | yes | — | Bearer token, minimum 32 characters. The process refuses to start below that. |
| `DB_GATE_CATALOG` | no | `/catalog.yaml` | Path to your catalog file — see `catalog.example.yaml`. |
| `DB_GATE_ALLOW_QUERY` | no | `false` | Enables `POST /query` (raw SELECT-only). Refuses to start if the startup probe finds write grants or dangerous EXECUTE grants beyond the curated allow-list. |
| `DB_GATE_PORT` | no | `8478` | HTTP port. |

## Routes

- `GET /healthz` — the only unauthenticated route. Bare liveness (200/503), no version/catalog info.
- `GET /catalog` — bearer-gated. Read names/descriptions/params/columns (never SQL text).
- `POST /read/{name}` — bearer-gated. `{params}` -> curated read.
- `POST /query` — bearer-gated. `{sql}` -> raw query, 404-shaped `disabled` unless `DB_GATE_ALLOW_QUERY=true`.

Every request is logged as one JSON line to stdout (name/params-hash/rows/
duration/caller-ip — never SQL results or the DSN).
