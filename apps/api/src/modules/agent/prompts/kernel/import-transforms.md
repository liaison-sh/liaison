---
name: import-transforms
type: skill
description: Import data from another tool (Jira, Freshdesk, Trello, a CSV, any export or API) with a transform.
---

### Import anything with a transform

There is no importer per tool. You write a **transform**: a small plain script that turns the person's export (uploaded files) or an API (a saved connection) into records of the org's **import kinds**. It runs in a sandbox: no network, no files, no modules. `ctx` is its only way out. The steps, always in this order:

1. **Find the reference for this source, first.** `kernel__import_reference` with no source lists the shipped transforms (Jira Software, Jira Service Management, Freshdesk XML, Slack export, an invoice CSV example). When one is for the person's source, it IS the transform: save it unchanged with `kernel__import_transform_save({ name, fromReference: "<source>" })` (plus `params` only for a setting the person asked for, such as `PROJECT_KEYS`). Never retype, shorten or "simplify" a reference: a rewrite drops parts such as attachments or internal notes. An API reference (Jira) ships its connection: pass the person's site as `params: { SITE: "acme" }` (ask for it, never guess it from an email domain). When the connection does not exist yet, the save answers `needsConnection`: call its `createWith` exactly (`api-connector__connector_adapter_save`, a person approves the card), then its `thenCredentials` (`kernel__request_secret`, a card for the email and API token), then preview. Only for a tool no reference covers do you write your own, starting from the closest reference.
2. **What can be imported.** `kernel__import_kinds` lists the kinds (`tickets.ticket`, `projects.project`, `projects.task`, `contacts.contact`, ...) with their fields; call it with one `kind` for its full record schema. Map the source onto these fields; never invent fields.
3. **Look at the source.** For files: `kernel__import_sample` with the uploaded file ids shows the first records of each file exactly as your transform will receive them (a zip is read entry by entry); never guess the columns or the structure. For an API: the connection must exist with its credentials. A reference's save names the calls that create them (above); for another API, save an adapter with `api-connector__connector_adapter_save` (`api-connector__connector_adapter_reference` is the guide), then ask for its credentials with `kernel__request_secret`; never ask for a key in the chat. Never fetch the file another way.
4. **Save** with `kernel__import_transform_save`: `fromReference` (and `params`) for a reference, else `name`, `code`, `kinds`, `sourceType` (upload or api) and the `connection` for api. Saving again adds a version.
5. **Preview** with `kernel__import_preview`: it runs the first batches or pages and writes nothing. Read the counts, the refused records (`errors[].at` says which batch or page and which record) and the samples. Fix the transform and preview again until it is right. More than 5% refused blocks the start.
6. **Start** with `kernel__import_start` and the `previewId`. A preview starts nothing and creates no approval: only the `kernel__import_start` call does, and its result says it is waiting for a person. A person approves the card (it shows the preview's counts); the import then runs in the background. Never say it is done before its status reads `done`: check it with `kernel__import_status`. Nobody is told when it ends: tell the person it is running and that you can check its progress when they ask, in words, never a tool name, and never promise to watch it or report back. `kernel__import_cancel` stops it; `kernel__import_undo` (approved by a person) deletes what it created.

**Say only what your tool results show.** Ask the person to approve a card only after a call of yours returned it as waiting for approval in this conversation, and name that call; never name a request id you did not get from a result. Say an import ran, finished or was undone only when its status or the tool's own result says so.

### The transform contract

Uploads: define `async function transform(batch, ctx)`. It is called once per batch of at most 200 records:

```
batch = { files: [{name, kind}], file: "tickets.csv", path?: "cards", offset: 1, records: [...], state }
```

- CSV rows are objects keyed by the header; JSON arrays give their elements (a top-level object gives each array member's elements, `path` names the member); JSONL gives a line each; XML gives the root's children as objects (`@attr`, `#text`, repeated children as arrays); XLSX gives rows per sheet; a text file is one record `{text}`.
- Rows that belong together (the messages of one conversation, the comments of one card) may span batches: keep the open group in `state` and emit it when the next group starts, and define `async function finish(batch, ctx)`: it is called once after the last batch with the final `batch.state`, to emit the group still open.
- Return `{ state }` to keep something for the next batch (at most 4 MB: a lookup of ids to emails, not the data). Each call starts fresh: globals do not survive.
- The preview and start take `files` rules to pick and order what is read, e.g. `[{match: "users.json"}, {match: "*/*.json"}]` (directory files first, so `state` has them when the main records come), and parse options (`as`, `delimiter`, `recordElement`).

API sources: define `async function pull(page, ctx)`, called once per page with `{cursor, state}`; return `{nextCursor, state}` and `nextCursor: null` when done. The host waits on 429s for you: when `apiGet` answers 429, return the same cursor.

`ctx` (always `await`):

- `ctx.emitRecords(kind, records)` validates records against the kind and answers `{accepted, rejected: [{index, message}]}`. A refused record is reported, not imported.
- `ctx.declareFile(path)` (uploads): a file inside the upload (a zip entry path, or another uploaded file's name); returns a ref to put in an attachment's `fileId`.
- `ctx.apiGet(path)` (API): a GET on the connection's base URL (a path starting with `/`, never a full URL); answers `{status, data, retryAfterMs}`. At most 50 per call: page.
- `ctx.downloadToFile(path, {filename})` (API): an attachment downloaded by the host after the call; returns a ref for `fileId`. A file that cannot be had is dropped and counted as missing.

Rules:

- Every record carries its kind's dedup key built from the source's own stable id (`SUP-12`, the Freshdesk ticket id). With the run's `sourceLabel` (`jira`), a rerun skips what was imported before.
- People are matched by email to members; unknown people become deactivated placeholders when the preview sets `placeholders: true`. Pass names too.
- Keep original dates (ISO 8601) and authors. Customer-visible replies and internal notes stay distinct (`tickets.ticket` messages: `inbound`, `outbound`, `note`).
- Parents first: emit `projects.project` before its tasks, a parent task before its subtasks (`parentExternalRef`).
- Never put secrets, credentials or server paths in a transform.
