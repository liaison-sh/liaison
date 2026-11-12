---
title: Keep data in tables
description: "Tables hold rows that people and agents write, such as incoming batches or repairs: typed columns, their own sharing, a history with undo, routines that react to a change, and blocks that chart them."
---

A table is the organisation's own data, kept in Liaison: a name, typed columns and rows. People edit its rows on a dashboard or on the table's page ([See your dashboards](dashboards.md)), agents write them with their tools, and any dashboard block can show or chart them. Every change is recorded with who made it, and can be undone.

## Columns

A table has at most 40 columns. Each has a key, a label and a type:

| Type | A cell holds |
| --- | --- |
| `text` | Text, up to 5,000 characters. |
| `number` | A number. |
| `amount` | A number in the column's currency (an ISO code such as `EUR`). |
| `date` | A day, `YYYY-MM-DD`. |
| `choice` | One of the column's choices. |
| `choices` | Several of the column's choices. |
| `checkbox` | `true` or `false`. |
| `person` | A member of the organisation (their user id). |
| `link` | A record of an app: `{ app, entityType, id, label }`. A column may accept only one app or one kind of record. |

A key is a lowercase letter followed by up to 39 lowercase letters, digits or `_`. It never changes; the label does. `id`, `updated_at`, `updated_by` and `created_at` are reserved. A column can be required: a new row must fill it, and a change cannot empty it.

Every write, by a person or an agent, is checked against the columns. A refused write names the column and the reason, and nothing of it is saved.

Removing a column hides its values but keeps them in the history, and its key cannot be used again.

## Who sees a table

A table is shared like a dashboard: its owner, what everyone in the organisation gets (nothing, view or edit), and the people and roles it is shared with, each as viewer or editor. A table made from a dashboard is shared like that dashboard. Someone it is not shared with sees no table and no row, by any path, administrators included. A dashboards administrator acts on a table the whole organisation sees, never on a restricted one.

- Read rows: `kernel:dashboards:read` and view access.
- Add, change or delete rows, or change the columns: `kernel:dashboards:write` and edit access (its owner, everyone when the organisation gets edit, or an editor).
- Create a table: `kernel:dashboards:write`; shared with others, `kernel:dashboards:share` too.
- Change who sees it: edit access and `kernel:dashboards:share`.
- Delete it: its owner, or a dashboards administrator when the whole organisation sees it. Its rows go with it; its history is kept for retention only.

## History and undo

Each row change is kept with who made it: a person, an agent (`@support`) or a routine (`Routine Inbound follow-up`). A row keeps its last 200 changes, for 400 days.

**Undo** writes a change's previous values back as a new change. It works only while that change is still the row's latest: once someone changed the row again, undo is refused and says who changed it since. Undoing a deletion brings the row back.

Two people changing the same row: the second change is refused with the row as it is now, and nothing is overwritten.

## Ask your agent

Your agent uses these tools, with your access:

| Tool | What it does |
| --- | --- |
| `tables_list` | The tables you can see, with their columns and row counts. |
| `tables_get` | One table: its columns, version and who it is shared with. |
| `tables_query` | Rows, each with its id and version: filter on columns, sort, page. |
| `tables_rows_write` | Up to 50 row changes at once (add, update, delete), all or none. |
| `tables_edit` | Create a table, change its columns or settings, or delete it. |

A row change by an agent applies at once and is recorded, unless the table's **Agent row writes need approval** is on: then all its changes wait on one approval card. Creating a table, changing its columns or deleting it always waits for an approval. A restricted table's card goes to its owner; a table the whole organisation sees is decided by a dashboards administrator. If a row changed between the request and its approval, the whole change is refused and names the row.

Your own changes in the app never wait for an approval.

## Show a table on a dashboard

A block reads a table with the source `{ kind: "table", table: "<table id>", where? }`. Its fields are the column keys, plus `id`, `updated_at` and `updated_by`. Every block type works on it. A link reads as its label, a person as their name, several choices as one line. A block reads at most 2,000 rows and says when there were more.

A table block with `map.editable: true` lets people edit the rows in place. `map.staleAfterDays` marks rows not changed for that many days. A block never shows rows older than the last change: its kept figures are read again after any row, column or sharing change.

## React to a change

A [routine](routines.md) triggered by `kernel:dashboard_table_row:created`, `:updated` or `:deleted` can filter on one table, a column, and the value it changes to: `{ tableId, column: "status", to: "arrived" }` fires once when a row's status becomes "arrived", not on its other edits. Its owner must be able to read the table. A routine never wakes on its own change. The event itself carries ids and the changed column keys only; the routine reads the values with its owner's access.

## Link a record

A link cell picks a record of a connected app. Records the search index holds are searched there; an app can let people pick other records through one of its own read tools, declared on the entity in its manifest: `pick: { tool, queryParam, idField, labelField, itemsPath? }`. Shopify declares it for orders, customers, products and returns, Boxtal for shipments. A reader who cannot open a linked record sees **Linked record** instead of its label.

## The tables API

Signed-in requests, with your own access, under `/api/dashboards/tables`:

| Request | What it does |
| --- | --- |
| `GET /` | The tables you can see: `{ tables }`. |
| `POST /` | Create one: `{ name, description?, columns, fromDashboardId? }`. |
| `GET /:id` | One table: `columns`, `droppedKeys`, `agentWritesNeedApproval`, `orgAccess`, `myRole` (`viewer`, `editor`, `owner`), `rowCount`, `version`. |
| `PATCH /:id` | Change it: `{ ifVersion, name?, description?, agentWritesNeedApproval?, columns?: { add?, rename?, setChoices?, drop? } }`. |
| `DELETE /:id` | Delete it and its rows. |
| `GET /:id/rows` | A page of rows: `?limit=` (50), `?cursor=`, `?sort=<column key or updated_at>`, `?dir=asc\|desc`, `?q=` (text in a cell). |
| `POST /:id/rows` | `{ ops: [{ op: "add", cells } \| { op: "update", id, ifVersion, cells } \| { op: "delete", id, ifVersion }] }`, up to 50, all or none. |
| `GET /:id/changes` | The history, newest first: `?rowId=`, `?limit=`, `?cursor=`. Each change says whether it can be undone. |
| `POST /:id/changes/:changeId/undo` | Undo one change. |
| `GET /:id/sharing`, `PUT /:id/sharing` | Who sees it, as for a dashboard. |
| `GET /link-search` | Records to link: `?app=&entityType=&q=`, answers `{ items: [{ id, label, app, entityType }] }`. |

A refusal answers `{ error: { code, message, details? } }` with `code` one of `invalid_cell` (422, `details.column`), `version_conflict` (409, `details.current` is the row now), `not_found` (404), `forbidden` (403), `limit` (422), `invalid_request` (400) or `conflict` (409, a table of that name exists). A table holds at most 100,000 rows of at most 256 KB each.
