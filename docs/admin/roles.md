---
title: Set up roles
description: See what each role grants, edit a role's permissions, create roles from config or an agent, and answer access requests.
---

A role is a set of permissions (scopes) given to the people who hold it. You manage roles in **Settings › Roles & access**, in the **Workspace** group. You need the `kernel:users:admin` scope.

## Know the roles a new org starts with

| Role | Scopes | Who gets it |
|---|---|---|
| **admin** | `*` (every scope) | The first registered user |
| **member** | `kernel:threads:read`, `kernel:threads:write`, `kernel:contacts:read`, `kernel:contacts:write`, `kernel:products:read`, `kernel:products:write`, `kernel:approvals:read`, `kernel:approvals:write`, `kernel:files:read`, `kernel:files:analyze`, `kernel:saved_views:share`, `kernel:agent:memory`, `kernel:agents:spawn` | A preset for teammates |
| **viewer** | `kernel:threads:read`, `kernel:contacts:read`, `kernel:products:read`, `kernel:approvals:read`, `kernel:files:read`, `kernel:audit:read`, `kernel:agent:memory:read` | A read-only preset |

People who hold `kernel:org:admin` (the **admin** role, or the scope given directly) are on call for incidents until an admin picks the on-call people in **Settings › Notifications › On call** ([Notifications](../notifications.md#on-call)).

**member** and **viewer** cover only the shared workspace. They grant no app scopes, so they do not open Tickets, Projects or Knowledge by themselves.

Each app adds its own roles, named `<app>.<tier>` and shown as **App · Tier**. For example, Tickets adds `support`, `support_lead` and `admin` tiers, Projects adds `member`, `lead` and `admin`, and Knowledge adds `member` and `curator`.

### The Full Member role

Liaison keeps one system-managed role, **Full Member**, that holds every installed app's base member tier: the app's `member` role, or its lowest non-admin tier. When a new app is installed, Full Member gains that app's scopes automatically. It never includes an app's admin, lead or curator tier.

Liaison only adds scopes to Full Member, never removes them. If you remove a scope by hand, it can come back the next time the app registers. Do not delete Full Member: Liaison re-creates it by name, and the agent tool `delete_role` refuses it. Trim its scopes instead.

## Edit a role's permissions

1. Open **Settings › Roles & access** and click the role under **Roles**.
2. Under **Permissions**, tick the capabilities the role should have. Anyone assigned the role gets exactly these permissions.
3. Use **Search permissions…** to filter, **Select all** to tick an app's whole list, or **Clear** to untick it.

A capability marked **inherited** is already granted by a wildcard (`*`, or the app's **Full access**), so you cannot untick it on its own.

Scopes are hierarchical. A shorter scope covers every longer one under it: `kernel:agent:memory` covers `kernel:agent:memory:read`. A trailing `*` covers everything below it: `tickets:*` covers every Tickets scope, and `*` covers everything. There is no deny rule: you cannot grant a parent and take away one child.

An MCP server's permissions (`mcp:<handle>` for the whole server, `mcp:<handle>:<tool>` for one tool) show the server's name, and the role's page lists its **MCP servers** with a link to each. To see only the roles that touch one server, open **Fine-tune in Roles & access** from that server's page: the list is filtered to it, and **Show all roles** clears the filter. Who can use an organization server at all is set on the server's page, not here: see [Choose who can use an organization server](../agents/mcp-servers.md#choose-who-can-use-an-organization-server).

To see who holds a role, read the **Members** list on the role's page. You assign a role to people from their own page in **Settings › Users** (see [Invite and manage users](users.md)).

## Delete a role

1. Open the role and click **Delete role**.
2. Confirm. Permissions granted through the role are revoked.

You cannot delete a role that people still hold. Unassign them first.

## Create a role

The settings page edits existing roles. To create a new one, use one of these:

- **Config file.** Add a `roles` section and run `liaison config apply`. The role is reconciled to exactly the listed scopes: missing ones are granted, extra ones revoked.

  ```yaml
  roles:
    - name: ops
      description: "Shopify, tickets and messages, no finance or ads"
      scopes:
        - "shopify:*"
        - "tickets:*"
        - "kernel:threads:read"
        - "kernel:threads:write"
        - "kernel:contacts:read"
  users:
    - { email: ana@resonantaudiolabs.example, name: "Ana", role: ops }
  ```

  See [Provision from a config file](../provisioning-cli.md).
- **An agent.** Ask your agent to create the role. It uses `kernel:create_role`, which waits for your approval. You can only grant scopes you hold yourself.

## Let an agent manage roles and access

These kernel agent tools manage roles and access. The ones that change access wait for a person to approve them.

| Tool | What it does |
|---|---|
| `roles_list` | Lists roles with their scope counts |
| `get_role` | Reads one role, its scopes and members |
| `create_role` | Creates a role with scope grants |
| `edit_role` | Changes a role's scopes |
| `delete_role` | Deletes a role nobody holds (refused for a system-managed role) |
| `assign_role` | Gives a person a role |
| `remove_user_from_role` | Takes a role away from one person |
| `grant_user_scope` | Grants one scope directly to a person |
| `describe_user_access` | Shows one person's effective scopes and where each comes from |
| `list_scopes` | Lists every grantable scope |
| `users_list`, `users_search` | Finds people |
| `invite_user` | Invites a person |
| `request_scope` | Asks an admin for a missing scope |

An approved change runs with the approving person's own permissions: it can never grant a scope the approver does not hold, even when the person who asked holds it. The audit log records the approver as the one who acted, and a created role also keeps who asked for it.

## Answer access requests

When someone hits something their role cannot do, they can ask for it. Requests appear under **Access requests** in **Settings › Roles & access**. Approving gives that person the permission. Their role stays as it is.

## Narrow what a role sees inside an app

The **Data access** section narrows which records a role sees inside an app. Without a rule, a role sees every record its permissions allow. Admins see everything. See [Control data visibility with dimensions](dimensions.md).

For how agent permissions relate to yours, see [Agent permissions](../agents/permissions.md). For every scope, see the [scope reference](../reference/scopes.md).
