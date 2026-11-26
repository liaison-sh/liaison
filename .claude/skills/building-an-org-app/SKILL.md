---
name: building-an-org-app
description: Build, test, publish and update a custom app for one Liaison organization from Claude Code or Codex, through the Liaison MCP server's app builder tools (kernel__apps_build_*), with no server access and no repo checkout. Use when someone on a hosted Liaison org (or any server with custom apps on) asks "build me an app that does X for our org", or wants to change, test, roll back or read the logs of an app they built that way. For an app inside a Liaison fork or a self-hosted checkout, use creating-an-app instead.
---

# Building an app for a Liaison organization

You are building a small app (a tracker, a log, a list, a read of an outside
API) for the organization the person's Liaison MCP connection belongs to. The
server builds, checks, previews and installs it. You send whole files as tool
parameters; nothing runs on this machine and you need no Liaison source.

Two paths exist. Pick one before anything else:

| The person has | Path |
|---|---|
| A Liaison account on a hosted org, or a server with custom apps on, and an MCP client | **This skill**: the app builder over MCP. |
| A fork or checkout of the Liaison repo and their own server | `.claude/skills/creating-an-app/SKILL.md`: an in-tree app, frozen and installed by the operator. |

## 1. Prerequisites (check them, in this order)

1. **The MCP connection.** Liaison's MCP server is `<the org's Liaison address>/mcp`.
   - Claude Code: `claude mcp add --transport http liaison https://<org address>/mcp`, then
     approve the connection in the browser page Liaison opens.
   - Codex or another client: add the same URL as a Streamable HTTP MCP server with OAuth
     in the client's MCP settings, and approve it the same way.
   - The token lasts 15 minutes and refreshes by itself; it works on that org's address only.
2. **The tools.** Look for `kernel__apps_build_create` in your tool list, or call
   `liaison_tool_search` with `"app builder"`. If no `kernel__apps_build_*` tool exists:
   - the person lacks the scope `kernel:apps:build` (an admin role holds it): say so, and
     offer `kernel__request_scope` for `kernel:apps:build`, or ask an admin;
   - or the server has custom apps off (the default on a self-hosted server; its operator
     turns them on with `LIAISON_CUSTOM_APPS=on`). Say which one you think it is; never
     build a substitute out of skills or routines.
3. **Who publishes.** Publishing is approved by a person holding `kernel:apps:admin`
   (an org admin). It is never automatic, even when the person asking is that admin.
   Tell the person early that the last step waits for that approval.
4. **The server's own guide.** If `kernel__skill_read` with `name: "build-app"` answers,
   read it: it is the server's version of this loop and wins where the two differ.

## 2. The loop

Always in this order. Every tool answers `{ error: { code, message, status, retryable, details? } }`
when it refuses (section 6 says what to do about each code).

| Step | Tool | Input | Returns |
|---|---|---|---|
| Start | `kernel__apps_build_create` | `base_name` (`^[a-z][a-z0-9-]{1,40}$`), `title` (1-200 chars), `template` (`store-crud` or `read-only`, default `store-crud`) **or** `files` | `draftId`, `appName`, `n`, `files` |
| Change | `kernel__apps_build_update` | `draftId`, `files`, `message` (≤ 500 chars), `mode` (`patch` default, or `full`), `title`? | `draftId`, `n`, the file names |
| Check | `kernel__apps_build_check` | `draftId`, `n`? | `ok`, `errors[]` (file, line, message, code), `typecheck` (`ok`, `errors[]`), `appName`, `appVersion`, `packageSha256`, `sizeBytes` |
| Try | `kernel__apps_build_preview` | `draftId`, `n`?, `entry: { kind: "tool" \| "job" \| "webhook", name }`, `params`?, `freshStore`? | `ok`, `result`, `error`, `logs[]`, `runId`, `storeWiped`, `neverPublished` |
| Read | `kernel__apps_build_get` | `draftId`, `n`? | status, `appName`, files, the version's build |
| List | `kernel__apps_build_list` | `includeDiscarded`? | the org's drafts |
| History | `kernel__apps_build_versions` | `draftId` | the kept versions, newest first |
| Publish | `kernel__apps_build_publish` | `draftId`, `n`? (never pass `pin`: the server sets it) | a pending approval with its `approvalHandle` |
| Logs | `kernel__apps_build_logs` | `draftId` (your own preview runs) **or** `app` (the published app; needs `kernel:apps:logs`), `since`?, `level`?, `runId`?, `limit`? (1-200) | `lines[]`, newest first |
| Go back | `kernel__apps_build_restore` | `draftId`, `n` | the old files as version n+1 |
| Drop | `kernel__apps_build_discard` | `draftId` | the draft is gone; a published app stays installed |

1. **Start from a template**, even when you will replace it: `create` returns the
   `appName` (`<base_name>-o<8 hex of the org>`, for example `visit-log-o1a2b3c4d`) that every
   scope and store `readScope` must start with. You cannot pick it and cannot guess it.
2. **Write the real files** with `update`. Send each changed file whole, never a diff.
   `mode: "patch"` changes only the files you send (`null` removes `ui.tsx` or `README.md`);
   `mode: "full"` makes the files you send the whole draft.
3. **Check until `ok` is true.** `ok` is false when the build fails or the type check
   does. Fix every error at the file and line it names, `update`, `check` again.
4. **Preview every tool** (section 5), read `result` and `logs`, fix, update, check, preview.
5. **Publish.** Check first. Report the result as **waiting for approval**, with its
   `approvalHandle`, and who decides it (a person with `kernel:apps:admin`). Never say it is
   installed. `liaison_approval_status` tells you whether it was decided.
6. **After approval**, the app is On and members get its member scopes. Its tools are named
   `<appName>__<tool>`: find them with `liaison_tool_search` (the app name) and run them with
   `liaison_call_tool` (your tool list was fixed when the session started). Its page is in
   the org's activity bar, if it has one.
7. **Update** the same way: `update`, `check`, `preview`, `publish`. Each publish is the next
   patch version (0.1.0, 0.1.1, ...) and needs a new approval. To change a request already
   waiting, withdraw it (`kernel__approval_withdraw`) and publish again: it cannot be edited.
8. **Roll back** with `restore` to the good version `n`, then `check` and `publish`: it ships as
   a new patch version. Tables the restored version no longer declares are kept with their data.

## 3. The files

A draft has at most four files, **512 KiB together**, and no others:

- `app.manifest.json` (required): the declaration.
- `handlers.ts` (required): one exported `async function` per handler, `(params, ctx)`,
  and `export default defineHandlers({ ... })`. It imports only from `@liaison/app-sdk`.
- `ui.tsx` (optional): the page, a Solid component. It imports only from `solid-js`
  (and `solid-js/web`, `solid-js/store`), `@liaison/host`, `@liaison/app-ui` and
  `@liaison/app-sdk`.
- `README.md` (optional).

The server writes `name` and `version` into the manifest: whatever you put there is replaced.

**Manifest fields you will use:**

- `packageFormat: 1`, `host: "^1"`, `license` (for example `"UNLICENSED"`), `displayName`, `description`.
- `scopes`: the app's own scopes, `<appName>:<resource>:<action>`.
- `tools.<name>`: `description`, `handler` (the export name in `handlers.ts`),
  `requiredScopes` (a non-empty list taken from `scopes`), `params` (a JSON Schema object:
  `type: "object"`, `properties`, `required`, `additionalProperties: false`), `readOnly: true`
  for a tool that only reads.
- `store.collections.<name>`: `{ readScope, agentReadable?, searchable?: { labelField, fields } }`.
  The name is lowercase letters, digits and `_`; `readScope` is one of the app's scopes;
  `agentReadable: true` lets the agent's data tools and dashboards read it.
- `jobs.<name>`: `{ schedule: "<cron>", handler }`. `webhooks.<name>`: `{ handler, verify }`.
- `network.allowedDomains`: every host `ctx.fetch` may reach. The approver sees and grants them.
- `secrets.<configKey>`: `{ hosts: [...], in: "header:<Name>" | "query:<param>" | "body:<jsonPath>" }`:
  where the server may put a secret. The code never reads a secret.
- `connections.<name>`: an OAuth2 or credentials connection; it must list `allowedDomains`.
- `iconName`: an icon of Liaison's set (for example `clipboard-list`, `box`, `calendar`,
  `bar-chart`, `truck`, `wallet`), or `iconSvg` (plain SVG, at most 8 KB).
- `views`: the page (section 4). A page shows only when `views.tabTypes.<type>.component`
  names a **named export** of `ui.tsx`; a default export alone shows nothing.

**Refused in an organization's app** (`check` names it, code `custom_app_capability`):
`trusted`, `rlsManagedBy`, `routes`, `network.allowPrivateHostsInTest`, PDF templates,
a connection without `allowedDomains`, a capability other than `agent.run`,
`realtime.publish`, `bulk.fetch`, `messages.post`, `sequences.allocate`,
`contacts.addToOrganisation`, a `timeoutMs` above 5 s (tool, search, webhook) or 60 s (job),
a webhook `bodyLimitBytes` above 1 MB, a table `references` to another schema, and triggers.

**`ctx` in handlers:**

- `ctx.store.get/set/update/delete/query/count(collection, ...)`: JSON documents of at most
  256 KiB, keyed by id. `set(c, id, data, { ifVersion: 0 })` creates only;
  `query(c, { where, orderBy: { field, dir }, limit, cursor })` pages with `nextCursor`.
- `ctx.logger.info/warn/error/debug(message, data?)`: kept 7 days, read with `kernel__apps_build_logs`.
- `ctx.fetch(url, { method, headers, body })`: declared and granted hosts only.
- A handler returns plain JSON. To refuse, return `{ error: { code, message } }`.

## 4. A worked example: a visit log (one tool, one page)

This example builds and type-checks as it is: a unit test in the Liaison repo
(`apps/api/src/modules/app-builder/org-app-skill-example.test.ts`) runs these exact
blocks through the app builder's build and type check. Replace `visit-log-o1a2b3c4d`
everywhere with the `appName` your `create` returned.

1. `kernel__apps_build_create({ base_name: "visit-log", title: "Visit log", template: "store-crud" })`
2. `kernel__apps_build_update({ draftId, mode: "full", message: "Visit log: one tool, one page", files: { ... } })`
   with these three files:

```json app.manifest.json
{
  "packageFormat": 1,
  "host": "^1",
  "license": "UNLICENSED",
  "displayName": "Visit log",
  "description": "Log customer visits and see the latest ones.",
  "iconName": "clipboard-list",
  "scopes": ["visit-log-o1a2b3c4d:visits:read", "visit-log-o1a2b3c4d:visits:write"],
  "store": {
    "collections": {
      "visits": { "readScope": "visit-log-o1a2b3c4d:visits:read", "agentReadable": true }
    }
  },
  "tools": {
    "visits_log": {
      "description": "Log a visit when customer is given, then return the latest visits, newest first.",
      "handler": "visits_log",
      "requiredScopes": ["visit-log-o1a2b3c4d:visits:write"],
      "params": {
        "type": "object",
        "properties": {
          "customer": { "type": "string", "minLength": 1, "maxLength": 200 },
          "note": { "type": "string", "maxLength": 2000 }
        },
        "additionalProperties": false
      }
    }
  },
  "views": {
    "activityBar": {
      "icon": "VisitLogIcon",
      "label": "Visit log",
      "order": 90,
      "tabAction": { "type": "home", "entityId": "home", "label": "Visit log" }
    },
    "tabTypes": {
      "home": { "component": "VisitLog", "label": "Visit log", "icon": "VisitLogIcon", "singleton": true }
    }
  }
}
```

```ts handlers.ts
import { type AppContext, defineHandlers } from "@liaison/app-sdk"

interface Visit {
  customer: string
  note: string | null
  at: string
}

/** Logs a visit when `customer` is given, then returns the latest visits. */
export async function visits_log(params: { customer?: string; note?: string }, ctx: AppContext) {
  if (params.customer !== undefined) {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    await ctx.store.set<Visit>(
      "visits",
      id,
      { customer: params.customer, note: params.note ?? null, at: new Date().toISOString() },
      { ifVersion: 0 },
    )
    ctx.logger.info("logged a visit", { id })
  }
  const page = await ctx.store.query<Visit>("visits", {
    orderBy: { field: "updated_at", dir: "desc" },
    limit: 20,
  })
  return { visits: page.items.map((d) => ({ id: d.id, ...d.data })) }
}

export default defineHandlers({ visits_log })
```

```tsx ui.tsx
import { app } from "@liaison/host"
import { createSignal, For, onMount } from "solid-js"

interface Visit {
  id: string
  customer: string
  note: string | null
  at: string
}

export function VisitLog() {
  const [visits, setVisits] = createSignal<Visit[]>([])
  const [customer, setCustomer] = createSignal("")
  const run = async (params: Record<string, unknown>) => {
    const r = await app.invokeTool<{ visits: Visit[] }>("visits_log", params)
    setVisits(r.visits)
  }
  onMount(() => void run({}))
  return (
    <section data-testid="visit-log">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (customer().trim()) void run({ customer: customer().trim() }).then(() => setCustomer(""))
        }}
      >
        <input
          data-testid="visit-log-customer"
          value={customer()}
          onInput={(e) => setCustomer(e.currentTarget.value)}
          placeholder="Customer"
        />
        <button type="submit" data-testid="visit-log-add">Log visit</button>
      </form>
      <ul>
        <For each={visits()}>{(v) => <li>{v.customer} · {new Date(v.at).toLocaleString()}</li>}</For>
      </ul>
    </section>
  )
}
```

3. `kernel__apps_build_check({ draftId })` until `ok: true`.
4. `kernel__apps_build_preview({ draftId, entry: { kind: "tool", name: "visits_log" }, params: { customer: "Acme" } })`,
   then again with `params: {}`: the second run lists the visit the first one stored.
5. `kernel__apps_build_publish({ draftId })`, then tell the person it waits for an admin's approval.

`views.activityBar.icon` and the tab's `icon` are export names that `iconName` stands in for
while the page runs framed, so `ui.tsx` does not need to export `VisitLogIcon`.

## 5. Testing: what you can and cannot try before publishing

A preview runs one tool, job or webhook handler of a draft version as the person, without installing it:

- **Can:** run every tool with real params, see its `result`, its `error` and its log lines;
  use `ctx.store` on a scratch space of the draft. The scratch space is kept for the next
  preview of the same version (write in one preview, read in the next) and emptied by
  `freshStore: true`, by a preview of another version, by a discard, and a day after its last write.
- **Cannot, before the first publish:** `ctx.db` (no tables yet: `preview_no_schema`),
  `ctx.fetch` (no host granted yet), secrets, connections, capabilities, cross-app calls.
  After a publish, previews reach only the hosts and capabilities the **published** version
  was granted, so a new host is tried for real only after the publish that grants it.
- **Always read-only** on the organization's data: a write through the bridge is refused.
- **Scopes:** the run holds only the draft's scopes the person already holds (an admin's
  `*` covers them all). A builder who is not an admin may see store reads refused until a
  publish gives members the app's scopes.
- **Limits:** 30 s per preview, one preview of a draft at a time (`preview_busy`: wait and retry),
  builds one per org at a time and 30 an hour (`build_busy`: wait `retryAfterSeconds`).
- **The page:** you cannot render `ui.tsx` over MCP; `check` builds and type-checks it.
  Ask the person to open **Settings › App store › Apps in the making** and the draft: the page
  shows in a sealed frame, and its tool calls run as previews. After publishing, open it from
  the activity bar.
- **After publishing:** call the app's tools through `liaison_call_tool`, and read
  `kernel__apps_build_logs({ app: "<appName>" })` (needs `kernel:apps:logs`) for what they logged.

## 6. Refusals and what to do

| Code | Meaning | Do |
|---|---|---|
| `invalid_base_name` | `base_name` does not match `^[a-z][a-z0-9-]{1,40}$` | Pick a shorter lowercase name. |
| `base_name_reserved` | The name of a Liaison page or of an app the server provides | Pick another name. |
| `base_name_taken` | Another draft of the org uses it | `kernel__apps_build_list`, continue that draft or pick another name. |
| `invalid_files` / `files_too_large` | A file other than the four, not text, a missing required file, over 512 KiB, or a preview of an entry the manifest does not declare | Fix the files; move data out of the code. |
| `app_name` / `manifest` / `manifest_json` (in `errors[]`) | The manifest does not parse or validate | Fix at the line given. |
| `custom_app_capability` (in `errors[]`) | A declaration an org app may not hold (section 3) | Remove it; there is no override. |
| type check errors (in `typecheck.errors[]`) | Wrong `ctx` call, wrong types, a refused import | Fix at the file and line given. |
| `build_failed` | Publishing a version that does not build | Run `check`, fix, publish again. |
| `build_busy` (429, retryable) | Another build of the org is running, or 30 this hour | Wait `retryAfterSeconds`. |
| `preview_busy` | Another preview of this draft is running | Wait and retry. |
| `draft_discarded` | The draft was discarded | Start a new draft. |
| `published_name_immutable` | Renaming a draft that already published | Keep the name. |
| `app_owned_by_other_draft` / `app_not_built_by_builder` | The app name belongs to another draft, or to an app installed another way | Use that draft, or another base name. |
| `publish_stale` / `pin_mismatch` | The app moved to another version, or the approved bytes changed, after the request | Publish again. |
| `CUSTOM_APP_LIMIT_REACHED` | The org has as many custom apps as its plan allows (first publish only) | An admin removes one, or the org moves to a larger plan. |
| `APP_RUNS_LIMIT_REACHED`, `APP_BRIDGE_CALLS_LIMIT_REACHED`, `APP_CPU_LIMIT_REACHED` | The org's daily app budget is spent | Apps run again after midnight UTC. |
| `custom_apps_off` | The server does not allow organizations' own apps | Only the server's operator can change it. |
| `scope_denied` (logs) | `app` logs need `kernel:apps:logs` | Use `draftId` for preview lines, or ask an admin. |

## 7. Rules

- Never claim an app is installed before its approval was decided; cite the `approvalHandle`.
- Never send a partial file or a diff to `update`; never pass `pin` to `publish`.
- Declare every outside host in `network.allowedDomains`; the approver sees each one.
- Keep each tool small and quick: 5 s per tool call, 60 s per job run. Long work is a job.
- What the agent read while writing the draft is shown on the approval card as data the app
  may carry: do not paste customer data into the code or the README.
