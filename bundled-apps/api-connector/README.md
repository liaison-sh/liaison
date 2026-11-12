# api-connector — connect an ERP, a CRM or any HTTP API

A catalog app over the platform-held API connections (`ctx.api`,
`apps/api/src/modules/apps/connections/api/`). Each connection is an
**adapter document** (the API's base URL, its auth type and a fixed list of
named operations) plus the credentials that auth type needs, under its own
slug (`crm`, `erp`). The platform stores the adapters in this app's tables,
holds the credentials, sends every call and checks the caller's scopes; this
app never sees a credential.

## What it ships

| Piece | Where |
|---|---|
| Agent tools: `connector_list_operations`, `connector_read`, `connector_write` (gated), the authoring reads `connector_adapter_get` / `_versions` / `_reference` / `_test` | `src/handlers.ts` |
| The adapter save and restore (`connector_adapter_save` / `_restore`, decided by `api-connector:admin`) | the platform's tools for an API connection (`connections/api/authoring-tools.ts`) |
| Settings screen: connections, adapter editor, credentials, test panel, history | `src/ui/ApiConnectorAdapters.tsx` and its panels, over the UI-only tools `settings_*` |
| Customer card on tickets and mail (contributions `ticket:detail:panel`, `mail:conversation:banner`) | `src/ui/CustomerCard.tsx`, `src/ui/mounts.tsx`, tool `customer_lookup` |
| `config apply` provisioning (`provision.connectors`) and `config verify` | `provisionApiConnector`, `verifyApiConnector` in `src/handlers.ts` |

Credentials are typed in the host's credential dialog for one account
(`app.openConnectDialog({ connectionName: "api", identifier, fields })`) or with
`config apply` (`apps[].connections`). See `docs/api-connector.md`.

## Tests

`bun run scripts/test-run.ts bundled-api-connector` (handlers over a fake
`ctx.api`, the manifest, the params form). The platform side is tested in
`apps/api/src/modules/apps/connections/api/`; contract fixtures are recorded
with `apps/api/scripts/contract/record-api-connector.ts`.
