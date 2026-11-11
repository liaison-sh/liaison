# The `database` connector

Read-only access to a deployment's own database, for the agent to use when
troubleshooting and answering support tickets — licenses/subscriptions,
moderation surfaces (tickets, knowledge documents, mail threads), and
instance health. Generic across any liaison-schema deployment; a deployment
can also adapt it to a completely different (non-liaison) database. First
consumer: a self-hosted instance reading its own Postgres.

**Read-only, safe by construction.** Every layer below is enforced by DB
grants, transaction mode, and validators — never by policy or trust. See
[§4 Safety stack](#4-safety-stack) for the full defense-in-depth table.

---

## 1. Architecture

```
agent ──tool call──▶ execute-tool.ts (trust boundary → scope → AJV → …)
                        │
                  handlers.ts  (QuickJS sandbox, thin delegator — never
                        │       sees credentials or touches the DB)
                  bridge.ts    (HOST-SIDE: credential decrypt, audit,
                        │       orchestration — apps/api/src/apps/database/)
                  adapter      (read CATALOG: name → SQL template, params
                        │       schema, column allow-list; transport-agnostic
                        │       — packages/db-core + apps/api/.../adapters/)
                  transport    (DbTransport seam — apps/api/.../transport.ts)
                   ├─ PostgresDirect  (DSN → postgres.js; same-machine/
                   │                   private-network/hardened-public DSN)
                   └─ HttpGate        (URL+token → liaison-db-gate sidecar,
                                        apps/db-gate/)
```

- **The app** (`apps/api/src/apps/database/`) is an in-tree, `trusted:false`
  app in the gitlab/google-drive shape: sandboxed `handlers.ts` delegators +
  a host-side `bridge.ts` factory wired via `manifest-descriptor.ts`'s
  `_bridgeExtension`. Headless — no frontend panel; connect/settings come
  free from the generic connections surface.
- **`packages/db-core`** is the shared, transport-agnostic package: the
  catalog zod schema + validator (`catalog.ts`), the SELECT-only SQL guard
  (`sql-guard.ts`), the READ ONLY/timeout/row-cap/column-projection/pool-
  concurrency execution wrapper (`execution-wrapper.ts`), the secret-column
  belt (`secret-columns.ts`), and the readonly-role grants renderer
  (`grants-renderer.ts`). Both the in-tree app and the standalone
  `apps/db-gate` sidecar import this package — one implementation, no
  copy-paste.
- **Typing params.** A read's `:name` params reach Postgres untyped. Where
  Postgres cannot infer a type from the context (`:after IS NULL`,
  `coalesce(:x, ...)`), cast the param once (`:after::timestamptz`): the cast
  is applied to every use of that param, at whichever use you put it.
- **Adapter** = the per-deployment unit: a `ReadCatalog` (named reads: SQL
  template + params + column allow-list + tables touched), selected by env
  `LIAISON_DATABASE_ADAPTER` (default `liaison-self`). The first, generic
  adapter is `liaison-self` (`apps/api/src/apps/database/adapters/
  liaison-self.ts`) — reads any liaison-schema Postgres. Its login bypasses
  row-level security, so the connector holds its reads to the caller: the
  `orgId` parameter is always the caller's org (a passed value is replaced),
  each read needs the read scope of the app whose rows it returns, the
  knowledge and mail reads keep to org-wide documents and shared mailboxes,
  and raw `db_query` over it is reserved to the instance operator's org. After
  upgrading, re-run `scripts/db-readonly-role.ts --create` on an existing
  cluster so the role gets the columns those filters read. A toy portability
  fixture lives at `apps/api/src/apps/database/adapters/__fixtures__/
  toy-shop.ts` (see [§7](#7-authoring-your-own-adapter)).
- **Transport** = `DbTransport` (`apps/api/src/modules/apps/connections/sql/transport.ts`,
  the platform's SQL connections, which also serve `ctx.sql` for any app):
  `probe() / runRead() / runQuery() / describe() / close()`. Two
  implementations, interchangeable behind the seam:
  - `PostgresDirect` (`transports/postgres-direct.ts`) — a DSN, driven with
    postgres.js.
  - `HttpGate` (`transports/http-gate.ts`) — a URL + bearer token, driven
    against the `liaison-db-gate` sidecar over HTTP.

### Tools

| Tool | Scope | Purpose |
|---|---|---|
| `db_list_reads` | `database:reads:read` | List the catalog's named reads (description, domain, params, columns). Call this first. |
| `db_read(name, params)` | `database:reads:read` | Run a named, parameterized curated read. Result columns restricted to the read's allow-list. |
| `db_describe(table?, schema?, search?, connection?)` | `database:reads:read` (plus `database:query:read` for `connection: "warehouse"`) | Discovery, grant-grounded (not the catalog). With no `table`: a compact listing, `schema.table` plus its column count, narrowed by `schema` (exact) or `search` (substring), never the columns (a 165-table warehouse's full map was ~121 KB and got truncated). With `table`: that table's columns and types. Secret columns filtered out. |
| `db_probe(connection?)` | `database:reads:read` (plus `database:query:read` for `connection: "warehouse"`) | Run the connect-time safety probe on demand — write/EXECUTE grants beyond the allow-list, catalog drift (gate mode). |
| `db_query(sql, connection?)` | `database:query:read` | Raw, single-statement SELECT of at most 100,000 characters. Enabled by default; a deployment can disable it with `LIAISON_DATABASE_ALLOW_RAW_QUERY=false`. Same grant restrictions as curated reads. |

`roles`: `member` gets `database:reads:read`; `admin` additionally gets
`database:query:read` (the raw-query surface is the higher-trust capability).

`db_read` and `db_query` count as reading outside text: their rows come from a
database the organization does not author (a ticket subject a customer wrote, a
note in a connected CRM). A turn that called either is marked, so a later call
in the same turn whose effect leaves the organization waits for a person's
approval, as it does after reading the ticket itself.

### A second connection: `warehouse`

An org can connect a second database next to the default one, for raw
read-only SELECT over an analytics warehouse or a replica. It is the
manifest connection `warehouse` of the same `database` app, so saving it
never replaces the default connection's credentials (a credentials
connection is re-connect-replaces per connection name).

- **Selecting it.** `db_describe`, `db_query` and `db_probe` take an optional
  `connection` param: absent or `"default"` is the org's `database`
  connection, resolved, pooled and audited exactly as before; `"warehouse"`
  is the second one. Any other value is refused (`unknown_connection`),
  never routed to the default. `db_list_reads` / `db_read` (curated reads)
  exist on the default connection only. Audit rows for the warehouse carry
  `metadata.connection: "warehouse"`.
- **Direct only.** Its credential fields are `connectionString` (required),
  `dialect` (`postgres`, the default, or `redshift`) and `statementTimeoutMs`
  (optional, 1000 to 300000; the transport default is 10000). Gate
  credentials on it are a `config_error`.
- **Scope.** Every tool call on the warehouse needs `database:query:read`,
  `db_describe` and `db_probe` included (checked in the bridge, since the
  tool-level scope of those two is `database:reads:read`): a member with
  curated reads must not list a production warehouse's schema. Grant the
  scope only to the roles or agents meant to query the warehouse.
- **Walls.** `PostgresDirect` runs it with the default connection's walls:
  one statement per execution (extended protocol, so the server refuses a
  second statement even if the SQL guard were fooled), READ ONLY
  transaction, `SET LOCAL statement_timeout`, the 500-row cap, the
  SELECT-only SQL guard, TLS by resolved IP on every call including
  `db_describe` and `db_probe`, and the SECRET_COLUMNS belt over
  `db_describe`. The one wall it does not have is the curated catalog: the
  role's grants are the whole boundary, so give the role USAGE + SELECT on
  the schemas agents may read and nothing else.
- **Resolution.** The warehouse resolves only as the ORG-owned account with
  the fixed identifier `warehouse` (the default: org-owned, identifier
  `default`). A member's personal connection of the same name never stands
  in for it. A saved credential change (DSN, dialect, timeout) takes effect
  on the next call: the pooled transport is keyed by the credentials it was
  built from.
- **Redshift.** `dialect: redshift` changes three things, all measured
  against a live Redshift cluster: postgres.js's connect-time type fetch is
  off (it reads `pg_type` columns Redshift lacks, error 42703); `db_describe`
  reads `svv_columns` (information_schema misses late-binding views and
  external tables) and keeps only tables the role can SELECT, guarding
  `has_table_privilege` with a schema USAGE check because Redshift raises on
  a schema without USAGE instead of returning false; the write-grant probe
  uses `svv_tables` with no VALUES list (a Redshift syntax error). A view
  over a schema the role cannot use does not appear, which is right: it
  cannot be selected. The EXECUTE probe is unchanged, and on Redshift it
  reports the UDFs that PUBLIC may execute (Redshift's default), so expect
  `ok: false` from `db_probe` there; review the list rather than treat it as
  a fault.

Config as code (`liaison config apply`): list the `database` app once per
connection. The `identifier` must be exactly `warehouse` and `ownerType`
must be `org`, or the bridge will not find the connection. The DSN comes
from an env ref so no secret sits in the file, and it must be a
`postgres://` URL (a `key=value` string is refused as a `config_error`);
URL-encode any reserved character in the password.

```yaml
apps:
  - name: database
    enable: true
    connection:
      name: database          # the default connection, unchanged
      identifier: default
      ownerType: org
      credentials:
        gateUrl: ${LIAISON_DB_GATE_URL}
        gateToken: ${LIAISON_DB_GATE_TOKEN}
  - name: database
    enable: true
    connection:
      name: warehouse
      identifier: warehouse
      ownerType: org
      credentials:
        connectionString: ${LIAISON_WAREHOUSE_DSN:-}   # postgres://user:pass@host:5439/db?sslmode=require
        dialect: redshift
        statementTimeoutMs: "120000"
```

`statementTimeoutMs` is quoted because credential values are strings. An
agent tool call caps it below its own sandbox budget: `db_read`, `db_describe`,
`db_probe` and `db_query` declare `timeoutMs: 60000`, the statement timeout of
one call is at most 55 s, and at 58 s the bridge stops waiting and cancels the
statement on the database (protocol CancelRequest, verified on Redshift). A
longer configured value applies only outside a tool call. A timeout comes back
as `statement_timeout`, non-retryable, telling the agent to narrow the query. With
`dialect` set, an empty DSN is a partial fill and `config apply` fails on the
missing required `connectionString`; it reports the connection as pending
only when every credential value is empty.

Domains are intentionally scoped: **orders are not in this database** —
they live in whatever commerce system the deployment connects (e.g. the
`shopify` app) and are out of scope for `liaison-self`.

---

## 2. The connectivity ladder — "which rung am I?"

```
0. Same machine / Docker network        (same-machine deployments)
1. Private networking                    (VPN / WireGuard / private endpoint)
2. Read-only HTTP data API = db-gate     (DB owner never opens the DB at all)
3. Public Postgres endpoint, hardened    (TLS enforced + IP allowlist + read-only role)
Never: plaintext remote — the connector refuses it itself.
```

**Decision guide:**

- **Your Postgres is reachable from the liaison container without crossing
  an untrusted network** (same Docker network, same VPC, over a VPN) →
  **rung 0/1, direct DSN mode.** Mint `liaison_readonly`
  (`scripts/db-readonly-role.ts --create`), paste the DSN into the
  connection's `connectionString` field. Loopback/RFC1918-resolving hosts
  are allowed without TLS by default.
- **You don't want to open your database to Liaison at all, or it crosses
  an untrusted network / a "grumpy devops" boundary** → **rung 2, db-gate.**
  Stand up the `liaison-db-gate` sidecar next to your DB (its own container,
  its own catalog file, its own token) — Liaison never sees your DSN, only
  an HTTP+bearer surface you control. See [§3](#3-set-up-db-gate).
- **Your Postgres is a public endpoint with no private-networking option**
  → **rung 3, direct DSN with TLS.** The connector refuses plaintext to any
  DSN whose host **resolves** to a non-loopback/non-RFC1918 IP — `sslmode=
  require` or stronger is mandatory, not a warning. Pair this with a
  provider-level IP allowlist restricting connections to the liaison host.
- Never: a plaintext DSN to a public IP. There is no "I understand the
  risk" override for this — the connector refuses unconditionally
  (`LIAISON_DB_ALLOW_PLAINTEXT_LOCAL` only affects **local-only**
  exceptions, never a public-resolving host).

### Setup per rung

**Rung 0/1 — direct DSN:**

1. Provision the read-only role on the target Postgres:
   ```bash
   DB_READONLY_PASSWORD=$(openssl rand -hex 32) \
     bun run scripts/db-readonly-role.ts --create
   ```
   (Superuser/owner DSN via `MIGRATION_DATABASE_URL` or `DATABASE_URL` env.)
   This is idempotent — safe to re-run.
2. Build the DSN: `postgres://liaison_readonly:<password>@<host>:5432/<db>`.
3. Connect the `database` app's connection with `connectionString` set to
   that DSN; leave `gateUrl`/`gateToken` empty.
4. `db_probe` runs automatically at connect time and reports any unexpected
   write/EXECUTE grants — review its warnings.

**Rung 2 — db-gate, full walkthrough:**

1. Write (or copy `apps/db-gate/catalog.example.yaml` and edit) a
   `catalog.yaml` matching your adapter's `ReadCatalog` shape (see
   [§5](#5-catalog-format-reference)).
2. Mint a token: `openssl rand -hex 32` (minimum 32 chars — the gate refuses
   to start below that).
3. Provision a read-only role for the gate's own DSN the same way as rung
   0/1 (`scripts/db-readonly-role.ts --create`) — recommended, not required;
   the gate's own function-execution lockdown and SELECT-only validator are
   defense in depth regardless, but the role is the primary wall.
4. Compose file:
   ```yaml
   db-gate:
     image: liaison/db-gate
     environment:
       DB_GATE_DSN: postgres://liaison_readonly:<password>@postgres:5432/yourdb
       DB_GATE_TOKEN: <the minted token>
       DB_GATE_ALLOW_QUERY: "false"   # opt-in only; see below
     volumes:
       - ./catalog.yaml:/catalog.yaml:ro
     ports:
       - "8478:8478"
   ```
5. `docker compose up -d db-gate`. Check `GET /healthz` (unauthenticated,
   bare liveness) and, with the token, `GET /catalog`.
6. In Liaison, connect the `database` app's connection with `gateUrl` set to
   the gate's reachable URL and `gateToken` set to the minted token; leave
   `connectionString` empty. Gate requests go through the outbound guard:
   the host is resolved once and pinned, a redirect is refused (never
   followed), link-local and metadata addresses and this instance's own
   services (Redis, search, object storage) are refused, and
   `LIAISON_DATABASE_ALLOWED_HOSTS`, when set, must list the gate host.
7. `https://` is required for any non-local gate URL — same resolved-IP TLS
   classifier as direct mode. A gate on localhost or RFC1918 is the
   operator's opt-in: list its host in `LIAISON_DATABASE_ALLOWED_HOSTS` (or
   set `LIAISON_DB_ALLOW_PLAINTEXT_LOCAL=true`); it can then use `http://`.
8. **Token rotation runbook:** mint a new token (`openssl rand -hex 32`),
   update `DB_GATE_TOKEN` in the gate's environment and redeploy the gate
   container, then update the connection's `gateToken` credential in Liaison
   (this evicts the pooled transport automatically on credential change) and
   re-run `db_probe` to confirm the new token round-trips. There is no
   dual-token grace window in v1 — expect a brief connectivity gap between
   the gate redeploy and the Liaison-side credential update; do both in the
   same maintenance window.
9. **`DB_GATE_ALLOW_QUERY=true`:** the gate refuses to actually start with
   this flag unless its own startup probe confirms no write grants and no
   dangerous EXECUTE grants on its DSN's role. Don't flip it on speculatively
   — enable it only when the deployment genuinely wants the raw-query
   surface, and expect the gate process to exit non-zero at boot if the
   underlying role isn't clean.

**Rung 3 — public Postgres, hardened:**

Same as rung 0/1's steps, but the DSN must include `sslmode=require` (or
`verify-ca`/`verify-full`) and the database provider should apply its own IP
allowlist restricting connections to the liaison host's egress IP. The
connector's TLS classifier resolves the DSN host to an IP before ever
attempting a connection — a public-resolving hostname without `sslmode=
require` is refused with a typed error naming the fix, not a warning.

### `VALID UNTIL` (credential expiry)

`CREATE ROLE`/`ALTER ROLE ... VALID UNTIL '<timestamp>'` is documented here
because it's the natural pairing with rotation, but it is **off by default**
— the generated grants file and `scripts/db-readonly-role.ts` do not set an
expiry. If a deployment wants forced-expiry credentials (e.g. quarterly
rotation as policy), set it directly with `ALTER ROLE liaison_readonly VALID
UNTIL '...'` after `--create`; `--rotate` only changes the password and does
not touch `VALID UNTIL`, so a forced expiry survives a rotation and must be
re-extended separately if the deployment wants that discipline.

---

## 3. Set up db-gate

Full env var / route reference lives in `apps/db-gate/README.md`. Summary:

| Var | Required | Default | Notes |
|---|---|---|---|
| `DB_GATE_DSN` | yes | — | Postgres connection string, ideally a `liaison_readonly`-style role. |
| `DB_GATE_TOKEN` | yes | — | Bearer token, min 32 chars. |
| `DB_GATE_CATALOG` | no | `/catalog.yaml` | Path to the catalog file. |
| `DB_GATE_ALLOW_QUERY` | no | `false` | Enables `POST /query`; refuses to start if the startup probe isn't clean. |
| `DB_GATE_PORT` | no | `8478` | HTTP port. |

Routes: `GET /healthz` (unauthenticated), `GET /catalog`, `POST /read/{name}`,
`POST /query` (bearer-gated, no exceptions besides `/healthz`).

---

## 4. Safety stack

The DB grant layer (6a/6b) is the **primary wall** — everything else is
independently-tested defense in depth, not a substitute for it.

| Layer | Mechanism | Where |
|---|---|---|
| 1 | Scope check `database:reads:read` / `database:query:read` | `execute-tool.ts` (existing kernel middleware) |
| 2 | AJV params validation per tool | `execute-tool.ts` (existing) |
| 3 | Curated reads: parameterized SQL only, column allow-list applied to result rows | adapter/bridge |
| 4 | Raw query: opt-in flag + single-statement SELECT-only validator + dangerous-function-name denylist (`pg_sleep`, `dblink*`, `lo_import`, `lo_export`, `pg_read_file`, `pg_read_server_files`, `pg_ls_dir`, `pg_terminate_backend`, `copy`, `setval`, `nextval`) | `bridge.ts` + gate (`sql-guard.ts`) |
| 5 | `BEGIN READ ONLY` + `statement_timeout` + row cap on every query | both transports + gate (`execution-wrapper.ts`) |
| 6a | Read-only DB role, explicit allow-list grants — never `ALL TABLES` | `scripts/db-readonly-role.ts` / `deploy/postgres-init/20-readonly-role.sh` |
| 6b | Function-execution lockdown: `REVOKE EXECUTE ... FROM PUBLIC` + per-schema revoke + `ALTER DEFAULT PRIVILEGES` | same provisioning path |
| 6c | Pool-level concurrency bound, independent of `statement_timeout` | both transports + gate |
| 7 | TLS required for any DSN resolving to a non-loopback/non-RFC1918 IP | `PostgresDirect` (`classifyDsnHost` in `execution-wrapper.ts`) |
| 8 | Connect probe: write-grant/EXECUTE-grant check + catalog drift (gate mode) | `bridge.ts` (`db_probe`, run automatically at connect) |
| 9 | Error redaction — DSN/credentials never surfaced | `redactDbError` (`execution-wrapper.ts`) |
| 10 | Audit: every call → `kernel.audit_log`, written in `finally`, `outcome: success\|error\|blocked`, `sqlHash` never raw SQL | `bridge.ts` |
| 11 | `db_describe` scoped to catalog tables only, secret-column-filtered | `bridge.ts` |
| 12 | Privileged-role pre-flight: before caller SQL on any direct connection (re-asked every minute), the session user must not be a superuser nor able to `SET ROLE` to a superuser or BYPASSRLS role (membership checked with `pg_has_role`); otherwise the connection is refused with a `config` error. Fails closed. A login that itself holds BYPASSRLS (the `liaison_readonly` shape) is accepted. Opt-out only for a single-tenant database you own: `LIAISON_DB_ALLOW_PRIVILEGED_SESSION=true` (never applies to the demo warehouse). Redshift has no such roles and skips it. | `PostgresDirect` (`db/role-reach.ts`) |
| 13 | Host policy: link-local and cloud-metadata addresses are always refused; the instance's own redis, search and object-storage endpoints are refused, compared by resolved address and port (so another spelling of the same endpoint is refused too); a host that does not resolve is refused; `LIAISON_DATABASE_ALLOWED_HOSTS` (comma-separated `host` or `*.suffix`, empty = any) restricts the DSN host. Connection failures (refused, timed out, unresolvable, reset) all answer "Could not connect to the database", with the detail only in the server log. | `PostgresDirect`, `bridge.ts` |

---

## Restrict reports by domain

Every curated read names a `domain`. By default any member holding
`database:reads:read` runs every read. To keep some reports to some people,
give a domain a tier:

| Tier | Who runs the domain's reads |
|---|---|
| `internal` | Every member holding `database:reads:read` (the default) |
| `confidential` | Members holding one of the roles you choose |
| `restricted` | Only the people you choose |

Org admins and holders of `database:query:read` always run every read. Raw
queries (`db_query`) are not limited by tiers: they need
`database:query:read`, which only the connector's `admin` role holds.

Set the tiers in **Settings › Connectors › Database › Report access**: one row per domain
of the connected catalog, with its reads, a tier picker (the catalog's default
is marked) and role or person pickers. Save writes them all at once. You need
`kernel:apps:admin`. From config-as-code, use the database app entry's
`domainAccess` (see [Provisioning CLI](provisioning-cli.md#apps)).

A catalog can declare a default tier per domain:

```yaml
adapter: acme
domains:
  revenue: { tier: confidential }
  customers: { tier: restricted }
reads:
  revenue_by_month: { domain: revenue, ... }
```

The org's setting for a domain wins over the catalog's default. A domain with
neither is `internal`. A catalog without `domains` behaves exactly as before.

What a member's agent sees:

- `db_list_reads` leaves out the reads the person may not run.
- `db_read` on such a read answers `domain_restricted`, says the report is
  restricted, and tells the person to ask an admin for access in **Report
  access**.

The check is made for the person the agent acts for, also when another agent
asked it a question: that agent's turn runs as the person who asked. Jobs and
the Knowledge sync of database reads are not limited.

## 5. Catalog format reference

A `ReadCatalog` (`packages/db-core/src/catalog.ts`) is:

```ts
{
  adapter: string
  reads: {
    [name: string]: {
      description: string
      domain: string              // "licenses" | "moderation" | "health" | your own
      sql: string                 // SELECT/WITH only; named params as :foo
      params: {
        [paramName: string]: { type: "string"|"number"|"boolean"|"integer", description?: string }
      }
      columns: string[]           // non-empty column allow-list (projection layer)
      tables: string[]            // "schema.table" this read touches — drives grant rendering + db_describe
      maxRows?: number            // per-read cap, default 500, hard cap 2000
    }
  }
  domains?: {                     // optional default tier per domain (see "Restrict reports by domain")
    [domain: string]: { tier: "internal" | "confidential" | "restricted", description?: string }
  }
}
```

Rules enforced by `validateCatalog`:

- `sql` must start with `SELECT` or `WITH` (comment/whitespace-insensitive).
- Every `:name` in `sql` must have a matching entry in `params`, and vice
  versa (no unused params, no undeclared placeholders).
- `columns` must be non-empty and must not contain any `SECRET_COLUMNS`
  entry for a table named in `tables` (the belt — see [§6](#6-the-secret-column-checklist)).
- `tables` must be non-empty — it's what `grants-renderer.ts` uses to build
  the allow-list grant SQL, and what `db_describe` uses to restrict
  introspection.

The YAML mirror (used by db-gate's `catalog.yaml`) is the same shape —
see `apps/db-gate/catalog.example.yaml`.

---

## 6. The secret-column checklist

`packages/db-core/src/secret-columns.ts` exports `SECRET_COLUMNS` — the
exhaustive, hand-swept list of columns that must never appear in any read's
`columns` allow-list, regardless of adapter:

- Anything named `*_hash`, `*_encrypted`, `*_secret`, `password*`, `totp*`,
  `recovery*`, `*token*` in `kernel` or any `app_*` schema.
- Concretely (liaison's own schema): `kernel.users.{password_hash,
  totp_secret,recovery_codes}`, `kernel.oauth_providers.
  client_secret_encrypted`, `kernel.sessions.refresh_token_hash`,
  `kernel.mcp_connections.refresh_token_hash`, `kernel.password_resets.
  token_hash`, `kernel.invitations.token_hash`, `kernel.connected_accounts.
  {access_token_encrypted,refresh_token_encrypted,credentials_encrypted}`,
  `kernel.organizations.settings`, `app_mcp_manager.mcp_connections.
  secrets_encrypted`, `app_tickets.tickets.reply_token` (inbound-email auth
  token), `app_tickets.ticket_csat.survey_token`, `app_tickets.api_keys.
  key_hash`.

**This is the belt, not the wall.** The wall is the readonly role's grant —
these columns are never `GRANT SELECT`-ed to `liaison_readonly` in the first
place (see `readonly-grants.sql`), so even a catalog bug or a bypassed
validator hits Postgres error `42501` at the DB layer. When adapting the
connector to a different schema, run your own sweep over your target
database's `information_schema.columns` for anything that looks like a
credential/token/secret before writing your catalog — the authoring skill
(`.claude/skills/database-adapter-authoring/SKILL.md`) walks this as an
explicit step.

---

## 7. Authoring your own adapter

See `.claude/skills/database-adapter-authoring/SKILL.md` for the full,
agent-assisted flow. Summary: inventory the target schema → sweep for
secret-shaped columns → pick domains → write catalog reads → validate
(`validateCatalog`) → choose a connectivity rung → provision the role →
regenerate `readonly-grants.sql` → connect + `db_probe` → smoke-test each
read.

`apps/api/src/apps/database/adapters/__fixtures__/toy-shop.ts` is a tiny
(3-table) fixture adapter authored purely by following that skill — proof
that a third party can adapt the connector without reading its source. It is
a fixture, not a selectable production adapter: it registers into the same
`db-core` adapter registry as `liaison-self` for its own validation test,
but `LIAISON_DATABASE_ADAPTER` in any real deployment should never be
pointed at it.

---

## 8. Troubleshooting — probe outputs and what they mean

`db_probe` (and `scripts/db-readonly-role.ts --check`) return a report;
here's what each field means and what to do about it.

| Signal | Meaning | Fix |
|---|---|---|
| `ok: false`, `writeGrantsDetected: true` | The connected role has INSERT/UPDATE/DELETE (or other non-SELECT) grants on some table. Direct mode: you're probably connected as the app/superuser role, not `liaison_readonly`. | Re-provision with `scripts/db-readonly-role.ts --create` and use that role's DSN. |
| `ok: false`, `dangerousExecuteGrantsDetected: true` | The role can EXECUTE a function beyond the curated allow-list (e.g. `pg_sleep`, `dblink`) — function lockdown wasn't applied or was overridden after provisioning. | Re-run `scripts/db-readonly-role.ts --create` (idempotent; re-applies the REVOKE/GRANT EXECUTE block) or regenerate+apply `readonly-grants.sql` if the catalog changed. |
| `missingReads: ["name", ...]` (gate mode only) | The gate's `/catalog` doesn't have a read your adapter's local catalog expects — the gate's `catalog.yaml` is stale relative to what Liaison ships. | Update the gate's `catalog.yaml` to add the missing read(s), redeploy the gate, re-probe. |
| `warnings: ["Gate is missing N catalog read(s): ..."]` | Same as above, human-readable form. | Same fix. |
| Typed error `kind: "tls_required"` | You tried a direct DSN whose host resolves to a non-loopback/non-RFC1918 IP without `sslmode=require`. | Add `sslmode=require` (or `verify-*`) to the DSN, or move to a private-network/db-gate rung. |
| Typed error `kind: "auth"` | Wrong password/token — gate 401 or Postgres `28P01`/`28000`. | Re-check the credential; if it was rotated, make sure both sides (gate env + Liaison connection) were updated. |
| Typed error `kind: "unreachable"` | Gate is down, or the DSN host/port isn't reachable from the liaison container. | Check the gate container / network path. |
| Typed error `kind: "not_connected"` | No credentials saved for this org's `database` connection yet. | Connect the app first (§2). |
| Typed error `kind: "timeout"` (tool code `statement_timeout`) | `statement_timeout` (default 10s / 15s for the role-level setting, at most 55 s inside a tool call) fired, or the tool call ran out of budget and the bridge cancelled the statement — the query is too expensive or `pg_sleep`-shaped and rightly got cut off. | If it's a legitimate slow read, consider narrowing the `WHERE` or paging via `maxRows`; this is not a bug to "fix" by raising the timeout casually. |
| `db_query` error `code: "disabled"` | This deployment explicitly opted out (`LIAISON_DATABASE_ALLOW_RAW_QUERY=false`). | Remove the opt-out env var if the deployment wants the raw-query surface back (it's on by default; still grant-restricted). |
| `db_query` / raw SQL rejected with a sql-guard code (e.g. `multi_statement`, `not_select`, `dangerous_function`) | The SELECT-only validator caught a hostile or malformed shape before it ever reached Postgres. | Rewrite the query as a single `SELECT`/`WITH ... SELECT`; if it needs a function on the denylist, that function is blocked by design — use a curated read instead. |
| `db_query` / raw SQL rejected with code `query_too_long`, or a `sql` parameter error | The statement is over the 100,000 character limit. | Shorten it, or split it into smaller queries. |
| Postgres `42501` surfaced directly (e.g. via `db_describe` or a `db_query` result) | The grant layer itself refused — a table/column outside the allow-list. This is the primary wall doing its job, not a misconfiguration to route around. | Add the table/column to the catalog (if it should be readable) and regenerate `readonly-grants.sql`; do not attempt to work around this at the app layer. |

---

## 9. "Add a read" runbook (grant-model implication)

Because the readonly role uses a fail-closed **allow-list** grant model
(never `GRANT SELECT ON ALL TABLES`, no blanket `ALTER DEFAULT PRIVILEGES`),
**a newly migrated table is invisible to `liaison_readonly` until it's
explicitly added to the catalog and the grants are regenerated.** This is
intended fail-closed behavior, not a bug. Whenever you add or change a
catalog read:

1. Edit the adapter's `ReadCatalog` (add/adjust the read, its `columns`,
   its `tables`).
2. Run `bun run scripts/db-readonly-role.ts --regenerate` — it renders the
   grants fresh from the current catalog via `grants-renderer.ts` and WRITES
   the single checked-in file `apps/api/src/apps/database/generated/
   readonly-grants.sql` (the same file `deploy/postgres-init/
   20-readonly-role.sh` executes via a bind mount — there is no second copy
   to keep in sync).
3. Commit the updated `readonly-grants.sql`. `bun run check:grants` (=
   `scripts/db-readonly-role.ts --check-sync`) re-renders from the catalog
   and diffs against the checked-in file WITHOUT writing — wire it into CI
   so a catalog change that forgot step 2 fails the build instead of
   silently drifting.
4. Re-run `scripts/db-readonly-role.ts --create` against each live cluster
   (idempotent — safe to re-run; it re-applies the full grant set,
   including any newly added tables/columns) so the role catches up. This
   step queries a LIVE database and is unrelated to `--check-sync`, which
   is purely a catalog-vs-checked-in-file diff (no DB connection).
5. `db_probe` to confirm.

---

## 10. Related docs

- `apps/db-gate/README.md` — db-gate env vars + routes quick reference.
- `.claude/skills/database-adapter-authoring/SKILL.md` — the authoring flow.
- `docs/app-development.md` — general app-building guide (this connector
  follows the same in-tree bridge-extension pattern as `gitlab`).
- `docs/sdk-gaps.md` — raw-DB connections as a potential first-class
  connection type (this connector exists precisely because that gap isn't
  closed yet — see the entry there for why bundled-app packaging was
  rejected).
