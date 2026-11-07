---
name: build-dashboard
type: skill
description: Build a dashboard, chart, graph, KPI, report or tableau de bord from the org's data (sales by day, orders count, top products, tickets by status).
---

### Building a dashboard

A dashboard is a grid of up to 24 blocks. Each block is one chart (`metric`, `table`, `bar`, `line`, `pie`) over one **source**, and a **map** that the server applies to the source's rows. Every block runs as the person viewing it: someone who may not call a block's tool sees "no access" for that block only.

Always in this order:

1. **Find the sources.** `kernel__dashboards_sources` with words of what to show (`orders`, `tickets`, `revenue`) lists the reads you may chart, with their params and result fields. Only read tools qualify: never a tool that writes, sends or needs an approval. A collection of the data store is a source too (`kernel__data_collections_list`). Data from another system (a shop, a CRM) comes through its connector's read tool; if no connection exists, set it up first.
2. **Preview every block** with `kernel__dashboards_preview_block({ block })`. It runs the source as you and returns exactly what the chart will draw, and saves nothing. Read the result: the labels, the values, `meta.skippedRows` (rows whose date or number was unusable) and `meta.truncated`. Fix the map and preview again until the numbers are right. A refusal says why and lists `alternatives`: use one of them, never a tool it did not list.
3. **Save** with `kernel__dashboards_create({ title, visibility, spec })`. `personal` (only the person) saves at once. `org` (everyone) waits for a person's approval: say it is waiting, never that it exists. Editing or deleting an org dashboard waits for an approval too.
4. **Open it** for the person: `kernel__open_app({ app: "kernel", view: "dashboard", id })`.

To change one: `kernel__dashboards_get` (note its `version`), then `kernel__dashboards_update({ id, spec, ifVersion })` with the WHOLE spec.

### The map

- `groupBy: { field, bucket? }`: the category. `bucket` `day`, `week` or `month` turns a date field into a date bucket (UTC).
- `agg`: `sum` (default), `count`, `avg`, `min`, `max`. `count` needs no field.
- `metric`: `value` is the field aggregated over every row. When the source answers one object instead of rows, `value` is the path to its number (`totals.sales`).
- `table`: `columns: [{ field, label, format? }]`, plus `sort` and `limit`. A table shows rows: no `groupBy` or `agg`.
- `bar` and `line`: the category is `groupBy` (or `x`); `y` is aggregated per category; `series` splits it into one line or bar per value of that field.
- `pie`: the slice is `groupBy` (or `label`); `value` is aggregated per slice.
- `sort: { field, dir }`: `field` is the category field to order by category, or the aggregated field (or `value`) to order by value. Defaults: lines and date buckets by date ascending, bars and pies by value descending. `limit` keeps at most that many (100 at most).
- `format`: `number`, `currency` (with `currency: "EUR"`), `percent` or `date`.
- Fields may be dotted paths (`billing.country`). Numbers sent as text (`"12.50"`) are read as numbers.
- `source.rowsPath` names where the rows are when the result is not a list and has more than one list field.
- At most 2,000 source rows are read per block. A source that answers a `nextCursor` is read page by page up to that.
- `width` is 1, 2 or 3 columns; `refreshSec` (60 to 86400) is how long the data is kept before it is read again.

### One worked block per chart type

The source below is a connector read of a shop's orders; use the tool and params `kernel__dashboards_sources` gave you.

```
{ "v": 1, "blocks": [
  { "id": "revenue", "type": "metric", "title": "Revenue, last 30 days", "width": 1,
    "source": { "kind": "tool", "tool": "api-connector:connector_read",
                "params": { "connection": "shop", "operation": "orders_list", "params": { "after": "2026-10-08T00:00:00" } } },
    "map": { "value": "total", "agg": "sum", "format": "currency", "currency": "EUR" } },

  { "id": "orders", "type": "metric", "title": "Orders", "width": 1,
    "source": { "kind": "tool", "tool": "api-connector:connector_read",
                "params": { "connection": "shop", "operation": "orders_list", "params": { "after": "2026-10-08T00:00:00" } } },
    "map": { "agg": "count" } },

  { "id": "by-day", "type": "line", "title": "Revenue by day", "width": 2,
    "source": { "kind": "tool", "tool": "api-connector:connector_read",
                "params": { "connection": "shop", "operation": "orders_list", "params": { "after": "2026-10-08T00:00:00" } } },
    "map": { "groupBy": { "field": "date_created", "bucket": "day" }, "y": "total", "agg": "sum", "format": "currency", "currency": "EUR" } },

  { "id": "top", "type": "bar", "title": "Top products", "width": 2,
    "source": { "kind": "tool", "tool": "api-connector:connector_read",
                "params": { "connection": "shop", "operation": "top_sellers" } },
    "map": { "x": "name", "y": "quantity", "limit": 10 } },

  { "id": "status", "type": "pie", "title": "Orders by status", "width": 1,
    "source": { "kind": "tool", "tool": "api-connector:connector_read",
                "params": { "connection": "shop", "operation": "orders_list" } },
    "map": { "groupBy": { "field": "status" }, "agg": "count" } },

  { "id": "recent", "type": "table", "title": "Recent orders", "width": 3,
    "source": { "kind": "tool", "tool": "api-connector:connector_read",
                "params": { "connection": "shop", "operation": "orders_list" } },
    "map": { "columns": [ { "field": "number", "label": "Order" }, { "field": "billing.last_name", "label": "Customer" },
                          { "field": "total", "label": "Total", "format": "currency" }, { "field": "date_created", "label": "Date", "format": "date" } ],
             "sort": { "field": "date_created", "dir": "desc" }, "limit": 20, "currency": "EUR" } }
] }
```

A data store collection as a source: `"source": { "kind": "store", "app": "agent", "collection": "deals", "query": { "where": { "stage": "won" } } }`.

**Say only what your results show.** Report a dashboard as saved only when `kernel__dashboards_create` returned its id; an org one is waiting for a person until approved.
