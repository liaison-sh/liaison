---
title: Use Liaison over MCP
description: "Connect Claude Code, Claude Desktop or another MCP client to Liaison's MCP server, and see how Liaison itself uses outside MCP servers."
---

Liaison speaks the [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) in both directions:

- **Liaison is an MCP server.** An AI client such as Claude Code or Claude Desktop connects to it and uses Liaison's tools, with your permissions and your approvals.
- **Liaison is an MCP client.** Its own agents use the tools of outside MCP servers you connect. That side is covered in [Connect MCP servers](../agents/mcp-servers.md) and summarized at the end of this page.

## The MCP server at a glance

| | |
| --- | --- |
| Endpoint | `<your Liaison address>/mcp`, for example `https://liaison.resonantaudiolabs.example/mcp` |
| Transport | Streamable HTTP, stateless, one `POST` per request |
| Authentication | OAuth 2.0: dynamic client registration, authorization code with PKCE (`S256`), refresh tokens, and the device code grant |
| Access token | A bearer token that lives 15 minutes and works only on `/mcp` |
| Discovery | `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server` and `/.well-known/mcp` |

On a server where each org has its own address (`LIAISON_ORG_HOST_TEMPLATE`, see [Liaison team](../self-hosting/liaison-team.md#each-org-on-its-own-address)), the endpoint and the discovery documents are on the org's address, and a token works there only.

An API key does not work on `/mcp`, and an MCP token does not work on the `/api` routes. See [Use the HTTP API](rest-api.md).

## Connect Claude Code or Claude Desktop

1. In Liaison, open **Settings › Connected tools**. Under **Clients connected to Liaison**, the **Connect** block shows two snippets with your address filled in. Click **Copy** on the one you need.
2. For **Claude Code**, run the command:

   ```
   claude mcp add --transport http liaison https://liaison.resonantaudiolabs.example/mcp
   ```

   For **Claude Desktop config**, add this to the client's configuration file:

   ```json
   {
     "mcpServers": {
       "liaison": {
         "type": "http",
         "url": "https://liaison.resonantaudiolabs.example/mcp"
       }
     }
   }
   ```

3. The client opens a Liaison page in your browser: **Connect <client>**. Make sure you are signed in to Liaison in that browser.
4. Read the page. The name was chosen by the application itself and is not checked, so it also shows the address you will be sent back to. Approve only a connection you started.
5. Tick **I understand this application will be able to act as me, with everything I can access, until I revoke it in Settings.**
6. Confirm it's you: the page emails you a 6-digit code as soon as it opens. Type the code from the email. No code arrived? Check your spam folder, or click **send a new one** (possible again 60 seconds after the last email). The page never asks for your password.
7. Click **Approve**.

A client that connects as one of your agents (it names the agent when it opens the page) gets only what that agent may do: the page then asks for neither the tick nor the confirmation. A client you already approved reconnects without the page.

The client is now listed under **Connections** in **Settings › Connected tools**, with when it was added and last used.

Any other MCP client that supports Streamable HTTP and OAuth works the same way: give it the `/mcp` address.

## What a connected client can do

- **Use Liaison's tools.** The tool list is the Liaison catalog for your scopes, with names such as `mail__reply`, `tickets__search` or `kernel__skill_read`. A tool whose scope you lack is absent from the list, and records outside your grants come back empty. Another organization's custom app (managed instances) never appears, and a call to it is refused as an unknown tool.
- **Find tools.** Two extra tools help with the large catalog: `liaison_tool_search` finds a tool by task keywords, and `liaison_call_tool` runs a tool by name, including one granted after the session started. Called without arguments, it returns the tool's schema.
- **Follow your org's skills.** The connection's instructions list the skills you can see, so the client reads them before it drafts customer-facing text.
- **Reach your org's agents** by name, when the connection is allowed to ask them. The connection's instructions list each agent with what it is for, so a request in an agent's area goes to that agent.
- **Work by the same rules as Liaison's own agents.** The connection's instructions carry the shared core of the in-app agent's guidance, such as messaging a teammate in a Liaison conversation rather than by email, saying plainly when your permissions do not allow a request (and offering to ask an admin for the access), and reusing an existing conversation, skill or routine before creating a new one. The first call to an app's tool brings back that app's working guide.

Everything goes through the same approvals as in Liaison. A gated tool, such as a reply or a send, creates a pending approval and does nothing until a person approves it. See [Approve what agents do](../agents/approvals.md).

What a client reads through Liaison counts for what it then writes, as for an agent in Liaison, whether or not the connection names an agent. A connection that names none keeps its own record of what it read, for 15 minutes after its last read: a second connection of yours does not share it. A message it posts to one person is posted and shown to them. In a group where some people cannot see what it read, the message waits for your approval once for that conversation. See [Tools agents use](../agents/tools.md).

A mail tool that reads your own transparent mailbox gets the messages at once. A private mailbox is read only through your open, unlocked Liaison window, which answers on its own: you are not asked each time. Turning off **Let the assistant read this mailbox** in the mailbox security settings stops these reads too. See [Mail](../apps/mail.md#choose-how-your-mailbox-is-encrypted). With several windows open, a locked window's refusal waits a few seconds for an unlocked one to answer, so the read goes to the window that can serve it. The content your window sends back for such a read is added by Liaison itself: tool schemas leave out those `__mailbox` parameters, and Liaison drops them from any call that sets them.

Tools from outside MCP servers connected to Liaison are offered to the client too, unless the server's **Expose via outbound MCP gateway** switch is off.

## Revoke a client

1. Open **Settings › Connected tools**.
2. Under **Connections**, click **Revoke** next to the client and confirm.

The client loses access at its next call. A token is checked against the connection and your current permissions on every call, so a removed scope or a deactivated account takes effect at once.

Changing or resetting your password ends every connected client as well as every sign-in: each one must connect again.

On a managed instance whose subscription is suspended or closed, every call answers `403` `org_suspended` and no new token is issued. Clients work again once the subscription is paid.

While the organization is being moved to another server, calls that change something answer `503` `org_moving` with `Retry-After: 2` for a few seconds (reads still answer). Retry after the delay.

## Connect a headless client with a device code

A client without a browser callback, such as a command-line tool, can use the device code grant: it starts the grant at `/mcp/device/initiate`, shows you an address with a code, and you approve it in a browser where you are signed in.

When the grant names none of your agents, it gets everything you can do. The approval page then asks you to tick **I understand it will have full access to my account.** and emails you a 6-digit code by itself: type it before **Approve** works. **send a new one** sends another code, 60 seconds after the last one at the earliest.

The device grant is off until the instance lists the allowed client ids in `DEVICE_FLOW_CLIENTS` (empty by default). Once it is on, the Liaison desktop app (`liaison-desktop`) is always admitted too. See the [environment reference](../reference/env.md).

The Liaison desktop app connects its local sessions as one of your agents without this step, from the session it is already signed in with. See [Install the desktop and phone apps](../getting-started/desktop-and-phone.md).

## Use outside MCP servers from Liaison

Liaison's agents also consume MCP servers, through the **MCP Manager** app:

- You connect a server for yourself under **Settings › Connected tools**, or for the whole organization under **Settings › Connectors**.
- Liaison reaches servers over `http` or `sse` at an `https` address on a public host. It never runs a server as a local command (`stdio`).
- Sign-in is OAuth (Liaison registers itself, or uses an app you created), an access token, or none.
- Each tool is set to **Allowed**, **Needs approval** or **Off**. A new server starts at **Changes need approval**.
- Agents see each tool as `mcp__<handle>_<tool>`, for example `mcp__crm_get_user`.
- An operator can also declare servers at boot with `LIAISON_MCP_<NAME>_*` variables.

[Connect MCP servers](../agents/mcp-servers.md) has every step, setting and variable.

## Related pages

- [Tools agents can use](../agents/tools.md)
- [Control what agents can access](../agents/permissions.md)
- [Use the HTTP API](rest-api.md)
