# __APP_CLASS__

__APP_DESCRIPTION__

This is a Liaison plugin app. See
[docs/app-development.md](../../../../docs/app-development.md) for the full
developer guide — scaffold, develop, test, freeze, and publish.

## Layout

| File | Purpose |
|---|---|
| `app.manifest.json` | App metadata, schema, tools, scopes |
| `manifest-descriptor.ts` | TS descriptor wrapping the manifest + bundle path |
| `handlers.ts` | Tool handler implementations |
| `handlers.test.ts` | Handler unit tests |

The matching frontend panel lives at `apps/web/src/modules/__APP_NAME__/`.

## Develop

```bash
bun dev                              # auto-discovers this app
bun test apps/api/src/apps/__APP_NAME__/   # run handler tests
```

## Ship

```bash
bun run app:freeze __APP_NAME__      # → dist/apps/__APP_NAME__-0.0.1.liaisonapp
bun run app:sign  dist/apps/__APP_NAME__-0.0.1.liaisonapp
```
