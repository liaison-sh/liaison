---
name: build-app
type: skill
description: Build a small custom app for the organisation (a tracker, a log, a list) and publish it.
requiredScopes: kernel:apps:build
---

### Building an app

An app is a draft of up to four files, built and checked on the server, tried as you without installing it, then published as the organisation's own app once a person approves. Every change is a new version of the draft (the last 20 are kept).

Always in this order:

1. **Create** from a template: `kernel__apps_build_create({ base_name, title, template })`. `store-crud` gives one stored collection `items` with a list tool and an add tool; `read-only` gives one read tool. Both work as they are. The result names the app (`appName`, e.g. `returns-o1a2b3c4`): every scope and store read scope starts with it.
2. **Change** it: `kernel__apps_build_update({ draftId, files, message })`, whole files only. Rename the collection, add fields, add tools.
3. **Check**: `kernel__apps_build_check({ draftId })` builds it and type-checks it against the app SDK. Fix every error (each has its file and line) and check again until `ok`.
4. **Preview** each tool: `kernel__apps_build_preview({ draftId, entry: { kind: "tool", name }, params })`. It runs as you and changes nothing real. `ctx.store` works on a scratch space of this draft, emptied at its next preview (so a write then a read is two previews: preview the write, read its result). Before the first publish `ctx.db` and `ctx.fetch` are not available; after it, only the hosts the published version was granted. Read the result and `logs`.
5. **Publish**: `kernel__apps_build_publish({ draftId })`. It waits for a person holding `kernel:apps:admin`, who sees the name, version, package sha and what access changes. Say it is waiting, with its handle; never that it is done. To change something after asking, withdraw the request and publish again.
6. **After it is approved**: find the app's tools with `kernel__tool_search` (its name or a tool name) and call them with `kernel__call_tool`. Members get the app's member scopes automatically (Full Member) and the app is On. Its logs: `kernel__apps_build_logs({ app })`.

To change a published app: update, check, preview, publish again (the next patch version). To go back: `kernel__apps_build_restore({ draftId, n })`, then publish; tables it no longer declares are kept with their data.

### The files

- `app.manifest.json` (required): the app's declaration (below).
- `handlers.ts` (required): one exported `async function` per handler, `(params, ctx)`, and `export default defineHandlers({ ... })`. Imports only from `@liaison/app-sdk`.
- `ui.tsx` (optional): a Solid component as the default export; it runs framed, with no session.
- `README.md` (optional).

At most 512 KiB together. The server sets `name` and `version`: what you write there is replaced.

### Manifest fields

- `packageFormat: 1`, `host: "^1"`, `license`, `displayName`, `description`.
- `scopes`: the app's own scopes, `<appName>:<resource>:<action>` (`returns-o1a2b3c4:returns:read`).
- `tools.<name>`: `description`, `handler` (the export name), `requiredScopes` (from `scopes`), `params` (a JSON Schema object: `type`, `properties`, `required`), `readOnly: true` for a read.
- `store.collections.<name>`: `{ readScope, agentReadable?, searchable?: { labelField, fields } }`. Collection names are lowercase letters, digits and `_`. `readScope` is one of the app's scopes; `agentReadable: true` lets the agent's data tools and dashboards read it.
- `jobs.<name>`: `{ schedule: "<cron>", handler }`. `webhooks.<name>`: `{ handler, verify }`.
- `network.allowedDomains`: the hosts `ctx.fetch` may reach (a person approves them at publish).
- `secrets.<configKey>`: `{ hosts: [...], in: "header:<Name>" | "query:<param>" | "body:<jsonPath>" }`: where a secret may be sent. App code never reads a secret.
- Not allowed in an organisation's app: `trusted`, routes, triggers, raised timeouts, PDF templates, instance capabilities.

### ctx in handlers

- `ctx.store.get/set/update/delete/query/count(collection, ...)`: JSON documents of at most 256 KiB, keyed by id. `set(c, id, data, { ifVersion: 0 })` creates only; `query(c, { where, orderBy: { field, dir }, limit, cursor })` pages with `nextCursor`.
- `ctx.logger.info/warn/error/debug(message, data?)`: kept 7 days, read with `kernel__apps_build_logs`.
- `ctx.fetch(url, { method, headers, body })`: allowed hosts only.
- A handler returns plain JSON. To refuse, return `{ error: { code, message } }`.
