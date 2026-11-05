---
title: Control data visibility with dimensions
description: Limit which inboxes, calendars, support teams and sensitivity levels each person sees inside an app, on top of their role's permissions.
---

A role's scopes decide what a person can do in an app. Dimensions decide which records inside that app they see: which mail inboxes, which calendar accounts, which support team's tickets, and up to which sensitivity level. The database enforces them, so an agent acting for a person sees exactly what that person sees.

## Know the dimensions your apps declare

Apps declare their dimensions. With the built-in apps you have:

| Dimension | App | Type | Values |
|---|---|---|---|
| **Inbox** (`mail:inbox`) | Mail | membership | the org's connected mailboxes |
| **Calendar access** (`calendar:calaccess`) | Calendar | membership | the org's connected Google Calendar accounts |
| **Team** (`tickets:team`) | Tickets | membership | `support-us`, `support-eu`, `support-apac`, `support-east`, `support-west` |
| **Sensitivity** (`tickets:sensitivity`) | Tickets | level | `internal`, `confidential`, `restricted`, in that order |

A ticket's messages follow the ticket's team and sensitivity. Mail conversations and messages follow their mailbox.

## Know how a grant is read

- **Membership** (inbox, calendar, team): a person sees a record whose value is one they were granted. A record with no value set is unclassified and visible to anyone with the scope.
- **Level** (sensitivity): a grant is a clearance. A `confidential` grant shows `internal` and `confidential` tickets, not `restricted` ones. With no grant, a person sees only the lowest band, `internal`, and records with no level.
- **Wildcard**: the **admin** role carries the wildcard grant `*`, so admins see everything. The wildcard is set when the org is created and cannot be granted through the API.
- **Several sources add up**: a person gets the union of the values from all their roles and their own direct grants. A dimension cannot take away what another grant gives.

## Grant a person access to a team or an inbox

1. Open **Settings › Users** and click the person.
2. Under **Which teams and sensitivity levels**, tick the values they should see. For a dimension whose values are managed elsewhere, such as mail inboxes, follow the **Manage in** link.

Or from **Settings › Roles & access**:

1. In the **Data access** section, click the teammate.
2. Tick the values (checkboxes for membership, a choice for sensitivity level).

A value marked **from role** comes from one of the person's roles. You cannot untick it here: change the role instead.

You cannot grant values you do not hold yourself. If you untick your own access to a mail inbox, Liaison asks you to confirm with **Revoke access**: you lose access to that inbox but keep account management.

The grant applies the next time the person's access token refreshes.

## Let an agent grant access

| Tool | What it does |
|---|---|
| `list_dimensions` | Lists the org's dimensions, their types, values and the settings page that manages each one |
| `grant_dimension_value` | Grants a person one or more values of an existing dimension. Waits for a person's approval. |

Both need `kernel:users:admin`. An agent cannot invent a dimension: if the attribute you want to slice by is not in `list_dimensions`, no app declares it.

## Grant a dimension to a role

Role dimension grants exist, and a person inherits them from every role they hold. The settings pages edit grants per person. To set one on a role, call the REST API: `POST /api/admin/roles/<roleId>/dimensions`. See the [REST API](../developers/rest-api.md).

For scopes and roles, see [Set up roles](roles.md). For how this applies to agents, see [Agent permissions](../agents/permissions.md).
