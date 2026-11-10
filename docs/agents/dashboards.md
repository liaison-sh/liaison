---
title: See your dashboards
description: "Open the dashboards your agent built for you or for the whole org, refresh their figures, and read why a block shows no data."
---

A dashboard is a page of figures, tables and charts that your agent builds from your data. Each block reads its data as you, with your own access: two people looking at the same dashboard may see different numbers.

## Open a dashboard

Dashboards are listed on **Home**, in the **Dashboards** section of the sidebar. The section appears once you have one.

- Your own dashboards come first, then the ones shared with the org, marked **Org**.
- Click a dashboard to open it in its own tab. The tab's address is `/dashboard/<id>`, and the tab is named after the dashboard.
- Your agent can also open a dashboard for you when it has made or changed one.

To get a dashboard, ask your agent, for example: "Build me a dashboard of last month's orders, with revenue by day and the ten most recent orders."

## Read and refresh the figures

The bar at the top of the dashboard shows its title, who sees it (**Personal** or **Org**) and **Refresh all**.

- Blocks keep their figures for a short while. **Refresh all** reads every block again from its source.
- Each block also has its own refresh button, next to its title.
- A block refreshed a moment ago keeps its figures and says "Just refreshed. Try again in a few seconds."

Blocks sit on a grid by their width: up to three side by side on a wide screen, one above the other on a phone.

## When a block shows no data

A block that cannot draw says why, and the rest of the dashboard still shows:

| Message | What it means |
| --- | --- |
| You don't have access to the data behind this block. | The block reads a tool or a collection your role does not allow. Ask an administrator for the access. |
| This block's source can no longer be shown on a dashboard. | The source now asks for approval or changes data, so a dashboard may not run it. Ask your agent to pick another source. |
| This block's data could not be read. Try again later. | The source failed, for example a connected service did not answer. |
| No data for this block yet | The source answered with nothing to show. |
| Some rows are left out: the block shows the first ones. | The source returned more rows than a block shows. |

## Who can make and share dashboards

| Scope | What it allows |
| --- | --- |
| `kernel:dashboards:write` | Make, change and delete your own personal dashboards. |
| `kernel:dashboards:share` | Also share your own dashboard with the org, and change or delete your own org dashboards. |
| `kernel:dashboards:admin` | Change or delete any org dashboard, and decide the agent's requests about org dashboards. |

Every member can make dashboards: the **member** role and the **Full Member** role both hold `kernel:dashboards:write` and `kernel:dashboards:share` ([Set up roles](../admin/roles.md)). Only administrators hold `kernel:dashboards:admin` by default; give it to another role to let its people decide the agent's org dashboards.

Your personal agent builds dashboards with your access. A named agent, such as a team's sales or support agent, builds them only when `kernel:dashboards:write` is in its scopes (`agents[].scopes` in the config file, see [Create an agent](create-an-agent.md)), and still only with the access of the person it works for. A named agent can never hold `kernel:dashboards:admin`. Asked for a dashboard without that access, the agent says which access is missing instead of saying dashboards do not exist.

Nobody else sees a personal dashboard, administrators included. Your own changes are never held for approval: your scopes decide. When the **agent** creates an org dashboard, makes one org-visible, or changes or deletes an org dashboard, the change waits for a person who holds `kernel:dashboards:admin`. The approval card lists the title and each block with the tool or collection it reads. A personal dashboard the agent makes for you saves at once.

## What a block can read

Each block reads one source:

- a **read tool** of an app or a connector, such as a connector's read of a shop's orders. A tool that changes data, sends something, needs an approval or acts outside Liaison is refused. From the kernel only a short list of reads qualifies: `users_list`, `contacts_search`, `threads_list`, `list_routines`, `approvals_list` and `audit_search`. An organization's own custom app feeds a dashboard under the same rules; another organization's never does.
- a **data store collection** that its app declares readable outside the app, read with the collection's read scope (the agent's own collections need `kernel:data:read`).

The source is checked when the dashboard is saved, as its author, and again every time a block is shown, as the viewer. A tool that later starts asking for approval shows "This block's source can no longer be shown on a dashboard". A block's run may only read: any write it attempts is refused, even when the tool claims to be a read. A tool can still call an outside service while it reads; a dashboard does not stop that.

A block reads at most 2,000 rows from its source, and shows at most 100 rows, bars or slices. A dashboard holds at most 24 blocks. Each block's run is recorded in the audit log (`dashboard.block_run`) with the dashboard and the block.

## How long figures are kept

A block's figures are kept for a minute, or for the block's own interval, set by whoever built it (at most 15 minutes, whatever the interval). They are kept per person and per set of access rights (scopes, dimension grants and roles), so a change to your access is never answered with figures read under the old one. A block runs at most four sources at once for one person; the rest wait their turn. One refresh per block per person every 30 seconds.

## The dashboards API

Signed-in requests, with the person's own access:

| Request | What it does |
| --- | --- |
| `GET /api/dashboards` | Your dashboards and the org's. |
| `POST /api/dashboards` | Create one: `{ title, visibility, spec }`. |
| `GET /api/dashboards/:id` | One dashboard and its spec. |
| `PATCH /api/dashboards/:id` | Change `title`, `visibility` or `spec`; `ifVersion` refuses to overwrite a newer save (409). |
| `DELETE /api/dashboards/:id` | Delete it. |
| `GET /api/dashboards/:id/blocks/:blockId/data` | One block's data, run as you. `?refresh=1` reads it again. |

A block's data is the chart's shape (`kind`, then `value`, `rows` or `labels` and `series`, and `meta`), or the block's own refusal `{ error, message }` with `error` one of `no_access`, `not_allowed`, `unknown_tool`, `source_failed`, `invalid_map` or `rate_limited`. Both answer 200, so the other blocks still render. A spec the server refuses answers 422 with every problem named.
