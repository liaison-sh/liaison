// SPDX-License-Identifier: FSL-1.1-ALv2
import { NODE_TURN_CREDENTIAL_HEADER } from "@liaison/shared"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import {
  loadOwnerAttachedSkills,
  renderOwnerSkillsBlock,
  selectOwnerSkills,
} from "~/modules/agent/skills/owner-skills"
import { resolveAllSkills } from "~/modules/agent/tools/skills-routines-tools"
import { loadMcpAgentDirectory } from "~/modules/mcp/agent-directory"
import { registerActiveServer, unregisterActiveServer } from "~/modules/mcp/catalog-notifier"
import { loadDiscoveredTools, loadSurfacedSkills } from "~/modules/mcp/connection-service"
import { noteConnectionRequest } from "~/modules/mcp/connection-thread"
import { createMcpServer } from "~/modules/mcp/server-factory"
import { hasScope } from "~/modules/permissions/permissions"

const log = rootLogger.child({ module: "mcp-transport" })

// Streamable-HTTP MCP endpoint. mcpAuthMiddleware (auth) + orgRateLimiter
// (rate-limit) are applied BEFORE this route in app.ts (Task 12); for tests
// the same chain is mounted on a throwaway Hono.
//
// Stateless per request: no sessionIdGenerator → the SDK's web transport runs
// in stateless mode, which matches our "no per-connection session affinity"
// model. The SDK owns JSON-RPC framing + the initialize handshake; this
// handler just bridges Hono ⇄ the SDK's Web Request/Response transport.
export const mcpTransport = new Hono<AppEnv>()

mcpTransport.post("/", async (c) => {
  // Defense-in-depth: `app.use("/mcp", mcpAuthMiddleware)` matches the exact
  // path only. If a request ever reaches the transport without having passed
  // mcpAuthMiddleware (trailing-slash `/mcp/`, a future `/mcp/<sub>` route, or
  // a mount-order regression), the auth context is absent — refuse rather than
  // run tools with an empty/unauthenticated context.
  const connectionId = c.get("mcpConnectionId") ?? ""
  const orgId = c.get("orgId")
  const ownerId = c.get("userId")
  if (!connectionId || !orgId || !ownerId) {
    return c.json({ error: "invalid_token" }, 401, {
      "WWW-Authenticate": `Bearer resource_metadata="${env.BASE_URL}/.well-known/oauth-protected-resource"`,
    })
  }
  // The connection thread's untrusted-content mark: a handshake clears it only after the
  // connection was quiet long enough for its conversation to have ended (noteConnectionRequest).
  // The body is read ONCE here and handed to the SDK as `parsedBody`. Peeking on a clone and
  // letting the SDK read the original afterwards failed under Bun: by the time the SDK read
  // the original (after this handler's database round trips) it came back empty, and every
  // request was answered "Parse error: Invalid JSON" (Playwright mcp-smoke). A body that is
  // not JSON is left to the SDK on a fresh Request, so its own error stays the answer.
  const rawBody = await c.req.raw.text()
  let peeked: unknown = null
  try {
    peeked = JSON.parse(rawBody)
  } catch {
    peeked = null
  }
  // One HTTP request is one MCP request: the per-user and per-org limiters in
  // front of this route count HTTP requests, so a JSON-RPC batch would buy a
  // batch's worth of tool work per token. Protocol revision 2025-06-18 removed
  // batching; refuse it before any work is done.
  if (Array.isArray(peeked)) {
    return c.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid Request: JSON-RPC batching is not supported" },
      },
      400,
    )
  }
  // Fail closed: if the activity record cannot be read or written, the mark stays as it is.
  await noteConnectionRequest(connectionId, orgId, peeked).catch((err) =>
    log.error({ err, orgId, connectionId }, "MCP request: connection activity note failed"),
  )
  const transport = new WebStandardStreamableHTTPServerTransport({
    // stateless
    sessionIdGenerator: undefined,
  })
  // Rehydrate the connection's discovered deferred-tool set so a fresh
  // stateless reconnect's tools/list still includes them (spec C4 /
  // criterion 3). liaison_tool_search persists into this same set.
  const scopes = c.get("scopes")
  const agentId = c.get("mcpAgentId")
  const [discoveredNames, surfacedNames, skills, agentDirectory] = await Promise.all([
    connectionId ? loadDiscoveredTools(connectionId) : Promise.resolve([] as string[]),
    connectionId ? loadSurfacedSkills(connectionId) : Promise.resolve([] as string[]),
    // Resolved ONCE per request and reused by BOTH discoverability channels:
    // the catalog rendered into `initialize` instructions, and the app-anchored
    // body pushed onto a tool result. Loading it here (rather than per tool
    // call) keeps the steady-state call path free of extra queries.
    resolveAllSkills(orgId, ownerId, scopes as unknown as string[]).catch((err) => {
      // Discoverability is an enhancement — never fail an MCP request over it.
      // A client that loses the catalog still has skill_search/list_skills.
      log.warn({ err, orgId, connectionId }, "MCP skill catalog unavailable for this request")
      return []
    }),
    // The named agents, only for a connection that can call agents_ask: a
    // client told of agents it cannot reach would promise what it cannot do.
    hasScope("kernel:threads:write", scopes as unknown as string[])
      ? loadMcpAgentDirectory(orgId, ownerId, agentId).catch((err) => {
          log.warn({ err, orgId, connectionId }, "MCP agent directory unavailable for this request")
          return []
        })
      : Promise.resolve([]),
  ])
  const discovered = new Set(discoveredNames)
  // The bound agent's OWN playbooks (`auto_attach.owner`), in full: an MCP client has no
  // per-turn system prompt, so the connect instructions are where an agent's "how I work"
  // must ride. Visible to the connection's scopes only, as the catalog is.
  const ownerSkillsBlock = agentId
    ? await loadOwnerAttachedSkills(orgId, agentId, {
        userId: ownerId,
        grants: scopes as unknown as string[],
      })
        .then((rows) => renderOwnerSkillsBlock(selectOwnerSkills(rows)))
        .catch((err) => {
          log.warn({ err, orgId, connectionId }, "MCP owner skills unavailable for this request")
          return ""
        })
    : ""
  const server = createMcpServer({
    userId: ownerId,
    orgId,
    scopes,
    dimensionGrants: c.get("dimensionGrants"),
    connectionId,
    agentId,
    discovered,
    skills,
    ownerSkillsBlock,
    agentDirectory,
    surfacedSkills: new Set(surfacedNames),
    // The desktop local turn's credential (S59). Read raw and judged per call
    // in tool-call.ts; never logged.
    turnCredential: c.req.header(NODE_TURN_CREDENTIAL_HEADER) ?? null,
  })
  await server.connect(transport)

  // Register for catalog-change notifications for the duration of this
  // request/stream. Stateless model: registration is request-scoped.
  if (connectionId) {
    registerActiveServer({
      connectionId,
      orgId,
      ownerId,
      sendListChanged: () => server.sendToolListChanged(),
    })
  }
  try {
    // Stateless (no sessionIdGenerator): the transport is request-scoped and
    // the SDK manages its lifecycle for the response stream — do not close it
    // here (closing before the SSE body is consumed truncates the response).
    const request = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers: c.req.raw.headers,
      body: rawBody,
    })
    return await transport.handleRequest(
      request,
      peeked !== null ? { parsedBody: peeked } : undefined,
    )
  } finally {
    if (connectionId) unregisterActiveServer(connectionId)
  }
})
