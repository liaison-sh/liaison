# Connecting external MCP servers

Liaison's agent can use tools from any remote MCP server (Notion, HubSpot, Linear, your own).
The `mcp-manager` app holds these connections. This page is for whoever deploys Liaison and
connects servers for a workspace.

## Where

- **Organization servers**, shared with the workspace: **Settings › Connectors › MCP servers ›
  Add MCP server**. Workspace admins only. **Who can use it** on the server's page decides who
  uses its tools: **Everyone in the workspace** (the default) or **Only selected roles and
  people**. Admins always can.
- **Personal servers**, visible to their owner only: **Settings › Connected tools › Your MCP
  servers**. Every member can add their own.

Enter the server URL (streamable HTTP). Liaison probes it and picks one of three ways to
authenticate:

| What the probe finds | What you do |
|---|---|
| No auth required | Nothing: the server connects at once. |
| OAuth, and the server registers clients automatically (Client ID Metadata Document, or Dynamic Client Registration) | Click **Sign in with <server>** and consent once in the browser. |
| OAuth with pre-registered clients only | Create an OAuth client at the vendor (below), paste its client ID and secret, then sign in. |
| A static token or API key | Paste it as a bearer token, or as a custom header (name + value; values are encrypted at rest). |

Once the server answers, Liaison opens a review of its tools that you finish before the server
counts as added: pick **Allow reads, approve changes** (recommended), **Every call needs
approval** or **Allow everything**, adjust single tools if you like, then click **Done**.
Closing the review keeps the server's current default. An organization server whose tools nobody
has reviewed reopens the review when an admin opens it.

Tokens are refreshed before they expire and after a 401. The access token never reaches the
agent or the browser.

## The callback URL

Every OAuth flow returns to:

```
<BASE_URL>/api/apps/mcp-manager/oauth/callback
```

`BASE_URL` is your deployment's public URL, for example `https://liaison.example.com`. When a
vendor asks for a redirect URL, give exactly this one.

On a server where each organization has its own address (`LIAISON_ORG_HOST_TEMPLATE`), the
callback is on the organization's own address instead, for example
`https://acme.example.com/api/apps/mcp-manager/oauth/callback`; the central redirect host of
`LIAISON_OAUTH_REDIRECT_BASE` is not used for MCP servers.

Automatic registration by Client ID Metadata Document needs a public `https` `BASE_URL`: the
vendor fetches the document from it. On a local or private deployment (`http://localhost:3000`),
Liaison falls back to Dynamic Client Registration when the vendor offers it.

## Notion

URL: `https://mcp.notion.com/mcp`. No setup at Notion: Notion registers Liaison automatically.
Click **Sign in with Notion**, then on Notion's consent screen choose the pages and databases
the agent may read. The agent sees only what you share there. To add more later, reconnect,
or share more pages with the connection from Notion.

## HubSpot

URL: `https://mcp.hubspot.com`. HubSpot accepts only pre-registered clients, so create one first:

1. In HubSpot, open **Development › MCP Connectors** and create a connector.
2. Under **Redirect URLs**, click **Add redirect URL** and enter your callback URL (above).
3. Copy the connector's **Client ID** and **Client secret**. HubSpot also shows an **App ID**;
   Liaison does not need it.
4. In Liaison, Add MCP server with URL `https://mcp.hubspot.com`. When asked, paste the client ID and
   secret, then **Sign in with HubSpot** and consent.

The tools the agent receives, and what they can read or write, follow the scopes of the HubSpot
user who signs in.

To read and write HubSpot records through a declared adapter, rather than through HubSpot's MCP
tools, use the API connector with a HubSpot service key
([`api-connector.md`](api-connector.md#hubspot)).

## How the agent sees the tools

Each server's tools are listed in the agent's tool catalogue and load on demand: the agent finds
them through `tool_search`, so a server with many tools costs nothing until it is used.

What runs without approval follows the server's default policy. Under the default, **Changes
need approval**, a tool the server marks read-only (and not destructive) runs at once, and every
other tool waits for a person, including a tool the server does not describe. **Every call needs
approval** parks every call, **Allowed without approval** runs every call, and a per-tool or
role decision on the server's page always wins. The read-only label is the server's own claim: a
server you do not trust could label a write as a read, and a read still sends its arguments to
the server. For such a server choose **Every call needs approval**.

## Disconnecting

Disconnect from the server's page. Liaison deletes the connection with its stored tokens and
client secret, and the server's tools leave the agent. Revoke the grant at the vendor too, if the
vendor lists it (Notion: Settings › Connections; HubSpot: Connected apps).
