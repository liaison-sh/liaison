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
