// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S13 — "an audit search filtered by agent id returns the in-sandbox and
// MCP-originated rows for the same request identically". An MCP tool call is
// executed through the same seam as every other agent tool call, inside the
// turn's ALS frame (tool-bridge wraps each execution in
// `runContextStore.run(runFrame, ...)`), so the acting agent is available where
// the MCP audit event is emitted and rides the envelope exactly as T32's events
// do. Without it the MCP half of the trail is anonymous and a search by agent
// id returns one half of the same request.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { sql } from "~/db"
import { DurableConsumersTestAccess } from "~/infra/events/durable-consumers"
import { flushEventHandlers, initEventBus, resetEventBus } from "~/infra/events/event-bus"
import { registerEventSubscribers } from "~/infra/events/event-subscribers"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import type { AuditEvent } from "./call"
import { emitAuditEvent } from "./index"

function frameWith(agentId?: string) {
  const runId = crypto.randomUUID()
  return {
    runId,
    parentRunId: null,
    rootRunId: runId,
    nestingDepth: 0,
    ...(agentId ? { agentId } : {}),
  }
}

describe("MCP tool-call audit rows carry the acting agent", () => {
  const ORG_ID = crypto.randomUUID()
  const USER_ID = crypto.randomUUID()
  const AGENT_ID = crypto.randomUUID()
  const tag = ORG_ID.slice(0, 8)

  function mcpCallEvent(connectionId: string): AuditEvent {
    return {
      app: "mcp",
      entity: "call",
      action: "execute",
      orgId: ORG_ID,
      actorId: USER_ID,
      actorType: "user",
      data: {
        connection_id: connectionId,
        slug: `acme-${tag}`,
        tool_name: "acme__get_order",
        decision: "auto",
        policy_path: "connection_default",
        outcome: "ok",
        latency_ms: 12,
        request_bytes: 34,
      },
    }
  }

  async function auditRowFor(
    connectionId: string,
  ): Promise<{ app: string | null; agent_id: string | null } | undefined> {
    const rows = await sql<{ app: string | null; agent_id: string | null }[]>`
      SELECT app, agent_id FROM kernel.audit_log
       WHERE org_id = ${ORG_ID} AND entity_id = ${connectionId}`
    return rows[0]
  }

  beforeAll(async () => {
    resetEventBus()
    initEventBus()
    DurableConsumersTestAccess.reset()
    // The MCP audit event bypasses the outbox, so the bypass fallback consumer
    // is the one that persists it. WS fan-out stubbed (no manager here).
    registerEventSubscribers({
      bufferAndBroadcast: async () => {},
      broadcast: async () => {},
    } as never)

    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG_ID}, 'McpAuditOrg', ${`mcp-audit-${tag}`})`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${USER_ID}, ${ORG_ID}, ${`mcp-audit-${tag}@test.com`}, 'Caller', 'x')`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id)
      VALUES (${AGENT_ID}, ${ORG_ID}, 'personal', ${`@mcp-audit-${tag}`}, 'Liaison', ${USER_ID})`
  })

  afterAll(async () => {
    resetEventBus()
    await sql`DELETE FROM kernel.audit_log WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
  })

  it("an MCP tool call made inside an agent turn audits with that agent", async () => {
    const connectionId = crypto.randomUUID()
    await runContextStore.run(frameWith(AGENT_ID), () => emitAuditEvent(mcpCallEvent(connectionId)))
    await flushEventHandlers()

    const row = await auditRowFor(connectionId)
    expect(row).toBeDefined()
    expect(row?.app).toBe("mcp")
    expect(row?.agent_id).toBe(AGENT_ID)
  })

  it("an MCP call outside any agent turn records no agent, and still records the call", async () => {
    const connectionId = crypto.randomUUID()
    await emitAuditEvent(mcpCallEvent(connectionId))
    await flushEventHandlers()

    const row = await auditRowFor(connectionId)
    // Identity fails closed, the write does not: no frame means no agent acted,
    // which is the true answer for a boot-time or gateway call.
    expect(row).toBeDefined()
    expect(row?.agent_id).toBeNull()
  })
})
