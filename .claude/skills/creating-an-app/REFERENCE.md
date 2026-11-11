# Creating a Liaison App — Pattern Reference

Companion to `SKILL.md`. Each pattern is cross-referenced to the reference app
at `apps/api/src/apps/example/`. When in doubt, the reference app is the truth;
`docs/app-development.md` is the prose.

## Manifest anatomy

`app.manifest.json` declares the whole app. Top-level keys:

| Key | Purpose |
|---|---|
| `name`, `version` | identity (kebab-case name, semver version) |
| `description` | one-line summary |
| `packageFormat`, `license` | distribution metadata |
| `host` | the host API range the app needs (`"^1"` when absent); the server refuses an app it cannot satisfy |
| `iconSvg` / `iconName` | the app's icon as data: plain SVG markup (at most 8 KB, refused at install if it holds anything but drawing markup) or a name from Liaison's icon set; the desktop and phone apps draw it where the app's own icon component never runs (`docs/app-package-format.md`, "App icon") |
| `scopes` | the capability strings the app requests |
| `schema` | entity tables — fields, dimensions, searchable columns |
| `entities` | per-entity UI/registry metadata (`labelField`, `readScope`, …) |
| `tools` | tool record — each entry has `description`, `requiredScopes` (non-empty list), `handler`, `params` |
| `events` | `emits` (events this app raises) and `subscribes` |
| `jobs` | scheduled background jobs (`schedule` cron + `handler`) |

A `.liaisonapp` manifest is validated against the stricter `packageManifestSchema`
(`packages/app-sdk/src/package-format.ts`); in-tree apps are validated against
the runtime manifest schema. Keep both happy — `apps/api/src/apps/example/` does.

## Entity declaration

```json
"schema": {
  "items": {
    "fields": { "text": "string", "createdBy": { "type": "uuid", "required": false } },
    "searchable": ["text"]
  }
}
```

The kernel creates a `app_<name>.items` table with RLS. Read it via
`ctx.db.findMany("items", { where: { orgId: ctx.orgId } })`.

## Tool handlers

Each tool's `handler` string names an export in `handlers.ts`. The handler is
`(params, ctx) => Promise<result>`:

```typescript
export async function items_create(params: { text: string }, ctx: AppContext) {
  const id = crypto.randomUUID()
  await ctx.db.insert("items", { id, text: params.text, orgId: ctx.orgId })
  await ctx.emit({ entity: "item", action: "created", entityId: id })
  return { id }
}
```

See `apps/api/src/apps/example/handlers.ts` for `items_list`, `items_create`,
`external_fetch`, `resolve_contact`, and `nightly_summary` — one per surface.

## Events

Declare `events.emits` in the manifest, then `await ctx.emit({ entity, action,
entityId, data })`. Other apps subscribe via `events.subscribes`.

## Connections (external APIs)

Declare a `connection` (`oauth2` or `credential`). The kernel owns the token
lifecycle. In a handler: `const token = await ctx.connections.<name>.getToken()`.
The client secret never reaches your code.

## Scheduled jobs

```json
"jobs": { "nightly_summary": { "schedule": "0 0 * * *", "handler": "nightly_summary" } }
```

The handler runs on the cron schedule with a fresh `ctx`.

Say which orgs it is for with `runsFor`, so an org with nothing to do takes no
sandbox worker (the kernel checks it for all orgs at once before it enqueues):

```json
"sync": { "schedule": "*/5 * * * *", "handler": "sync", "runsFor": { "connection": "shop" } }
"retry": { "schedule": "*/5 * * * *", "handler": "retry",
  "runsFor": { "rows": { "entity": "parked", "where": { "status": { "in": ["open", "blocked"] } } } } }
"digest": { "schedule": "0 9 * * *", "handler": "digest", "runsFor": { "everyOrg": "Every org gets a morning digest." } }
```

`connection` names one of the app's connections (or `"<app>:<connection>"`):
the org needs an active connected account for it. `rows` names one of the
app's entities: the org needs a row matching `where` (equality, `null`,
`{ "in": [...] }`, `{ "not": null }`). Give both, or lists, and any one is
enough. The condition only has to be necessary: the handler still decides.

## Long work

A run is short and bounded (a job: its `timeoutMs`, 60 s by default). Long work
is done in chunks across runs, never by sleeping or looping inside one run:

```json
"jobs": { "backfill": { "onDemand": true, "handler": "backfill" } }
```

```ts
// A tool or webhook starts it:
await ctx.jobs.enqueue("backfill", { shop }, { jobId: `backfill:${shop}` })

// The job does one bounded slice per run and saves where it is:
export async function backfill(p, ctx) {
  return ctx.steps.run(`backfill:${p.shop}`, { budgetMs: 20_000 }, async (cursor) => {
    const page = await fetchPage(ctx, p.shop, cursor)
    await upsert(ctx, page.items) // safe to repeat for the same cursor
    return { done: !page.next, cursor: page.next }
  })
}
```

- `ctx.steps.run` keeps the cursor in the app data store, calls the chunk while
  `budgetMs` lasts, then re-enqueues the same job, which continues from the
  cursor. Two runs never run a chunk of one step at once; a chunk whose run died
  runs again, so make it idempotent. Not in an `atomic` job.
- A provider that is "not ready yet": return `{ done: false, cursor, wakeIn: 30 }`
  from the chunk, or call `ctx.timers.wakeIn(30, "poll", payload)`.
- `ctx.jobs.enqueue(name, payload, { delay, jobId })`: `delay` in ms, 15 min at
  most; `jobId` deduplicates while the job waits or runs.
- `ctx.steps.get(name)` for a status view, `ctx.steps.reset(name)` to start over.

## Testing

`mockAppContext` (`~/modules/apps/test-helpers`) is a deterministic `AppContext`
substitute. It tracks `emit` calls, enqueued jobs and timers (`_jobs`), and `db`
writes so tests can assert side-effects; its `steps.run` runs the chunks back to
back until done. See `apps/api/src/apps/example/handlers.test.ts`.

## Packaging

`bun run app:freeze <name>` builds the handler bundle into an isolated staging
dir and tars it with the manifest — the source tree stays clean.
`bun run app:sign <tarball>` adds a cosign signature. The full layout is in
`docs/app-package-format.md`.

## The SDK gap rule

If the SDK can't express what you need, file a row in `docs/sdk-gaps.md` and
extend the SDK. Never reach around the sandbox. This is non-negotiable — it is
how the platform stays coherent as apps grow.
