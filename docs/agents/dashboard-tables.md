---
title: Keep data in tables
description: "Tables hold rows that people and agents write, such as incoming batches or repairs: typed columns, their own sharing, a history with undo, routines that react to a change, and blocks that chart them."
---

A table is the organisation's own data, kept in Liaison: a name, typed columns and rows. People edit its rows on a dashboard or on the table's page ([See your dashboards](dashboards.md)), agents write them with their tools, and any dashboard block can show or chart them. Every change is recorded with who made it, and can be undone.

## Create a table

In **Dashboards**, the **Tables** section of the sidebar lists the tables you can see. Select **+** (**New table**), type its **Table name** and press Enter: the table opens on its **Settings**, where you add its columns. Two tables cannot share a name. Your agent can create one too, with your approval.

To make a table of a project's tasks, tick **From a project** under the name, pick the **Project**, then tick the **Task values to show** (Title, Status, Assignee and Due are ticked at first; Priority and the project's own task fields are offered too) and select **Create**. The table opens on its grid, with the project's name under its title. See [Back a table by a project](#back-a-table-by-a-project).

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

Removing a column hides its values everywhere (rows, history, search, filters) but keeps them stored for retention, and its key cannot be used again.

## Who sees a table

A table is shared like a dashboard: its owner, what everyone in the organisation gets (nothing, view or edit), and the people and roles it is shared with, each as viewer or editor. A table made from a dashboard is shared like that dashboard. Someone it is not shared with sees no table and no row, by any path, administrators included. A dashboards administrator acts on a table the whole organisation sees, never on a restricted one.

- Read rows: `kernel:dashboards:read` and view access.
- Add, change or delete rows, or change the columns: `kernel:dashboards:write` and edit access (its owner, everyone when the organisation gets edit, or an editor).
- Create a table: `kernel:dashboards:write`; shared with others, `kernel:dashboards:share` too.
- Change who sees it: edit access and `kernel:dashboards:share`.
- Delete it: its owner, or a dashboards administrator when the whole organisation sees it. Its rows go with it; its history is kept for retention only.

## History and undo

Each row change is kept with who made it: a person, an agent (`@support`) or a routine (`Routine Inbound follow-up`). A row keeps its last 200 changes, for 400 days.

**Undo** writes a change's previous values back as a new change. It works only while that change is still the row's latest: once someone changed the row again, undo is refused and says who changed it since. Undoing a deletion brings the row back. An undo whose old values no longer fit the columns (a removed column, a removed choice, someone no longer a member, a required column left empty) is refused and names the column.

The history, like the grid, shows only the columns that exist now, and **Linked record** for a link you cannot open. Searching the grid matches only what you can see.

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

A row change by an agent applies at once and is recorded, unless the table's **Agent row writes need approval** is on: then all its changes wait on one approval card. Creating a table, changing its columns or deleting it always waits for an approval. A restricted table's card goes to its owner; a table the whole organisation sees is decided by a dashboards administrator. A restricted table whose owner's account was erased has no one to decide: such a change is refused until the table has an owner, and a change already waiting for that owner is cancelled when the account is erased. If a row changed between the request and its approval, the whole change is refused and names the row.

An agent's conversation that read data some of the table's readers cannot see (orders, say, read earlier in the same conversation) cannot write it to the table at once, even with the switch off: the change waits on a card that names the table, says which apps' data some of its readers lack, and is decided by the same people as above. Approving it shares that data with the table's readers. A change applied after an approval keeps that approval in its history.

After your agent reads a table shared with some people only, anything it writes in the same turn runs at once only when everyone who will read it can read that table too. Otherwise it waits for your own approval (no one else sees the card): copying a restricted table's rows into a table the whole organisation sees, or posting them in a conversation with someone the table is not shared with, is a choice you make.

In a conversation, your agent reads a table shared with some people only when everyone in the conversation can read it. Otherwise it answers that it cannot show it there, and the card under its answer offers to continue in a direct message or to share the answer with the conversation anyway, as for anything else not everyone in the room may see. A later answer in that conversation leaves out an earlier read of the table once someone who cannot read it has joined.

Your own changes in the app never wait for an approval.

## Back a table by a project

A table can show the tasks of one project as its rows, live: `backing: { app: "projects", entity: "task", parentId: "<project id>", fields: ["title", "status", "assignee", "problem"] }` when you create it (or change it). `fields` names the task values the table reads through, as columns typed from the project: title, status (a choice of the project's statuses), assignee, due, priority, and the project's task fields by key. The table's own columns are an overlay kept per task, with the same history and undo as any row.

- Each reader sees the tasks they can read: someone who may not read the project's tasks in Projects sees no rows, and the table says why. A table lists at most 2,000 tasks and says when there were more.
- Each row carries the task's `recordVersion`: an edit of a task value passes it as `ifRecordVersion`, and is refused when someone changed the task since. Undoing a row's first own-column change empties its own cells; the task stays.
- For an agent, reading the table counts as reading the tasks in Projects, and editing a task value counts as editing the task there: the same approvals apply as when it calls Projects itself.
- Editing a read-through cell changes the task through Projects, as the writer, and needs the right to edit tasks; the task's own history records it, not the table's.
- Adding a row creates a task (a title is required). A row cannot be deleted: delete or archive the task in Projects.
- An own column cannot use the key of a read-through one.
- On the grid, the header groups the columns under **From <project>** and **This table only**. A column read from the project has a small link mark; hover its header for "From <project>: changing it changes the task." The table's own columns say "Kept in this table only."
- The status shows as a pill in the status's colour from the project's board, the assignee with their avatar, and a due date that has passed reads red with a full thin track under it (one due in the next three days reads amber, the track filling as it nears). On **Settings**, read-through columns say **From the project** and cannot be renamed or dropped there.
- A change you may not make to a task says so under its row: "You can't change the tasks of <project>. Ask an admin for permission to edit tasks."
- **Add a task** asks for the task's title and the table's own columns. The delete mark of a row is greyed out; hover it for why.
- An app declares which of its records can back a table, on the entity in its manifest: `tableBacking: { parent, provider }`, a provider in its server code.

## Show a table on a dashboard

A block reads a table with the source `{ kind: "table", table: "<table id>", where? }`. Its fields are the column keys, plus `id`, `updated_at` and `updated_by`. Every block type works on it. A link reads as its label, a person as their name, several choices as one line. A block reads at most 2,000 rows and says when there were more.

A table block with `map.editable: true` lets people edit the rows in place. `map.staleAfterDays` marks rows not changed for that many days. A block never shows rows older than the last change: its kept figures are read again after any row, column or sharing change.

## React to a change

A [routine](routines.md) triggered by `kernel:dashboard_table_row:created`, `:updated` or `:deleted` can filter on one table, a column, and the value it changes to: `{ tableId, column: "status", to: "arrived" }` fires once when a row's status becomes "arrived", not on its other edits. Its owner must be able to read the table. A routine never wakes on its own change. The event itself carries ids and the changed column keys only; the routine reads the values with its owner's access.

## Link a record

A link cell picks a record of a connected app (any app when the column names none). Records the search index holds are searched there; an app can let people pick other records through one of its own read tools, declared on the entity in its manifest: `pick: { tool, queryParam, idField, labelField, itemsPath? }`. Shopify declares it for orders, customers, products and returns, Boxtal for shipments, Projects for projects and tasks. `params` adds fixed parameters beside the query, such as Projects' `{ kind: "task" }`. A reader who cannot open a linked record sees **Linked record** instead of its label.

On a table's grid, a link cell is a link: click it (or focus it and press Enter) to open the record in its app, a task in Projects for example. People who may edit the table change the link with the pencil beside it.

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
