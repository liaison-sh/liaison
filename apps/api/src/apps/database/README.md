# database — read-only SQL connector

A **headless connector** that gives agents read-only access to a deployment's own
SQL database for troubleshooting and support questions (licenses/subscriptions,
moderation surfaces, instance health). It owns no UI beyond a Settings pane and
no app tables — it is a thin, safe window onto whatever database you point it at.

Safe by construction: writes are impossible, and secret/credential columns
(tokens, password hashes, signed licenses, API secrets) are not granted to the
role, so selecting one returns a permission error rather than data. The schema is
**deployment-specific** — there is no assumed `licenses`/`organizations`/`orders`
table; the agent discovers the real shape with `db_describe` before querying.

## Tools

| Tool | What it does |
|---|---|
| `db_list_reads` | List the catalog's named, curated reads (call first to discover them). |
| `db_read` | Run one named, parameterized curated read; output restricted to its declared column allow-list. |
| `db_describe` | No argument: the readable tables with their column counts (narrow with `schema` or `search`). `table: "schema.table"`: that table's columns and types. Secret columns are filtered out. |
| `db_probe` | Run the connect-time safety probe on demand — reports unexpected write/EXECUTE grants and catalog drift (gate mode). |
| `db_query` | Run a raw single-statement SELECT (or `WITH … SELECT`). Same read-only role restrictions as curated reads. Deployment can disable with `LIAISON_DATABASE_ALLOW_RAW_QUERY=false`. |

Roles: `member` (curated reads), `admin` (adds raw `db_query` when the deployment
opts in).

## Connecting

Read [`docs/connecting-apps.md`](../../../../../docs/connecting-apps.md) first for
the shared connection machinery (credentials type, ownership, the
`not_connected`-for-others isolation gotcha). This section is the
database-connector-specific runbook.

**Connection:** one `credentials` connection named `database`, with three
**optional** fields. You pick **exactly one of two wiring modes** — never both:

| Field | Mode | Meaning |
|---|---|---|
| `connectionString` | **direct** | A Postgres DSN. Leave `gateUrl`/`gateToken` empty. |
| `gateUrl` + `gateToken` | **gate** | A liaison-db-gate sidecar URL and its bearer token. Leave `connectionString` empty. |

All three are declared optional so the form accepts either shape; the connector
refuses a connection that supplies neither or both.

**Optional second connection, `warehouse`:** direct only (`connectionString`,
plus `dialect` `postgres`|`redshift` and an optional `statementTimeoutMs`), for
raw read-only SELECT over a warehouse or a replica. Agents select it with
`connection: "warehouse"` on `db_describe` / `db_query` / `db_probe` (all three
then require `database:query:read`); without the param every tool uses the
default connection. It resolves only as the org-owned account with the fixed
identifier `warehouse`. See
`docs/database-connector.md` §1 "A second connection" for the config-as-code
shape and the Redshift specifics.

### Mode 1 — direct connection string

For a database on the same machine/private network, or a hardened public
endpoint:

1. Mint a **read-only role** (`scripts/db-readonly-role.ts --create`) — do not
   paste a superuser or app DSN.
2. Paste its DSN into `connectionString`.
3. For a **public** endpoint the DSN must require **TLS** — the connector refuses
   plaintext to any non-local resolved IP.

### Mode 2 — db-gate URL + token (recommended across untrusted networks)

When the database is behind an untrusted network (or the DB's devops won't hand
out a DSN), stand up the `liaison/db-gate` sidecar next to the database:

1. Give the gate a `catalog.yaml` (the curated reads) and mint a bearer token.
2. Paste the gate's URL into `gateUrl` and the token into `gateToken`.
3. A gate on a private or loopback address (a sidecar on the same network) is
   the operator's opt-in: list its host in `LIAISON_DATABASE_ALLOWED_HOSTS`.
   A redirect from the gate is refused, never followed.

The gate holds the real DSN; Liaison only ever sees the gate. This is the
recommended posture for anything crossing an untrusted boundary.

### After connecting

`db_probe` runs automatically on connect and reports any write/EXECUTE grants
beyond the read-only allow-list — **review its warnings** before relying on the
connection. Re-run it any time with the `db_probe` tool.

**Ownership:** for a shared database an agent must reach on behalf of anyone,
connect it **org-owned** (`mode: "org"`, needs `database:accounts:admin`). A
user-owned connection returns `not_connected` for every other user and for an
agent acting as someone else — see the isolation note in the central doc.

### The public demo instance

The demo box connects this app WITHOUT storing a credential, because a demo org
may not hold one. The seeded connection's `connectionString` is a fixed sentinel
(`liaison-demo-warehouse-not-a-dsn`), and at call time
`modules/demo/warehouse/resolve.ts` swaps it for the warehouse's OWN DSN
(`LIAISON_DEMO_WAREHOUSE_DATABASE_URL`): a dedicated LOGIN role that is a member
of no Liaison role and holds SELECT on the `demo_warehouse` schema and nothing
else. It runs on its own connection, never the application's, so even a query
that slipped past the read-only guard has no privileged role to step into. The
transport refuses to run when the variable is unset. Provisioning creates the
role from that DSN's user and password. Two gates guard it: demo mode on the process, and
the demo marker on the org. Build it with `apps/api/src/seed/tiers/demo/seed-warehouse.ts`,
which the demo seed runs as one of its layers.

### Failure modes

| Error | Cause | Fix |
|---|---|---|
| `not_connected` | No `database` connection resolvable for the caller | Connect it (and org-own it if a shared agent must reach it). |
| Permission error on a column | That column is secret/off the read-only grant | Select the readable columns `db_describe` showed you. |
| Plaintext refused | A non-local DSN without TLS | Require TLS on the endpoint (direct mode) or use db-gate. |
| db-gate on a private or loopback address needs the operator's opt-in | The gate host is private and not allow-listed | List the gate host in `LIAISON_DATABASE_ALLOWED_HOSTS`. |
