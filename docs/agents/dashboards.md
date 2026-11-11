---
title: See your dashboards
description: "Open the dashboards your agent built for you or for the whole org, refresh their figures, and read why a block shows no data."
---

A dashboard is a page of figures, tables and charts that your agent builds from your data. Each block reads its data as you, with your own access: two people looking at the same dashboard may see different numbers.

## Open a dashboard

Click **Dashboards** in the bar on the left (on a phone, in **Work**). The page shows every dashboard you can see as a card: who sees it, how many blocks it has and when it last changed. With none yet, it says what a dashboard is and how to get one.

The **Dashboards** sidebar stays beside the page and beside every open dashboard:

- **Filter dashboards** narrows the list by title.
- **All dashboards** opens the page.
- **Yours** lists your own dashboards. The ones you shared with the team carry a people icon.
- **Shared with the team** lists the dashboards others shared, each with its owner's first name.
- The dashboard you have open is highlighted.

- Click a dashboard to open it in its own tab. The tab's address is `/dashboard/<id>`, and the tab is named after the dashboard.
- Your agent can also open a dashboard for you when it has made or changed one. A tab already open then shows the dashboard as it is now, and so does **Refresh all**.

The lists stay up to date without reloading the page. When someone, or an agent working for them, creates, renames, shares or deletes a dashboard you can see, the **Dashboards** page and sidebar show it at once. An open dashboard tab shows the new version, or says "This dashboard no longer exists, or it is not shared with you." once it was deleted or made personal by its owner. Nobody is told about your personal dashboards.

To get a dashboard, ask your agent, for example: "Build me a dashboard of last month's orders, with revenue by day and the ten most recent orders."

## Read and refresh the figures

The bar at the top of the dashboard shows its title, the period it shows when a block follows one, who sees it (**Personal** or **Org**) and **Refresh all**.

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
| This block's source is no longer available. Ask your agent to pick another one. | The app or connection behind the block was removed or turned off. |
| This block no longer fits its source's data. Ask your agent to fix it. | The source's data changed shape, so the block's chart settings no longer apply. |
| This block's data could not be read. Try again later. | The source failed, for example a connected service did not answer. |
| No data for this block yet | The source answered with nothing to show. |
| Some rows are left out: the block shows the first ones. | The source returned more rows than a block shows, or more than 20 series (the largest are kept). |

## Who can make and share dashboards

| Scope | What it allows |
| --- | --- |
| `kernel:dashboards:write` | Make, change and delete your own personal dashboards. |
| `kernel:dashboards:share` | Also share your own dashboard with the org, and change or delete your own org dashboards. |
| `kernel:dashboards:admin` | Change or delete any org dashboard, and decide the agent's requests about org dashboards. |

Every member can make dashboards: the **member** role and the **Full Member** role both hold `kernel:dashboards:write` and `kernel:dashboards:share` ([Set up roles](../admin/roles.md)). Only administrators hold `kernel:dashboards:admin` by default; give it to another role to let its people decide the agent's org dashboards.

Everyone can list and open the dashboards they see: every active member holds `kernel:dashboards:read`, whatever their roles, and so does an agent working for them.

Your personal agent builds dashboards with your access. A named agent, such as a team's sales or support agent, builds them when `kernel:dashboards:write` is in its scopes, and always with the access of the person it works for. An agent declared in the config file gets it with its common base; an agent created before that gets it the next time the server starts ([Create an agent](create-an-agent.md)). A named agent can never hold `kernel:dashboards:admin`. Asked for a dashboard without that access, the agent says which access is missing instead of saying dashboards do not exist.

Nobody else sees a personal dashboard, administrators included. Your own changes are never held for approval: your scopes decide. When the **agent** creates an org dashboard, makes one org-visible, or changes or deletes an org dashboard, the change waits for a person who holds `kernel:dashboards:admin`. The approval card lists the title and each block with the tool or collection it reads, and the rolling dates it uses with the date each one stands for today. A personal dashboard the agent makes for you saves at once.

## Ask your agent to change a dashboard

Ask for the changes in plain words, for example: "Add Google spend by campaign after the orders, remove the stock table, and open the dashboard on last month." The agent sends everything you asked for in one go, applied in order: add, change, move or remove a block, rename the dashboard, set the period it opens on, add, change or remove a shared dataset or a filter, or share it. Either every change is saved, or none is.

On an org dashboard the whole request waits for **one** approval by a person who holds `kernel:dashboards:admin`. Its card numbers the changes, one line each: the block added, changed, moved or removed with its title and position, the tool or collection it reads with its settings (or the shared dataset it reads), each date in them and what it stands for today, the rows it keeps, each filter with its choices and default, and the period the dashboard opens on. If someone saved the dashboard in the meantime, the change is refused and the agent reads it again. A change to your personal dashboard saves at once.

## Time range and comparison

A dashboard can follow a time range: last 7, 30 or 90 days, this month, quarter or year to date, last month, quarter or year, or two dates of your choice. The blocks that follow it are compared with another period: the same period last year by default, or the period just before. A metric then shows its previous value beside the current one, and a chart the previous values for each point.

- Whoever builds the dashboard (usually your agent) sets the range it opens on. Without one, it is the last 30 days, compared with last year.
- The range you choose on a dashboard is remembered for you alone, on that dashboard. Others keep their own choice.
- A block that keeps its own dates (for example "open orders, last 90 days", or stock with no date) is not affected by the range and is not compared. It says the dates it reads.
- Dashboards built before time ranges existed keep their blocks' own dates.

A metric can also show a goal (its target) and its trend over the period as a small line.

## Choose the period

When at least one block follows the time range, the bar at the top shows the period as days, with the period it is compared with: for example "1–11 Nov 2026 · vs 1–11 Nov 2025". Click it to change it:

- Under **Period**: **Last 7 days**, **Last 30 days**, **Last 90 days**, **Month to date**, **Last month**, **Quarter to date**, **Last quarter**, **Year to date**, **Last year**, or **Custom range…**, which asks for a **From** and a **To** day and applies them with **Apply**.
- Under **Compare to**: **Same period last year**, **Previous period** or **No comparison**.
- **Back to the dashboard's default** forgets your choice. It shows once you have picked a period on that dashboard.

The blocks that follow the period read again at once. Your choice is remembered for you on that dashboard, and it goes into the tab's address (`?range=lastMonth&compare=lastYear`, or `?range=custom&from=2026-11-01&to=2026-11-11`), so a link you copy opens on the same period. A dashboard opens on the period in its link, else on the one you last chose there, else on its default.

A block that keeps its own dates says them in a small label next to its title, such as "Since 13 Aug 2026", or **Own period** when it reads no dates at all.

## What the figures show

- A metric that is compared shows the change under the figure, with an arrow and its sign, for example "+12% vs same period last year". It is never coloured red or green: up is not always good news.
- A metric with a target shows "30 of 40" and a thin bar of the progress toward it, and a metric with a trend shows it as a small line beside the figure.
- A chart draws the compared period's values lighter (dashed for a line), named **Same period last year** or **Previous period**.
- Under each block, "Updated 4 min. ago" says when its figures were read. A block built with its own refresh interval reads again on that interval, but only while its tab is on screen.
- A block that follows the period and finds nothing says which days it read: "No data between 1 Nov and 11 Nov".
- "3 rows are left out: a field they need is missing or unreadable." means some of the source's rows lacked a date or a number the block needs. "The comparison could not be read this time." means the compared period failed while the current figures still show.

## Chart types, notes and filters

Besides metrics, tables, bars, lines and pies, your agent can build:

- an **area** chart (a line filled), and **stacked** bars or areas (spend by platform, one colour per platform);
- **horizontal** bars, for long names and rankings;
- a **combo** chart: bars and lines over the same days or categories, the lines optionally on their own axis (revenue as bars, order count as a line);
- a **funnel**: ordered stages, such as cart, paid, shipped, from one field per stage or from the values of one field;
- a **text** note: a few lines of formatted text with no data behind it, for definitions ("B2B means orders tagged b2b"), targets and caveats.

A dashboard can also have **filters** (at most 8), such as a market, a channel or a campaign: pick one value, several, or type a text. Each block that reads a filter shows only the matching data: either the source is asked for that value, or the block keeps only the rows that match. A filter left empty means everything. The values you pick are remembered for you alone, on that dashboard, like the time range. A filter's choices are a fixed list, or the values found in the dashboard's own data.

A block can keep only some rows of its source ("only the ad sets that spent", "without cancelled orders") before anything is counted.

When several blocks show the same data (a count and the list of the same orders, a chart and a table of the same ad spend), your agent declares that data once as a **shared dataset**: it is read once for all of them, so the dashboard loads faster, asks connected services less often, and its blocks always agree.

## See the records behind a figure

A block's figures come from rows of its source, and you can see those rows: the orders behind a bar, the ad sets in a slice, the rows a metric adds up. They are read from the figures already loaded, never by running the source again while those are fresh, with the same access as the block. When the block says where a row leads (an order, a ticket, a contact), each row opens that record in Liaison.

## What a block can read

Each block reads one source:

- a **read tool** of an app or a connector, such as a connector's read of a shop's orders. A tool that changes data, sends something, needs an approval or acts outside Liaison is refused. From the kernel only a short list of reads qualifies: `users_list`, `contacts_search`, `threads_list`, `list_routines`, `approvals_list` and `audit_search`. An organization's own custom app feeds a dashboard under the same rules; another organization's never does.
- a **data store collection** that its app declares readable outside the app, read with the collection's read scope (the agent's own collections need `kernel:data:read`).

The same holds for a shared dataset and for a filter that lists the values of a source. The source is checked when the dashboard is saved, as its author, and again every time a block is shown, as the viewer. A tool that later starts asking for approval shows "This block's source can no longer be shown on a dashboard". A block's run may only read: any write it attempts is refused, even when the tool claims to be a read. A tool can still call an outside service while it reads; a dashboard does not stop that.

A block reads at most 2,000 rows from its source, and shows at most 100 rows, bars or slices. A dashboard holds at most 24 blocks. Each source run is recorded in the audit log (`dashboard.block_run`) with the dashboard and the block, the shared dataset or the filter it was read for.

## Rolling date ranges

A block's source settings can hold a rolling date, so "this month" or "the last 30 days" moves with the calendar instead of staying on the day the dashboard was built. Each one is replaced by a date (`YYYY-MM-DD`) every time the block runs, in the organization's timezone (UTC when none is set):

| Written | Stands for |
| --- | --- |
| `{{today}}` | Today. |
| `{{yesterday}}` | Yesterday. |
| `{{startOfWeek}}` | Monday of this week. |
| `{{startOfMonth}}` | The 1st of this month. |
| `{{startOfQuarter}}` | The 1st day of this quarter. |
| `{{startOfYear}}` | January 1st of this year. |
| `{{endOfWeek}}`, `{{endOfMonth}}`, `{{endOfQuarter}}`, `{{endOfYear}}` | The last day of this week (Sunday), month, quarter or year. |
| `{{range.from}}`, `{{range.to}}` | The first and last day of the dashboard's time range, as the viewer chose it. |
| `{{range.fromTime}}`, `{{range.toTime}}` | The first and last second of that range, as a date and time with the organization's UTC offset. |

Each may carry one offset (not the two date and time forms): `+` or `-`, a number, and `d` (days), `w` (weeks), `M` (months) or `y` (years). For example `{{today-30d}}`, `{{startOfMonth-1M}}` (the 1st of last month) or `{{endOfMonth-1M}}` (the last day of last month). A month or year offset keeps the day, moved back to the month's last day when the month is shorter; on an end-of date it moves the whole period, so `{{endOfMonth-1M}}` is always last month's last day. A rolling date also works inside a longer text, such as a query's `BETWEEN '{{today-29d}}' AND '{{today}}'`. A date written out in full stays that date. Anything else between `{{` and `}}` is refused when the block is previewed or saved.

## How long figures are kept

A block's figures are kept for a minute, or for the block's own interval, set by whoever built it (at most 15 minutes, whatever the interval; a shared dataset follows the shortest interval of its blocks). They are kept per person and per set of access rights (scopes, dimension grants and roles), so a change to your access is never answered with figures read under the old one. A block with rolling dates reads again as soon as its dates move, a block that follows the time range keeps its figures per range, and a filter value its source reads is a new read. A filter that only keeps some rows never reads the source again. Blocks of one shared dataset that load together wait for the same read, and refreshing them one after the other within 30 seconds reads it once. A block runs at most four sources at once for one person; the rest wait their turn. One refresh per block per person every 30 seconds. A block whose source failed keeps that answer for 30 seconds too, so opening the dashboard again does not run the failing source again; **Refresh** reads it at once. Closing the tab stops its blocks' reads.

## The dashboards API

Signed-in requests, with the person's own access:

| Request | What it does |
| --- | --- |
| `GET /api/dashboards` | Your dashboards and the org's. |
| `POST /api/dashboards` | Create one: `{ title, visibility, spec }`. |
| `GET /api/dashboards/:id` | One dashboard and its spec, the range it opens on for you (`range`, with `saved` when it is your own choice), its default (`defaultRange`), which blocks follow the range (`blockTimeRange`), and the filter values it opens on for you (`filters.values`, `filters.saved`) with their defaults (`defaultFilters`). |
| `PATCH /api/dashboards/:id` | Change `title`, `visibility` or `spec`; `ifVersion` refuses to overwrite a newer save (409). |
| `DELETE /api/dashboards/:id` | Delete it. |
| `GET /api/dashboards/:id/blocks/:blockId/data` | One block's data, run as you. `?refresh=1` reads it again. `?range=<preset>` (`last7d`, `last30d`, `last90d`, `mtd`, `lastMonth`, `qtd`, `lastQuarter`, `ytd`, `lastYear`), or `?from=YYYY-MM-DD&to=YYYY-MM-DD`, and `?compare=lastYear\|previousPeriod\|none` set the range; without them, the dashboard's default. `?f.<filterId>=<value>` (repeated for several values) sets a filter; an absent filter takes its default, an empty one means all. |
| `GET /api/dashboards/:id/blocks/:blockId/rows` | The rows behind a figure, read-only: `?category=<label>` (and `?series=<name>`) for a chart, `?row=<index>` for a table row, nothing for a metric; `?offset=` and `?limit=` (at most 200) page them. Range and filters as for the data. Answers `columns`, `rows`, `links` (where each row leads), `total` and `nextOffset`. |
| `GET /api/dashboards/:id/filters/:filterId/options` | A filter's choices: its list, or the values found in its data (at most 200, `?q=` narrows them). |
| `GET /api/dashboards/:id/viewer-state` | The range and filter values you last chose on this dashboard, or `null`. |
| `PUT /api/dashboards/:id/viewer-state` | Remember your choice: any of `{ timeRange: { preset, from?, to? }, compare, filters: { <filterId>: [values] } }`. |
| `DELETE /api/dashboards/:id/viewer-state` | Forget it: the dashboard opens on its defaults again. |

A block's data is the chart's shape (`kind`, then `value`, `rows` or `labels` and `series`, a note's `markdown`, and `meta`; with a comparison, `previous`; a metric's `target` and `sparkline`; how a chart is drawn in `display`; a table's `links`), with `computedAt`, `window` (the days it read, or its own dates) and `compareWindow`, or the block's own refusal `{ error, message }` with `error` one of `no_access`, `not_allowed`, `unknown_tool`, `source_failed`, `invalid_map` or `rate_limited`. Both answer 200, so the other blocks still render. A spec the server refuses answers 422 with every problem named; an unknown filter or a value outside a filter's list answers 400.
