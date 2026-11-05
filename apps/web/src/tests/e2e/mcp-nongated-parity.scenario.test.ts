// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 12 S1 — Non-gated tool parity: MCP tools/call result == in-app path.
// Proves the MCP projection (#3) and the REST projection (#1) execute the SAME
// `executeTool` core — a divergence here is the "MCP diverged from the
// registry" regression the spec's load-bearing principle forbids.
import { api } from "@liaison/test-helpers"
import { expect, test } from "./fixtures/test"
import { freshAccessToken } from "./helpers/fresh-token"
import { closeMcpClient, establishMcpConnection } from "./helpers/mcp-client"
import { grantTicketsScopes, seedInbox, seedTicket } from "./helpers/seed"
import { indexSeededTickets } from "./helpers/tickets-search"

test("non-gated tools/call matches the in-app run-tool result", async ({ env, qa, world }) => {
  const orgId = world.org.id
  const stamp = Date.now()
  await grantTicketsScopes(env, orgId, qa.admin.id, ["tickets:tickets:read"])
  const inbox = await seedInbox(env, orgId, {
    name: `S1 inbox ${stamp}`,
    emailAddress: `s1-${stamp}@e2e.test`,
    isDefault: true,
  })
  const subject = `S1 parity ticket ${stamp}`
  const ticket = await seedTicket(env, orgId, { subject, sourceInboxId: inbox.id })
  // A free-text tickets search resolves through Meili, and a ticket seeded
  // straight into SQL is indexed by nothing: index it the real way first.
  await indexSeededTickets(env, { email: qa.admin.email, password: "12345678" }, subject, [
    ticket.id,
  ])

  let conn: Awaited<ReturnType<typeof establishMcpConnection>> | null = null
  try {
    conn = await establishMcpConnection(env, qa, { clientName: "E2E S1" })

    const mcpRes = (await conn.client.callTool({
      name: "tickets__search",
      arguments: { query: subject },
    })) as {
      isError?: boolean
      structuredContent?: Record<string, unknown>
      content?: Array<{ type: string; text: string }>
    }
    expect(mcpRes.isError).toBeFalsy()

    // Independently call the SAME tool through the in-app REST projection.
    const restToken = await freshAccessToken(env.serverUrl, qa.admin.email, "12345678")
    const restRes = await api(env.serverUrl, "/api/apps/run-tool", {
      method: "POST",
      token: restToken,
      body: { toolName: "tickets:search", params: { query: subject } },
    })
    expect(restRes.status, JSON.stringify(restRes.body)).toBe(200)

    // Normalize both payloads to the result object the tool returned.
    const mcpPayload =
      mcpRes.structuredContent ??
      (mcpRes.content?.[0]?.text ? JSON.parse(mcpRes.content[0].text) : null)
    const restPayload = restRes.body.data

    // Pull the seeded ticket out of each result by its stable identity.
    const findTicket = (payload: unknown): Record<string, unknown> | undefined => {
      const arrays: unknown[] = []
      const walk = (v: unknown) => {
        if (Array.isArray(v)) arrays.push(...v)
        else if (v && typeof v === "object") {
          for (const x of Object.values(v as Record<string, unknown>)) walk(x)
        }
      }
      walk(payload)
      return arrays.find(
        (r): r is Record<string, unknown> =>
          !!r && typeof r === "object" && (r as Record<string, unknown>).id === ticket.id,
      )
    }

    const mcpTicket = findTicket(mcpPayload)
    const restTicket = findTicket(restPayload)
    expect(
      mcpTicket,
      `MCP result did not include the seeded ticket; payload=${JSON.stringify(mcpPayload).slice(0, 400)}`,
    ).toBeTruthy()
    expect(restTicket, "in-app result did not include the seeded ticket").toBeTruthy()

    // Stable identifying fields must deep-equal across the two projections.
    for (const field of ["id", "subject", "status"] as const) {
      expect(mcpTicket?.[field], `field ${field} diverged`).toEqual(restTicket?.[field])
    }
    expect(mcpTicket?.subject).toBe(subject)
  } finally {
    await closeMcpClient(conn)
  }
})
