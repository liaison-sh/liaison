---
title: Connect MCP servers
description: "Give agents the tools of an outside service by connecting its MCP server, then decide which tools run freely, need approval, or stay off."
---

An MCP server is a remote service that offers tools over the Model Context Protocol, for example Linear, Jira or an inventory system. When you connect one, its tools become available to agents, under rules you set per tool. The **MCP Manager** app does this. This page covers connecting a server for yourself or for the whole organization.

Liaison connects to servers over HTTPS. It does not run an MCP server as a local command. To use Liaison itself from Claude, Cursor or another AI client, see [Use Liaison over MCP](../developers/mcp.md).

## Two kinds of connection

| Kind | Who can use its tools | Where you manage it | Scope you need |
| --- | --- | --- | --- |
| Your own | Only you, your agent and your routines | **Settings › Connected tools**, under **Your MCP servers** | `mcp_manager:personal_connection:write`, which every member has |
| Organization | Everyone in the organization, or only the roles and people an admin picks (see [Choose who can use an organization server](#choose-who-can-use-an-organization-server)) | **Settings › Connectors**, under **MCP servers** | `mcp_manager:connection:write` |

Reading connections needs `mcp_manager:connection:read`. Changing tool policies needs `mcp_manager:policy:write`.

## Connect a server

1. Open **Settings › Connected tools** for your own server, or **Settings › Connectors** and click **Add MCP server** for a shared one. In **Your MCP servers**, click **Add a connection**. If the list is empty, click **Add your first MCP server**.
2. **Address.** Enter the **Server address**: the MCP endpoint the service gives you. It must be an `https://` address on a public host. Plain `http`, `localhost`, loopback and private network addresses are refused. Click **Continue**. Liaison probes the server and works out how it signs in.
3. **Sign in.** What you see depends on what the probe found:
   - **This server requires sign-in. Liaison registers itself automatically.** Click **Sign in with** the service's name. A new tab opens on the service. Approve access, return to Liaison, and click **I've signed in**.
   - **This server needs an app you create first.** Create an app in the provider's developer settings, add the **Redirect URL to add in the provider's app** shown on the page, then paste the **Client ID** and the **Client secret** (if the app has one), and sign in.
   - **No sign-in page found. This server takes an access token.** Paste the **Access token**.
   - **No sign-in needed.** Add any headers the server expects.
   
   For a token or an open server you can add **Extra headers (optional)**. They are sent with every request, stored encrypted and never shown again.
4. **Tools.** Liaison connects and opens **Review the tools of** the server's name, a window you finish before the server counts as added. It shows how many tools it found and three choices for the whole server:
   - **Allow reads, approve changes** (recommended, already selected): tools the server marks read-only run at once, anything that changes data waits for approval.
   - **Every call needs approval**: choose this for a server you don't fully trust.
   - **Allow everything**: agents can change and delete data on this server without anyone approving it.

   For an organization server, an admin also sees **Who can use it**, with **Everyone in the workspace** already selected. Pick **Only selected roles and people** to narrow it now, or change it later on the server's page.

   Below, each tool carries a **Read** or **Write** badge from the server's own description of it, and shows what agents may do with it under the choice above, for example **Allowed · default** for a read and **Needs approval · default** for a write. Change the choice above and every tool follows at once. To make an exception, set a tool to **Allowed**, **Needs approval** or **Off**: it then reads **set for this tool**. Click **Done** to save. Closing the window keeps the current default instead.

   When an OAuth sign-in finishes, the sign-in tab shows the server's name and **You can close this window and return to Liaison.** If it fails, it reads **Sign-in did not complete** with the reason.

A connection that never worked is deleted again, so a failed add leaves nothing behind. A connection whose sign-in finished stays, even if the first test fails, and the list shows why it is not working.

An agent can start the same thing with the `add_connection` tool of the MCP Manager app. That call is gated: it creates an approval request, and the connection is not live until a person approves. A personal connection goes only to the requester. An organization connection goes to the administrators, and expires after 24 hours if nobody decides. Even after approval, the tools only become discoverable once the connection is tested and a policy allows them. The agent tool supports `http` and `sse` transports with no sign-in or a bearer token. OAuth sign-in happens in the wizard above. An agent lists the organization's connections with `list_connections`, which needs `mcp_manager:connection:read`.

## Choose who can use an organization server

Open the server from **Settings › Connectors** and find **Who can use it**. You need `mcp_manager:connection:admin`, which organization admins have.

- **Everyone in the workspace**: every active member's agent can use the server's tools. New organization servers start here, and servers added before this setting existed were set to it. A member's own agent finds the tools as soon as the server is added.
- **Only selected roles and people**: pick roles, add people by name, and click **Save access**. Everyone else does not see the server's tools in `tool_search`, and their calls are refused.

Admins can always use every server. A role created later, or a person who joins later, is covered by the choice at once: Liaison works it out each time it checks a person's permissions, without writing grants into roles. The change applies to open sessions right away.

**Fine-tune in Roles & access** opens **Roles & access** filtered to the server: it lists only the roles that hold a permission for it. There you can grant a role a single tool (the permission `mcp:<handle>:<tool>`) or the whole server (`mcp:<handle>`). Roles pages show these permissions with the server's name, and a role's page lists its **MCP servers** with a link back to each server.

Your own servers have no such setting: only you, your agent and your routines use them.

## Decide what agents may do with each tool

Open the server and look at **Tools & policy**: **Set what agents may do with each tool.**

| Decision | Meaning |
| --- | --- |
| **Allowed** | The tool runs without approval. |
| **Needs approval** | A person must approve each call. |
| **Off** | Agents cannot use it. |

Each tool shows the decision that applies to it. A tool with no decision of its own follows the server's default and is marked **default**, for example **Allowed · default**. A tool you set yourself is marked **set for this tool**, and **Reset to default** next to it returns it to the default. Choosing the decision a tool already gets from the default changes nothing. A tool whose input description Liaison cannot read, for example one that points to a schema on another site, shows as **Unavailable** with the reason: agents never see it, so it is never called. Set **Connection default policy** for the server:

| Default | Meaning |
| --- | --- |
| **Allowed without approval** (`auto`) | Every tool runs. |
| **Changes need approval** (`gate_writes`) | A tool the server marks read-only (and not destructive) runs without approval. Every other tool needs approval, including a tool the server describes not at all. New servers start here. |
| **Every call needs approval** (`gate_all`) | Every call waits. |

Liaison keeps each server's tool list, with these labels, from the last time it reached the server. After Liaison restarts, agents find the tools and the labels still apply before Liaison reaches the server again. A server that has no kept list yet is reached once, one server at a time, the first time its workspace searches for tools or opens the server's tools after a restart. The read and write labels come from the server itself. A server you do not trust could label a tool that changes data as read-only, and even a read sends its arguments to the server. For such a server choose **Every call needs approval**. A per-tool decision or a role override always wins over the default.

An allowed tool can still wait for a person when the conversation has read workspace data that not everyone may see, because its arguments could carry that data out, or after outside content (see [Hold actions after outside content](../agents/approvals.md#hold-actions-after-outside-content)). Data and text the conversation read from this same server do not count: a read-only tool of the server runs after the server's own search, because sending its data back to it shares nothing new. A tool that changes data still waits.

A call that waits shows an approval card titled with the server's name and the action, for example **CRM · Manage CRM objects**. It lists what the call sends: the text it would write in full (up to 500 characters each), then the ids and values it targets. **Exact payload** keeps the raw arguments.

An organization server whose tools nobody has reviewed yet opens the same review window when an administrator opens it. To change every tool at once, change the default: it is one setting, not a decision per tool. When some tools have decisions of their own, **Reset all to default** above the tool list removes them all.

Under **Role overrides** you can give a role a different decision for the whole server. **Role overrides** apply on top of per-tool overrides, and the most permissive decision wins among the roles a person holds. Use **+ Add role override**.

Two more switches sit in the same panel: **Discoverable by agent** (agents can find the tools with `tool_search`; turn it off to hide the server) and **Expose via outbound MCP gateway** (the tools are also offered to external clients connected to Liaison).

Approvals raised by these tools work like any other gated action. See [Approve what agents do](../agents/approvals.md).

## Name the tools agents see

Every tool of a server is projected into Liaison under the server's handle (its slug, lowercase letters, digits and hyphens, up to 32 characters). The tool `get-user` on a server with the handle `crm` is called `mcp__crm_get_user` for agents, and has the scope string `mcp:crm:get_user`, shown in the interface as `crm:get_user`. If two server tool names reduce to the same name, a short suffix keeps them apart. A server can expose at most 200 tools per connection.

## Keep a server healthy

On the list, each server shows a status chip.

| Chip | Meaning |
| --- | --- |
| **Connected** | Working. |
| **Connecting** | Being reached. |
| **Not working** | The last attempt failed. A banner reads **At least one MCP connection is in a failed state.** |
| **Not checked yet** | Added but not tested. |
| **Off** | Turned off. Agents do not see its tools. |
| **Not signed in**, **Sign in again** | Someone must sign in. Agents cannot use its tools until then. |
| **Can't read saved credentials** | This server cannot decrypt the saved credentials. Restore its encryption key, or remove and add the server again. |

For your own servers, **Test** checks the connection and reports how many tools it found, **Edit** changes it, **Disable** and **Enable** switch it off and on, and **Delete** then **Delete for good** removes it. Deleting a server takes its tools away from every agent at once. For an organization server, open it to change **Display name**, address, **Rate cap (per minute)** and credentials (**Replace the access token**, or **Leave empty to keep the current token**). Changing the address to another site clears the saved sign-in, access token and extra headers, so the server asks you to sign in again (or to enter a new token); a new path on the same site keeps them. A sign-in started before the address changed is refused when it returns.

Under **Activity** you can read recent calls, newest first, filtered by **All**, **OK**, **Denied**, **Gated** or **Error**. The audit scope is `mcp_manager:audit:read`. On the managed edition a **Usage** section adds **Calls (24h)**, **Errors (24h)**, **p95 latency** and **Top tools**, under `mcp_manager:usage:read`.

Defaults you can tune on a self-hosted instance:

| Variable | Default | Meaning |
| --- | --- | --- |
| `MCP_RATE_CAP_PER_MINUTE_DEFAULT` | `120` | Calls per minute for a server with no cap of its own. |
| `MCP_MAX_RESPONSE_BYTES` | `4194304` | Largest response accepted from a server (4 MiB). |
| `MCP_MAX_TOOLS_PER_CONNECTION` | `200` | Most tools projected from one server. |

## Define connections in the environment

An operator can declare servers at boot. Each connection is a group of variables with a name in the middle.

```
LIAISON_MCP_INVENTORY_DISPLAY_NAME=Inventory
LIAISON_MCP_INVENTORY_ORG=<organization id>
LIAISON_MCP_INVENTORY_TRANSPORT=http
LIAISON_MCP_INVENTORY_URL=https://mcp.inventory.example/mcp
LIAISON_MCP_INVENTORY_AUTH=bearer
LIAISON_MCP_INVENTORY_BEARER_TOKEN=<token>
```

`DISPLAY_NAME`, `ORG`, `TRANSPORT` (`http` or `sse`), `AUTH` (`none`, `bearer`, `oauth_dcr` or `oauth_static`) and `URL` are required. Optional suffixes are `OWNERSHIP_SCOPE` (`org` or `personal`), `OWNER_USER_ID`, `AGENT_VISIBILITY` (`discoverable` or `hidden`), `EXPOSE_VIA_GATEWAY`, `DEFAULT_POLICY`, `RATE_CAP_PER_MINUTE`, and for OAuth `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`, `OAUTH_AUTHORIZATION_URL`, `OAUTH_TOKEN_URL` and `OAUTH_SCOPES`. A connection created this way shows **from .env**. A local-command (`stdio`) transport is refused at boot. With several Liaison processes, only one of them writes these connections, and it updates a connection that already exists rather than adding a second one. A workspace's servers and tools load in a process the first time that process serves the workspace. See the [environment reference](../reference/env.md).

## Roles in the MCP Manager app

| Role | Scopes |
| --- | --- |
| Viewer | `mcp_manager:connection:read`, `mcp_manager:policy:read`, `mcp_manager:audit:read` |
| Member | Viewer, plus `mcp_manager:personal_connection:write` |
| Editor | Member, plus `mcp_manager:connection:write`, `mcp_manager:policy:write` |
| Admin | Editor, plus `mcp_manager:connection:admin`, `mcp_manager:usage:read` |

Adding a connection through the agent tool `add_connection` is gated. A person who holds `mcp-manager:approve` can approve, edit or deny that request, so the connection is not live until they decide. For a personal connection the request goes to the requesting user alone, for an org connection to the admins. The approval expires after 24 hours.

## Next steps

- [Tools agents can use](../agents/tools.md)
- [Control what agents can access](../agents/permissions.md)
- [Use Liaison over MCP](../developers/mcp.md)
