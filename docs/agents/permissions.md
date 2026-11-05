---
title: Control what agents can access
description: "Understand how an agent's access is bounded by its owner and the room, and ask for or grant extra access."
---

An agent can only do what the people it works for are allowed to do. This page explains the limits, how to see why an agent is blocked, and how a member asks for more access and an administrator decides.

## How access is bounded

Access is expressed as scopes: capability strings in the form `app:resource:action`, such as `tickets:tickets:read`. Granting a shorter scope grants everything under it, and `*` grants everything. People receive scopes through roles and individual grants. See [Roles](../admin/roles.md) and [the scope reference](../reference/scopes.md).

Each agent also has a ceiling: the most it may ever do. On every turn the agent works with the intersection of its ceiling and the people involved. It never gets the union.

| Where the agent is working | What bounds it |
| --- | --- |
| Direct message with you | Its ceiling intersected with your permissions. |
| Channel or group conversation | Its ceiling intersected with the permissions of every person in the room. |
| Routine run | The scopes chosen on the routine, and the owner's permissions. If the owner no longer holds one, the routine pauses. |
| Delegation to another agent | The requester's permissions intersected with the other agent's ceiling, then the room's limit. |
| Sub-agent | What the agent that started it had, intersected with the sub-agent role's ceiling and any narrower scopes requested. |

Because of this, adding a colleague with fewer permissions to a conversation can reduce what an agent can do there. When that happens the agent says **Some capabilities are unavailable here** and the message offers **Continue in a DM**, where only your own permissions count.

### The ceiling by agent kind

| Kind | Its ceiling |
| --- | --- |
| Personal agent | Your own permissions. It follows them when they change. |
| Role agent | Set by an administrator in **Settings** under **Capabilities**. It cannot be wider than what that administrator may grant. See [Create an agent](../agents/create-an-agent.md). |
| System agent (`@base`) | A common base: skills, conversations, memory, contacts, files, knowledge and projects. |

Organization-administration scopes (`kernel:roles:admin`, `kernel:scope_requests:admin`, `kernel:policies:admin`, `kernel:users:admin`) are meant for people. Keep them out of a role agent's ceiling: `liaison config apply` refuses a role agent that lists one, and an approved access request never adds one.

### Data limits

Scopes say what a person can do. Data dimensions say which records they see, for example one territory or one team. Agents see exactly the records the person would see, because the limit is applied by the database and the response filter, not by the agent's judgment. See [Data dimensions](../admin/dimensions.md).

### Apps people cannot use

An administrator can turn an app off for everyone, or restrict it to some people. People without access do not see the app in the sidebar, and their agents cannot use its tools. A scope request for an app that is off or restricted away is refused with a message instead of reaching an administrator's queue.

## Find out what an agent is missing

Ask the agent why it cannot do something. It has two tools for this:

- `list_locked_capabilities` lists the tools in your organization that it has no scope to use, with the exact scope each one needs.
- `tool_search` finds the tools it can load. Only tools inside its access are loaded.

When you try something in the app and are refused, the toast reads **Permission denied. You need the "scope" scope for this.** If the scope can be requested, the toast has a **Request access** button.

## Ask for more access

### From the app

1. Click **Request access** on the **Permission denied** toast.
2. A success toast reads **Access request sent to your admin.** A repeat request for the same scopes is merged into the first one.

### Through your agent

1. Tell the agent what you want to do.
2. When it explains that it lacks a scope, confirm that you want it to ask.
3. The agent calls `request_scope` with the exact scope strings and a reason. It should file the request only after you confirmed.
4. You get a notification when the request is decided. The agent also speaks first in the conversation, to say what it can now do or that it still cannot.

## Decide access requests

Administrators with `kernel:scope_requests:admin` review requests. Each pending request also waits in their **Approvals** list on **Home** (and the phone **Approvals** screen) as an **Access request**: who asks, for which app, what it allows and why. Click **Grant** or **Deny** on the row; **Details** lists every permission asked for. A decision has five seconds to **Undo**.

To review them with the deny reason field:

1. Open **Settings › Roles & access**.
2. In the **Access requests** section, read each request: who asked, which scopes, the reason, and the agent if an agent filed it (**via** the agent's name).
3. Click **Approve**, or click **Deny** and give an optional reason.

What approving does:

- It gives the person the permission. Their role stays as it is.
- If an agent asked and its ceiling lacks the scope, the ceiling is widened too. A personal agent's ceiling follows its owner's grants. Someone else's personal agent is never widened. A role agent never receives an organization-administration scope this way.
- You can only approve what you hold yourself. Otherwise the server refuses with a message that you cannot grant a scope you do not hold, and to ask a full administrator.
- The decision is recorded and announced in the conversation that asked.

An administrator can also use their own agent to read and change access: `describe_user_access`, `list_scopes`, `roles_list`, `get_role`, `users_list`, `list_dimensions` read it; `create_role`, `edit_role`, `delete_role`, `assign_role`, `remove_user_from_role`, `grant_user_scope` and `grant_dimension_value` change it. Every change waits in **Approvals** for a person. These need `kernel:users:admin` or `kernel:roles:admin`.

## Scopes that matter for agents

| Scope | What it allows |
| --- | --- |
| `kernel:agents:admin` | Create and edit role agents and sub-agent roles (`subagent_create`, `subagent_delete`, `subagent_get`), archive agents. |
| `kernel:agents:read` | Read an agent's composed definition: system prompt, skill bodies, tool list. Not part of the default member role. |
| `kernel:agents:spawn` | Start fresh-context sub-agents with `spawn_agent`, and list roles with `subagent_list`. |
| `kernel:agent:web` | Fetch and search the public web (`web_fetch`, `web_search`, `web_watch`, `watch_state`). |
| `kernel:agent:memory` | The gate for memory tools and notifications. |
| `kernel:bug_reports:file` | Report a bug about Liaison under your own name (`report_bug`). Every active member holds it whatever their roles, and an agent acting for them keeps it whatever its ceiling, as anyone may use **Report a bug**. |
| `kernel:agent:memory:read` | Read the current user's agent memory. |
| `kernel:agent:memory:write` | Create, update or delete the current user's agent memory. |
| `kernel:threads:read` | Read conversations, search tools, list locked capabilities. |
| `kernel:threads:write` | Write conversations, ask and invite agents, run work on your computer. |
| `kernel:threads:admin` | Create org-wide pinned conversations. |
| `kernel:files:read` / `kernel:files:analyze` | Read files; analyze images and videos. |
| `kernel:skills:read` / `kernel:skills:write` / `kernel:skills:approve` | Read, write and approve skills. |
| `kernel:routines:read` / `write` / `run` / `delegate` | See [Schedule routines](../agents/routines.md). |
| `kernel:approvals:read` / `kernel:approvals:write` / `kernel:approvals:admin` | Read, decide and administer approvals. |
| `kernel:approve` | Decide kernel-level approvals. |
| `kernel:policies:read` / `kernel:policies:write` / `kernel:policies:admin` | Read, and configure, the approval policies. |
| `kernel:scope_requests:admin` | Review and decide access requests. |

## Next steps

- [Approve what agents do](../agents/approvals.md)
- [Tools agents can use](../agents/tools.md)
- [Roles](../admin/roles.md)
