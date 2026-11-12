# example — Liaison reference app

The canonical "every-feature" sample app. It exists to be read: each handler
demonstrates exactly one SDK surface in the smallest possible code. Both
`docs/app-development.md` and the `creating-an-app` Claude skill point here.

It is a test fixture: it lives in `apps/api/test-support/apps/`, which the
production image does not carry, and is discovered in development and test
only (`TEST_ONLY_APPS`, `modules/apps/discover-apps.ts`).

## What each handler teaches

| Handler | SDK surface | What to copy from it |
|---|---|---|
| `items_list` | `ctx.db.findMany` | Reading your app's entity rows, scoped to the org |
| `items_create` | `ctx.db.insert` + `ctx.emit` | Persisting a row and emitting a domain event |
| `external_fetch` | `ctx.connections` + `ctx.fetch` | Calling an external API with a connection token |
| `resolve_contact` | `ctx.resolveContact` | The contacts integration surface |
| `nightly_summary` | manifest `jobs` + `ctx.emit` | A scheduled (cron) background job |

## Layout

| File | Purpose |
|---|---|
| `app.manifest.json` | Entity schema, tools, events, the `nightly_summary` job, scopes |
| `manifest-descriptor.ts` | TS descriptor — wraps the manifest + handler bundle path |
| `handlers.ts` | The five teaching handlers |
| `handlers.test.ts` | One test per handler, driven by `mockAppContext` |

The matching frontend panel lives at `apps/web/src/modules/example/`.

See [docs/app-development.md](../../../../../docs/app-development.md) for the
full developer guide.

## Connecting

**No connection required** — the example app declares no `connections` block; its
`external_fetch` handler demonstrates the outbound-fetch surface without a
stored credential. For the shared connection machinery real connectors use, see
[docs/connecting-apps.md](../../../../../docs/connecting-apps.md).
