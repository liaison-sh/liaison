# mcp-manager — inbound MCP aggregator

Administers **external MCP server** connections and their aggregated tools:
connect an http/sse MCP server (e.g. an ERP/inventory server given a URL + API
key), list existing connections, gate their tools by policy, and audit them. The
flow is **connect → test → policy → discover**: a server's tools become
discoverable to agents (via `tool_search`) only after the connection is dialled,
tested, and an access policy permits them.

## Tools

- `add_connection` — add an external http/sse MCP server (`displayName` +
  `httpUrl`; `authFlavor: "bearer"` + `bearerToken` for an API key). **Gated** —
  creates an approval request; the connection is not live until a human approves,
  and its tools only surface after test + policy.
- `list_connections` — list the org's MCP server connections (read-only).

(MCP servers are remote, reached over http or sse; Liaison does not run an MCP
server as a local command. OAuth flows are configured in the MCP Manager wizard,
not via these tools.)

## Connecting

mcp-manager's connections are the **external MCP servers it aggregates**, stored in its own
tables, not in the kernel connections subsystem. Admins add organization servers on Settings ›
Connectors › MCP servers; every member adds personal ones on Settings › Connected tools. Auth
(none, bearer or custom headers, OAuth with automatic or pre-registered clients), the callback
URL and per-vendor setup (Notion, HubSpot) are in
[`docs/mcp-servers.md`](../../../../../docs/mcp-servers.md). Secrets are stored AES-encrypted by
this app.
