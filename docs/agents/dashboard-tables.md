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
| `months` | One number per month, typed by people: `{ "YYYY-MM": number }`. See [Plan by month](#plan-by-month). |
| `lookup` | A number or a text read live from an app, never typed (see [Read values live from an app](#read-values-live-from-an-app)). |
| `rollup` | A sum or a count of the rows of another table that link to the row, never typed (see [Add up the rows of another table](#add-up-the-rows-of-another-table)). |
| `formula` | A number, or one number per month, computed from the row's other columns, never typed (see [Compute a column with a formula](#compute-a-column-with-a-formula)). |

A key is a lowercase letter followed by up to 39 lowercase letters, digits or `_`. It never changes; the label does. `id`, `updated_at`, `updated_by` and `created_at` are reserved. A column can be required: a new row must fill it, and a change cannot empty it.

Every write, by a person or an agent, is checked against the columns. A refused write names the column and the reason, and nothing of it is saved.

A number, amount, months or formula column can make some values stand out: its **Highlight** option draws **Values other than 0** or **Values below 0** in bold, in the accent colour. Change it from the column's **Options** in **Settings**, or with `setOptions` (below).

Removing a column hides its values everywhere (rows, history, search, filters) but keeps them stored for retention, and its key cannot be used again.

## Plan by month

A `months` column holds one number per month, such as deliveries expected or a monthly budget. People type each month by hand. Its options:

- `horizon`: how many months it shows, 1 to 12 (default 3).
- `fromOffset`: `0` starts at the current month (the default), `1` at the next one. Months follow the organisation's timezone.

The grid shows the column as one sub-column per month, labelled by the month's name, each edited on its own. A month with no value shows a quiet **to fill**; `0` is a value. Older months stay in the cell, so the history and undo keep them.

A write names only the months it changes: `{ "expected": { "2026-11": 40, "2026-12": null } }` sets November and clears December, and leaves every other month as it was. `null` for the whole cell empties it. A cell keeps at most 120 months. A months column is never required, and cannot sort or filter rows.

A read gives the cell as `{ "2026-11": 40, "2027-01": 25 }`. `tables_get` gives each months column its `months`, the months it shows now (`["2026-11", "2026-12", "2027-01"]`). Change a column's options with `columns: { setOptions: [{ key, horizon?, fromOffset?, emphasis? }] }` (`emphasis: null` removes it).

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

A row change by an agent applies at once and is recorded, unless the table's **Agent row writes need approval** is on: then all its changes wait on one approval card. Creating a table, changing its columns or deleting it always waits for an approval; a request that would fail when approved (an own column that repeats a value the table reads from its project, a name already taken) is refused before any card is made, with its reason, so the agent corrects it. A restricted table's card goes to its owner; a table the whole organisation sees is decided by a dashboards administrator. A restricted table whose owner's account was erased has no one to decide: such a change is refused until the table has an owner, and a change already waiting for that owner is cancelled when the account is erased. If a row changed between the request and its approval, the whole change is refused and names the row.

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
- The status shows as a pill in the status's colour from the project's board, the assignee with their avatar, and a due date that has passed reads red with a full thin track under it (one due in the next three days has an amber track, filling as it nears). A task in a done or cancelled status has no deadline left: its due date reads plain. On **Settings**, read-through columns say **From the project** and cannot be renamed or dropped there.
- A row's **Last change** names who last changed its task in Projects: the person, "<Name>'s agent" or "Routine <title>". A change the task does not attribute (an edit of another field outside the table) reads "Task changed" with its time.
- A change you may not make to a task says so under its row: "You can't change the tasks of <project>. Ask an admin for permission to edit tasks."
- **Add a task** asks for the task's title and the table's own columns. The delete mark of a row is greyed out; hover it for why.
- An app declares which of its records can back a table, on the entity in its manifest: `tableBacking: { parent, provider }`, a provider in its server code.

## Read values live from an app

A lookup column shows a value an app knows, read when the table is read: a product's stock from a shop's product search, joined on the table's product link, or the units waiting in a shipping queue, joined on a code column. Your agent defines it:

```json
{
  "key": "stock",
  "label": "Stock",
  "type": "lookup",
  "lookup": {
    "source": { "tool": "<app>:<tool>", "params": {}, "rowsPath": "products" },
    "match": { "field": "id", "on": "product" },
    "value": "inventory.on_hand",
    "valueType": "number"
  }
}
```

- `source` is a read tool that can feed a dashboard, with its settings and where its rows are, exactly as a dashboard block's tool source. Saving the column checks that the tool is one and that you may run it.
- `match.field` is the path of the key in the tool's rows; `match.on` is the table's column it matches. A link cell matches by its record's id, any other cell by its text, without regard to case or spaces around it.
- `value` is the path of the value in the matched row, `valueType` `number` or `text`. Several matching rows add up (a number) or are listed once each (a text).
- A table has at most 5 lookup columns. A lookup cannot be required, written, filtered or sorted on. To change one, remove it and add another key. The column it matches on cannot be removed while the lookup uses it.

The tool runs once per table read and column, as the person reading, with their access: someone who may not run it sees every row, the column empty and **Not available** in its header (hover it for why). The same holds when the read fails or the dashboard read budget is spent. Each person's read is kept for a minute, a failed one for 30 seconds. An agent reading the table through `tables_query` gets the reasons in `columnNotes`, and its turn counts as having called the tool. The grid, `tables_query` and a table block source all read it.

## Add up the rows of another table

A link column can point at the rows of another dashboard table: `linkTo: { app: "kernel", entityType: "table_row", table: "<table id>" }`. A "Supplier lots" table links each lot to its part in a "Parts" table, for example. Saving such a column needs that table readable by you. Its picker searches that table's rows as you see them, each labelled by the table's first text column. A link cell reads with the row's label as it is now; a link to a row deleted since reads struck through (hover it: **This row was deleted**), and `missing: true` for an agent. A reader who cannot read the linked table sees **Linked record**.

A rollup column then adds up, on the linked table, the rows of the other table that link to each row. Your agent defines it, once the other table has its link column:

```json
{
  "key": "ordered",
  "label": "Ordered",
  "type": "rollup",
  "rollup": {
    "table": "<Supplier lots table id>",
    "link": "part",
    "value": "qty",
    "agg": "sum",
    "where": { "status": { "in": ["ordered", "in_transit"] } },
    "byMonth": "eta"
  },
  "horizon": 4
}
```

- `link` is the other table's link column that points at this table's rows; `value` is its number or amount column to add up (`agg: "sum"`), or `null` to count the rows (`agg: "count"`). `where` keeps only the rows that match, in the same form as a `tables_query` filter.
- Without `byMonth`, a cell is a number: 0 when no row links to it. With `byMonth`, a date column of the other table, a cell is `{ "YYYY-MM": number }`, one number for each month that has rows, and the grid shows it as a months column does, with `horizon` and `fromOffset`. A month without rows reads empty.
- Saving checks that you can read the other table, that its link column points here, that the value is a number or amount column, the date a date column and the filter valid. A table has at most 5 rollup columns. A rollup cannot be required, written, filtered or sorted on. `emphasis` applies to it.
- It is computed every time the table is read, as the person reading: someone who cannot read the other table sees the column empty and **Not available** in its header, and an agent gets the reason in `columnNotes`. It counts at most 10,000 rows of the other table and says so past that. The grid, `tables_query` and a table block source all read it.

## Compute a column with a formula

A formula column computes its value from the other columns of its row on every read, for example what is free to sell (`stock - sold`) or the projected stock month by month (`stock - sold + cumsum(expected)`). Add it in **Settings** (type **Formula**, then the formula with the column keys), or have your agent add it:

```json
{
  "key": "projected",
  "label": "Projected",
  "type": "formula",
  "formula": { "expr": "stock - sold + cumsum(expected)" },
  "horizon": 6,
  "emphasis": "negative"
}
```

- A formula reads the keys of the table's own number, amount, number lookup, rollup, months and formula columns, numbers, `+ - * /` (`×`, `÷` and `−` work too) and parentheses, and the functions `min`, `max`, `abs`, `round(x, decimals)`, `cumsum(x)`, the running total across the months shown, and `ifempty(x, fallback)`, which reads the fallback where `x` is empty (`ifempty(shop_stock, stock)`: the shop's stock, or the one typed for an item the shop does not sell).
- A formula that reads a months column or a rollup by month, or calls `cumsum`, gives one number per month, over its own months (`horizon` 1-12, default 3, and `fromOffset`, as a months column). It is computed month by month; a single number counts the same in every month. The grid shows it as one column per month. Any other formula gives one number.
- An empty number it reads (a stock nobody typed, a lookup with no match) leaves the result empty, unless it is inside `ifempty`, so a missing figure never reads as a wrong one. A month without a value in a months column counts as 0. A division by zero leaves that value empty, and `cumsum` leaves every later month empty after one.
- Saving refuses a formula that does not parse, names a key that is not a column of the table, reads a text, date, choice or link column, or that formulas read each other in a circle. A column a formula reads cannot be removed while it does.
- A formula cannot be required, written, filtered or sorted on. It is computed after the lookup and rollup columns, in the grid, in `tables_query` and in a table block source. To change one, remove it and add another key.

## Show a table on a dashboard

A block reads a table with the source `{ kind: "table", table: "<table id>", where? }`. Its fields are the column keys, plus `id`, `updated_at` and `updated_by`. Every block type works on it. A link reads as its label, a person as their name, several choices as one line. A months cell reads as its map: a block maps one month as `<key>.<YYYY-MM>`, such as `expected.2026-12`. A rollup reads as its number, or by month as that map. A block reads at most 2,000 rows and says when there were more.

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
| `GET /:id/rows` | A page of rows: `?limit=` (50), `?cursor=`, `?sort=<column key or updated_at>`, `?dir=asc\|desc`, `?q=` (text in a cell). `columnNotes` says why a lookup or rollup column is empty. |
| `POST /:id/rows` | `{ ops: [{ op: "add", cells } \| { op: "update", id, ifVersion, cells } \| { op: "delete", id, ifVersion }] }`, up to 50, all or none. |
| `GET /:id/changes` | The history, newest first: `?rowId=`, `?limit=`, `?cursor=`. Each change says whether it can be undone. |
| `POST /:id/changes/:changeId/undo` | Undo one change. |
| `GET /:id/sharing`, `PUT /:id/sharing` | Who sees it, as for a dashboard. |
| `GET /link-search` | Records to link: `?app=&entityType=&q=`, or the rows of a table with `?table=<id>`, answers `{ items: [{ id, label, app, entityType }] }`. |

A refusal answers `{ error: { code, message, details? } }` with `code` one of `invalid_cell` (422, `details.column`), `version_conflict` (409, `details.current` is the row now), `not_found` (404), `forbidden` (403), `limit` (422), `invalid_request` (400) or `conflict` (409, a table of that name exists). A table holds at most 100,000 rows of at most 256 KB each.
