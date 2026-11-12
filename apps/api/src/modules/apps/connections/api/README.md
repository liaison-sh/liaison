# Platform-held API connections (`ctx.api`)

The HTTP APIs the platform holds the connection to, for the app that declares
a credentials connection with an `api` block (today the catalog app
`bundled-apps/api-connector`). Each account of that connection is an
**adapter document** (the API's base URL, its auth type and a fixed list of
named operations) plus the credentials that auth type needs, under its own
slug. App code reaches it through the `api_*` bridge methods (`bridge.ts`),
which check the caller's scopes against the block's read, write and admin
scopes; kernel features (the agent's customer context and connected systems,
API import sources, secret requests, setup state, config export) read it
directly.

The adapter format is defined in `packages/api-connector-core` (zod schema,
published as `adapter.schema.json`); `docs/api-connector.md` is the reference.

## Pieces

| File | Role |
|---|---|
| `app.manifest.json` | One `multiInstance` credentials connection (`api`), the `adapters` table (runtime DDL), roles and scopes |
| `store.ts` | Adapter rows and the connection's org-owned credentials |
| `transport.ts` | One operation call: render, auth, SSRF-guarded fetch, caps, projection, pagination |
| `service.ts` | Resolve connection + operation for a mode (read / write / test), call, audit |
| `adapter-policy.ts` | The deployment's host rules applied to every server-side validation (token host classifiers, the private-hosts flag) |
| `customer.ts` | The customer resolver (email, phone, company domain; no free-mail or own domain) behind the card and the agent's context |
| `consumer-domains.ts` | The consumer mail domains the resolver never falls back to |
| `cache.ts` | Redis caches (oauth2 token, customer lookups) keyed by the adapter hash and the credential version (an HMAC of the account row) |
| `bridge.ts` | The `api_*` bridge methods (`ctx.api.*`): agent tools, the settings screen's and the card's reads and writes, provisioning and verify |
| `authoring-tools.ts` | The adapter save and restore, registered for the app that declares the connection, decided by its admin scope |
| `registrations.ts` | The generic credentials route's check for an account, and the demo responder |

## Scopes

App-wide, not per connection: `api-connector:read` and `api-connector:write`
(members), `api-connector:admin` and `api-connector:accounts:admin` (admins).

## Settings and the customer card

No kernel routes: the app's settings screen and its customer card call the
app's own UI-only tools (`settings_connections`, `settings_adapter_save`,
`settings_adapter_restore`, `settings_adapter_delete`, `settings_adapter_test`,
`customer_lookup`), which call `api_connections`, `api_adapterPut`,
`api_adapterRestore`, `api_adapterDelete`, `api_adapterTest` (`raw: true`) and
`api_customer` here.

- Credentials: `POST /api/connections/api-connector/api/credentials` with
  `{mode: "org", credentials: {identifier, ...fields}}` (the host's credential
  dialog for one account); the fields must be exactly those of the adapter's
  auth type (`apiKey`; `token`; `username`+`password`; `clientId`+`clientSecret`).
  The oauth2 token URL is part of the adapter, never a credential.
- Calls to one connection share the platform's per-connection limiter
  (connection-limiter.ts): the connection's declared `limits`, 4 in flight.

## Safety

- https only; plain http only to a loopback host and only with
  `LIAISON_ALLOW_PRIVATE_API_CONNECTOR_HOSTS=true` (development), which also
  lets private addresses through. Link-local and metadata addresses are always
  refused. Every redirect hop must stay on the adapter's host.
- 15 s per request, 2 MB response cap (streamed), 200 items per call, at most
  5 pages within a 45 s budget.
- Responses are projected to each operation's `fields` (leaf values only).
- An upstream error reports its status and a fixed message, never the body;
  credential values are redacted from every message the transport builds; the
  audit row is built from the connection and operation names.
- Demo orgs: adapter upload, removal and credentials are refused; the seeded
  fixture connection (`modules/demo/api-connector/`) is answered in-process by
  the demo responder, and any other request is refused before leaving the box.

## Agent tools

`connector_list_operations` and `connector_read` (read scope, read-only,
taint sources) and `connector_write` (write scope, approval-gated, external
impact). Each has a 60 s sandbox budget. Read results are fenced as external
content. On a ticket or a mail conversation in view, the agent also receives
the matched customer's summary (`modules/agent/context/customer-context.ts`)
when its turn holds the read scope; that injection taints the turn like a
`connector_read`.

## Provisioning and CLI

- `liaison config apply`: the app's `provision.connectors` (adapters, inline or
  `{ $file }`) and its entry's `connections` (credentials with `${VAR}`
  references), idempotent; `config verify` runs the app's check (`api_verify`):
  each connection with a parameterless read that is not the `customer.lookup`.
- `liaison api-connector validate <file>` and
  `liaison api-connector test <identifier> <operation> [--param k=v]` (read
  operations only).

See `docs/provisioning-cli.md`.
