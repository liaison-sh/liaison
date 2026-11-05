// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What a pending device-flow request asks for, as the approver must see it.
//
// Two flows share `kernel.device_flow_requests`: the login device flow
// (`/api/auth/device-flow`, mints a session) and the MCP device grant
// (`/mcp/device`, mints an MCP connection, rows carry an `mcp:` client-id
// prefix). Both are approved through the same authenticated routes, so the one
// question "what does approving this hand over?" is answered here, once, for
// the lookup the approval page shows and for the approve route that enforces it.
import { and, eq, isNull } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { agents } from "~/db/schema/kernel"
import { redis } from "~/lib/redis"
import { isMentionableAgent } from "~/modules/agent/directory/listing"

/** The stored client id of an MCP device grant carries this prefix. */
export const MCP_DEVICE_CLIENT_PREFIX = "mcp:"

/**
 * Where a pending MCP device grant's requested agent binding waits between
 * initiate and approval, keyed by the device code (the initiating client's own
 * secret) and expiring with the grant.
 */
export function agentBindingKey(deviceCode: string): string {
  return `mcp:device:agent:${deviceCode}`
}

const DEVICE_LABEL_MAX = 80
/** Client-declared device/platform label: single line, no control characters, bounded. */
export function normalizeDeviceLabel(raw: string | undefined): string | null {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
  const cleaned = (raw ?? "").replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim()
  return cleaned ? cleaned.slice(0, DEVICE_LABEL_MAX) : null
}

export interface DeviceRequestAccess {
  kind: "session" | "mcp"
  /** The client id as registered, without the internal `mcp:` prefix. Self-declared. */
  clientId: string
  scopes: string[]
  /** MCP grant bound to an agent of the approver's org: the connection is capped to it. */
  agent: { id: string; name: string } | null
  /** The MCP grant names an agent the approver's org does not have: it can never complete. */
  agentInvalid: boolean
  /**
   * Approving hands over everything the approver can do: a login session that
   * declared no scopes, or an MCP connection bound to no agent.
   */
  fullAccess: boolean
}

/**
 * Describe a pending request for an approver (`userId`) in `orgId`. The agent
 * binding of an MCP grant is read from the parked key and resolved in the
 * APPROVER's org, among the agents the approver could address, exactly as the
 * poll route will resolve it when it mints the connection.
 */
export async function describeDeviceRequest(
  row: { clientId: string; scopes: string | null; deviceCode: string },
  orgId: string,
  userId: string,
): Promise<DeviceRequestAccess> {
  const scopes = row.scopes ? row.scopes.split(" ").filter(Boolean) : []
  if (!row.clientId.startsWith(MCP_DEVICE_CLIENT_PREFIX)) {
    return {
      kind: "session",
      clientId: row.clientId,
      scopes,
      agent: null,
      agentInvalid: false,
      fullAccess: scopes.length === 0,
    }
  }
  const clientId = row.clientId.slice(MCP_DEVICE_CLIENT_PREFIX.length)
  const agentId = await redis.get(agentBindingKey(row.deviceCode))
  if (!agentId) {
    return { kind: "mcp", clientId, scopes, agent: null, agentInvalid: false, fullAccess: true }
  }
  const [agent] = await withPrivilegedDb(orgId, "device-flow-agent-binding", (db) =>
    db
      .select({ id: agents.id, name: agents.displayName })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId), isNull(agents.archivedAt)))
      .limit(1),
  )
  const bindable = agent && (await isMentionableAgent(orgId, userId, agent.id)) ? agent : null
  return {
    kind: "mcp",
    clientId,
    scopes,
    agent: bindable,
    agentInvalid: !bindable,
    fullAccess: false,
  }
}
