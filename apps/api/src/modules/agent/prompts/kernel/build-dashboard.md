---
name: build-dashboard
type: skill
description: Show, open or build a dashboard, chart or KPI (sales, orders). Built in, never say none exists.
---

### When someone asks to see a dashboard

Dashboards are built into Liaison (Home, **Dashboards** in the sidebar), not an app: never answer that there is no dashboard app or feature, and never send a text report instead without saying so.

- `kernel__dashboards_list` lists theirs and the org's. Open the one they mean with `kernel__open_app` (below).
- None yet: say so, and offer to build one now from what they want to follow.
- No dashboard tool in your catalog (`kernel__tool_search` "dashboard" finds none, or reports them locked): say dashboards exist and that the access `kernel:dashboards:write` is missing. If the person lacks it, offer `kernel__request_scope` for it. If they hold it and you do not, it is missing from your own scopes as an agent: an administrator adds it to your scopes, or their personal agent can build the dashboard.

### Building a dashboard

A dashboard is a grid of up to 24 blocks. Each block is one chart (`metric`, `table`, `bar`, `line`, `area`, `pie`, `combo`, `funnel`) over one **source** (its own, or a shared **dataset**), and a **map** that the server applies to the source's rows; or a `text` note. Every block runs as the person viewing it: someone who may not call a block's tool sees "no access" for that block only.

Always in this order:

1. **Find the sources.** `kernel__dashboards_sources` with words of what to show (`orders`, `tickets`, `revenue`) lists the reads you may chart, with their params and result fields. Only read tools qualify: never a tool that writes, sends or needs an approval. A collection of the data store is a source too (`kernel__data_collections_list`). Data from another system (a shop, a CRM) comes through its connector's read tool; if no connection exists, set it up first.
2. **Preview every block** with `kernel__dashboards_preview_block({ block })`. It runs the source as you and returns exactly what the chart will draw, and saves nothing. Read the result: the labels, the values, `meta.skippedRows` (rows whose date or number was unusable) and `meta.truncated`. Fix the map and preview again until the numbers are right. A refusal says why and lists `alternatives`: use one of them, never a tool it did not list.
3. **Save** with `kernel__dashboards_create({ title, visibility, spec })`. `personal` (only the person) saves at once. `org` (everyone) waits for a person's approval: say it is waiting, never that it exists. Editing or deleting an org dashboard waits for an approval too.
4. **Open it** for the person: `kernel__open_app({ app: "kernel", view: "dashboard", id })`.

### Changing a dashboard

`kernel__dashboards_get` (note its `version`), then ONE `kernel__dashboards_edit({ dashboardId, ifVersion, operations })` with every change the person asked for, in order (at most 50):

- `{ "op": "addBlock", "block": {...}, "position": 2 }` (`position`: an index, 0 = first, or `{ "before": "<blockId>" }` / `{ "after": "<blockId>" }`; default the end)
- `{ "op": "updateBlock", "blockId": "orders", "changes": { "title": "...", "source": { "params": { "since": "{{range.from}}" } } } }`: `map` and `source.params` merge key by key (`null` removes a key), other fields are replaced
- `{ "op": "removeBlock", "blockId": "..." }`, `{ "op": "moveBlock", "blockId": "...", "position": { "after": "..." } }`
- `{ "op": "setTitle", "title": "..." }`, `{ "op": "setTimeRange", "timeRange": { "preset": "lastMonth" }, "compare": "previousPeriod" }`, `{ "op": "setVisibility", "visibility": "org" }`
- `{ "op": "setDataset", "id": "orders", "source": {...} }` (adds or replaces a shared source), `{ "op": "removeDataset", "id": "orders" }` (after the blocks that read it changed)
- `{ "op": "setFilter", "filter": { "id": "market", "label": "Market", "type": "select", "options": [...] }, "position": 0 }`, `{ "op": "removeFilter", "id": "market" }`
- `{ "op": "resizeBlock", "blockId": "...", "width": 2, "height": 2 }` (width 1-3 columns, height 1-2 rows), `{ "op": "duplicateBlock", "blockId": "...", "title": "...", "newId": "..." }` (default: right after it, id `<id>-copy`, title "<title> (copy)"); a rename is `updateBlock` with `changes: { "title": "..." }`
- `{ "op": "setDescription", "description": "What this dashboard is for" }` (null removes it)
- `{ "op": "revert", "toVersion": 7 }`: back to a saved version (title and spec), as a new version. `kernel__dashboards_history({ id })` lists the last 20 with who saved each and when; pick the one the person means, and say what the revert undoes.

The operations apply together or not at all, and are checked before anything waits for a person: an unknown block, a duplicate id, a map that does not fit or a source the person cannot read is refused at once, naming it. Fix the call and send it again. On an org dashboard the whole call waits for ONE approval, whose card lists each change: never split one request into several calls (each would be its own approval), never send changes the person did not ask for. Preview a new or changed block first. `too_many_changes` (over 50): send the first part, and the rest only once that approval is decided and applied, after reading the dashboard again for its new version.

**Several changes in a row.** A saved edit returns the new `version`: pass it as `ifVersion` to the next edit, with no read in between. An edit waiting for an approval applies when a person approves it, and its result then carries the new version (over MCP, follow it with `liaison_approval_status`). You may file another edit while one waits: if the dashboard moved on by the time it runs, an edit still applies on top of the newer version as long as no version saved since changed the same blocks, datasets, filters, title, range or visibility. Otherwise it is refused with `version_conflict`, naming the operation and the version that changed it, and its `body.currentVersion`: read the dashboard again and send the change against that version. A `revert` and `kernel__dashboards_update` never apply on top of a newer version. When the result lists other pending requests for the dashboard, do not file the same change again; to change what a pending one does, withdraw it (`kernel__approval_withdraw`) and file the corrected change as one new request.

Changes always go through `kernel__dashboards_edit`. `kernel__dashboards_update({ id, spec, ifVersion })` replaces the whole spec: keep it for a wholesale rebuild the person asked for (its card lists every difference from the saved dashboard, the same way).

### The map

- `groupBy: { field, bucket? }`: the category. `bucket` `day`, `week`, `month`, `quarter` or `year` turns a date field into a date bucket, in the organization's time zone (labels `2026-11-07`, the week's Monday, `2026-11`, `2026-Q4`, `2026`).
- `agg`: `sum` (default), `count`, `avg`, `min`, `max`. `count` needs no field.
- `metric`: `value` is the field aggregated over every row. When the source answers one object instead of rows, `value` is the path to its number (`totals.sales`).
- `table`: `columns: [{ field, label, format? }]`, plus `sort` and `limit`. A table shows rows: no `groupBy` or `agg`.
- `bar` and `line`: the category is `groupBy` (or `x`); `y` is aggregated per category; `series` splits it into one line or bar per value of that field.
- `pie`: the slice is `groupBy` (or `label`); `value` is aggregated per slice.
- `area`: a `line` filled. `stacked: true` stacks the series of a `bar`, `area` or `combo`; `horizontal: true` lays a `bar` on its side (long category names, rankings).
- `measures: [{ label, field?, agg? }]` gives a `bar`, `line`, `area` or `combo` several values per category, one series each (revenue and order count by month), instead of `y` + `series`.
- `combo`: bars and lines over the same categories: `measures` (two or more) or `series`; `lineSeries: ["Orders"]` names the series drawn as lines (default the last), `secondaryAxis: true` puts them on their own axis (a count beside an amount).
- `funnel`: ordered stages. From fields: `stages: [{ label, field?, agg? }]`, each one aggregation over all rows (or a path into a one-object answer). From categories: `x` (or `groupBy`) with `y` or `agg: "count"`, and `order: ["cart", "paid", "shipped"]` for the stage order.
- `where: [{ field, op, value }]` keeps only the rows that match, before anything is counted: `op` `eq`, `neq`, `in` (a list), `contains`, `gt`, `gte`, `lt`, `lte`, `empty`, `notEmpty`; `value` may be `{ "filter": "<filterId>" }` (below). Use it when the tool has no param for the condition ("only ad sets that spent": `{ "field": "spend", "op": "gt", "value": 0 }`).
- `link`: where a row leads, so a person goes from a figure to the record. An app path with fields: `"/tickets/{{id}}"`, or a record of the source's app: `{ "entity": "order", "idField": "id" }` (the app's entity name; `app` when it is another app). A table's rows become clickable, and every block's drill-down rows too. `drillColumns: [{ field, label }]` chooses what the drill-down shows per row (default the table's columns, else the fields the block uses).
- `sort: { field, dir }`: `field` is the category field to order by category, or the aggregated field (or `value`) to order by value. Defaults: lines and date buckets by date ascending, bars and pies by value descending. `limit` keeps at most that many (100 at most).
- `format`: `number`, `currency` (with `currency: "EUR"`), `percent` or `date`.
- Fields may be dotted paths (`billing.country`). Numbers sent as text (`"12.50"`) are read as numbers.
- `source.rowsPath` names where the rows are when the result is not a list and has more than one list field.
- At most 2,000 source rows are read per block. A source that answers a `nextCursor` is read page by page up to that.
- `width` is 1, 2 or 3 columns; `refreshSec` (60 to 86400) is how long the data is kept before it is read again, at most 15 minutes whatever the value.

### Calculated values

- A metric computed from several figures: `map.values` names each one (`{ field?, agg?, dataset?, where? }`: an aggregation of the block's rows, or of another shared dataset's with `dataset`; `where` with fixed values only) and `map.expr` combines them: `{ "values": { "revenue": { "field": "total" }, "spend": { "field": "cost", "dataset": "ads" } }, "expr": "revenue / spend" }` (ROAS).
- A chart's measure computed per category: give measures a `name`, then a measure `{ "label": "ROAS", "expr": "revenue / spend" }`. A measure read from another dataset by the same category: `{ "label": "Spend", "name": "spend", "dataset": "ads", "field": "cost", "categoryField": "date" }` (`categoryField`: the category's field in that dataset, default the same; same date bucket).
- `expr` grammar: numbers, names, `+ - * /`, parentheses, `min(...)`, `max(...)`, `abs(x)`, `round(x, decimals)`. A division by zero or a missing value shows no value.
- `map.scale`: multiplies every value (`0.01` turns cents into units). `map.percentOfTotal: true` (bar, line, area, pie, funnel): each value as a percentage of its series' total; set `format: "percent"`.

### Shared datasets

When two or more blocks read the same source with the same params (a count and a list of the same orders, a chart and a table of the same ad spend), declare it once in `datasets` and point each block at it with `"dataset": "<id>"` instead of `source`. The source then runs once per view for all of them: fewer calls to rate-limited services, and blocks that always agree. Each block keeps its own `map` (and `where`). A dataset's params take the same date, range and filter tokens as a block's.

### Filters

`filters` puts pickers above the dashboard (at most 8), for slicing by market, channel, customer type or campaign instead of one dashboard per slice. Each person's picks are remembered for them.

- `{ "id": "market", "label": "Market", "type": "select" | "multi" | "text", "options": [...], "default": "FR" }`. `options` is a list, or `{ "fromDataset": "orders", "field": "market" }` / `{ "fromSource": {...}, "field": "name" }` for the values found in the data. A `text` filter has no options.
- A source reads a filter with `{{filter.market}}` in its params. Empty (the person chose all) drops that param, so put the token in its own param. A multi filter's whole-string token becomes a list; inside a longer text its values are joined by commas.
- When the tool has no param for it, filter the rows instead: `"where": [{ "field": "market", "op": "eq", "value": { "filter": "market" } }]` (empty filter = every row; several values = any of them).
- Preview with `kernel__dashboards_preview_block({ block, datasets, filters, filterValues: { "market": ["FR"] } })`.

### Text notes

A `text` block has no source: `{ "id": "notes", "type": "text", "title": "How to read this", "text": "**B2B** = orders tagged `b2b`. Target: 40 units a month.", "width": 3 }`. Use one for definitions (what "B2B" or "active" means here), targets and caveats, rather than long titles. Markdown, at most 4,000 characters.

### One worked block per chart type

The source below is a connector read of a shop's orders; use the tool and params `kernel__dashboards_sources` gave you.

### The dashboard time range

A dashboard has a time range the viewer picks (last 7, 30 or 90 days, month, quarter or year to date, last month, quarter or year, or custom dates) and a comparison (same period last year by default, or the previous period). Each person's choice is remembered for them.

- A block that should follow it (sales, spend, orders over a period) uses `{{range.from}}` and `{{range.to}}` (days, inclusive) in its params instead of its own dates; `{{range.fromTime}}` / `{{range.toTime}}` give the first and last second as date-times for APIs that need one; `{{range.endExclusive}}` is the first instant after the range (midnight of the next day), for a filter written `< end` that must not lose the last second. Offsets work: `{{range.from-1d}}`. Title it without a period ("Revenue"): the dashboard names the range.
- Such a block is also run over the comparison window: a metric shows the change, a chart the previous values.
- A block about a fixed window or no window ("open orders, last 90 days", "stock") keeps its own tokens: it says its own dates and is not compared. Set `"timeRange": "fixed"` on it to make that explicit.
- The dashboard's default: root `"timeRange": { "preset": "mtd" }` (presets `last7d`, `last30d`, `last90d`, `mtd`, `lastMonth`, `qtd`, `lastQuarter`, `ytd`, `lastYear`, or `custom` with `from` and `to`) and `"compare": "lastYear" | "previousPeriod" | "none"`. Without them: the last 30 days, compared with last year.
- Preview a range block with `kernel__dashboards_preview_block({ block, timeRange })` (default the last 30 days).

A metric can carry `map.target` (a number, the goal: "objective 40" belongs here, not in the title) and `map.sparkline: { field, bucket }` (its trend by `day`, `week`, `month`, `quarter` or `year` of a date field of the same rows).

### Export and send a dashboard

- A person exports from the dashboard itself (a block's CSV, the dashboard's PDF). For them, `kernel__dashboards_pdf({ dashboardId, timeRange?, compare?, filters? })` prints it as you see it and returns a `fileId` to attach to a reply or a mail.
- `kernel__dashboards_snapshot({ dashboardId, timeRange?, compare?, filters? })` reads every block at once: a metric's value, compared value and change; a chart's totals per series with their change and its top labels; a table's first rows. Use it to answer "how did last week go" from a dashboard, quoting the figures it returns.

### Send a dashboard on a schedule

"Send me / the team this dashboard every Monday at 8" is a routine, never a new mechanism: `kernel__create_routine` with `kind: "recurring"`, a `cron` (`0 8 * * 1`), and a prompt such as: "Call kernel__dashboards_snapshot for dashboard <id> with timeRange {preset: "last7d"} and recipients [<ids>]; post the key figures, each with its change, to this thread; call kernel__dashboards_pdf with the same period and recipients and attach the file." Its scopes: `kernel:dashboards:read`, plus what the delivery needs (`kernel:threads:write` to post in a shared thread, the mail tool's scope to email). Follow author-routine for the scopes and the approval.

Who receives it only ever gets what they could see themselves:
- The routine computes the figures with its OWNER's access. For one person, the simplest is a routine that person owns: its result posts to their own routine thread.
- For a shared thread or an email to several people, the prompt passes them as `recipients` to BOTH tools and sends only to the people in `sendTo`, saying who is in `leftOut` and why (no access to the dashboard or to one of its sources, or they see fewer rows than the owner: narrower dimension grants or roles). Never send it to anyone in `leftOut`, nor to anyone not checked. When the tool refuses (`no_recipient_may_receive`), send nothing.
- Someone left out for seeing fewer rows gets their own routine, owned by them (one routine per person): it reads with their own access.

### Rolling dates

For a range that should move with the calendar ("this month", "last 30 days"), write a date token in the params, never today's date. Each token becomes a `YYYY-MM-DD` date in the org's timezone every time the block runs. A literal date stays that date forever.

- Anchors: `{{today}}`, `{{yesterday}}`, `{{startOfWeek}}` (Monday), `{{startOfMonth}}`, `{{startOfQuarter}}`, `{{startOfYear}}`, `{{endOfWeek}}`, `{{endOfMonth}}`, `{{endOfQuarter}}`, `{{endOfYear}}`.
- One optional offset: `+` or `-`, a number, a unit `d` days, `w` weeks, `M` months (capital M), `y` years.
- Last 30 days: `{ "since": "{{today-30d}}", "until": "{{today}}" }`. This month: `{{startOfMonth}}` to `{{today}}`. Last month: `{{startOfMonth-1M}}` to `{{endOfMonth-1M}}`. This year: `{{startOfYear}}` to `{{today}}`.
- Tokens work inside a text too: `"query": "... WHERE segments.date BETWEEN '{{today-29d}}' AND '{{today}}'"`.
- Nothing else goes between `{{` and `}}` (no `{{tomorrow}}`, no spaces): the preview refuses it and names the allowed forms.
- A period the viewer should be able to change is the dashboard range above, not a rolling token.
- Title the block for the range it covers ("Revenue, last 30 days"); with a literal date, name that date.

```
{ "v": 1,
  "datasets": {
    "orders": { "kind": "tool", "tool": "api-connector:connector_read",
                "params": { "connection": "shop", "operation": "orders_list", "country": "{{filter.market}}" } } },
  "filters": [ { "id": "market", "label": "Market", "type": "select", "options": { "fromDataset": "orders", "field": "billing.country" } } ],
  "blocks": [
  { "id": "revenue", "type": "metric", "title": "Revenue", "width": 1, "dataset": "orders",
    "map": { "value": "total", "agg": "sum", "format": "currency", "currency": "EUR" } },

  { "id": "orders", "type": "metric", "title": "Orders", "width": 1, "dataset": "orders",
    "map": { "agg": "count" } },

  { "id": "by-day", "type": "combo", "title": "Revenue and orders by day", "width": 2, "dataset": "orders",
    "map": { "groupBy": { "field": "date_created", "bucket": "day" },
             "measures": [ { "label": "Revenue", "field": "total", "agg": "sum" }, { "label": "Orders", "agg": "count" } ],
             "lineSeries": ["Orders"], "secondaryAxis": true } },

  { "id": "top", "type": "bar", "title": "Top products", "width": 2,
    "source": { "kind": "tool", "tool": "api-connector:connector_read",
                "params": { "connection": "shop", "operation": "top_sellers" } },
    "map": { "x": "name", "y": "quantity", "limit": 10, "horizontal": true } },

  { "id": "status", "type": "pie", "title": "Orders by status", "width": 1, "dataset": "orders",
    "map": { "groupBy": { "field": "status" }, "agg": "count" } },

  { "id": "recent", "type": "table", "title": "Recent orders", "width": 3, "dataset": "orders",
    "map": { "columns": [ { "field": "number", "label": "Order" }, { "field": "billing.last_name", "label": "Customer" },
                          { "field": "total", "label": "Total", "format": "currency" }, { "field": "date_created", "label": "Date", "format": "date" } ],
             "where": [ { "field": "status", "op": "neq", "value": "cancelled" } ],
             "sort": { "field": "date_created", "dir": "desc" }, "limit": 20, "currency": "EUR" } },

  { "id": "notes", "type": "text", "title": "Notes", "width": 3,
    "text": "Revenue includes tax. Cancelled orders are left out of the list." }
] }
```

A data store collection as a source: `"source": { "kind": "store", "app": "agent", "collection": "deals", "query": { "where": { "stage": "won" } } }`.

**Say only what your results show.** Report a dashboard as saved only when `kernel__dashboards_create` returned its id; an org one is waiting for a person until approved.
