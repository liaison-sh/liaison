// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import { env } from "~/lib/env"
import { listGatewayTools } from "~/modules/agent/tools/tool-bridge"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { createMcpConnection } from "~/modules/mcp/connection-service"
import { seedAgentForOrg } from "~/modules/mcp/test-helpers"
import { handleToolCall } from "~/modules/mcp/tool-call"
import { listMcpTools } from "~/modules/mcp/tool-projection"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

beforeAll(async () => {
  await acquireTestLock()
})
afterAll(async () => {
  await releaseTestLock()
})

describe("kernel report_bug tool", () => {
  let orgId: string
  let userId: string
  let email: string
  let connectionId: string

  beforeAll(async () => {
    const u = await minimal.person((await createTestOrg()).id)
    orgId = u.orgId
    userId = u.id
    email = u.email
    // report_bug parks after outside text, so a call needs the connection's thread.
    connectionId = (
      await createMcpConnection({ orgId, userId, clientId: "claude-code", label: "Claude Code" })
    ).connection.id
    await ensureAppsForOrg(orgId, {})
  }, 60_000)

  // A plain member: no tickets scope at all, exactly like most web form reporters, and
  // the scope every active member holds (every-member-scopes.ts).
  function actor(): UserContext {
    return {
      actorType: "user",
      userId,
      orgId,
      scopes: ["kernel:bug_reports:file", "kernel:threads:read"],
      dimensionGrants: {},
    }
  }

  test("an MCP client sees report_bug in its catalog with only the member baseline scope", () => {
    const names = listGatewayTools(orgId, actor() as never).map((t) => t.sdkName)
    expect(names).toContain("kernel__report_bug")
  })

  test("an MCP call files the report in the bug inbox layout, attributed to the calling user", async () => {
    const result = (await handleToolCall(
      {
        orgId,
        actor: actor(),
        connectionId,
        ownerUserId: userId,
        connectionThreadId: null,
        discovered: new Set(),
      },
      "kernel__report_bug",
      {
        title: "Approval link opens signed out",
        description: "Clicking the approval link from Claude lands on the login page.",
        page: "https://liaison.test/threads/abc",
        context: "request-42",
      },
    )) as { structuredContent?: Record<string, unknown>; isError?: boolean }
    expect(result.isError).toBeFalsy()
    const ticketId = result.structuredContent?.ticketId as string
    expect(ticketId).toBeTruthy()
    expect(result.structuredContent?.ticketHandle).toMatch(/^ticket/)

    const [ticket] = await sql`
      SELECT subject, channel FROM app_tickets.tickets WHERE id = ${ticketId}::uuid
    `
    expect(ticket.subject).toBe("Bug report: Approval link opens signed out")
    expect(ticket.channel).toBe("web_form")
    const [message] = await sql`
      SELECT text_body, from_email, created_by FROM app_tickets.messages
      WHERE ticket_id = ${ticketId}::uuid ORDER BY created_at ASC LIMIT 1
    `
    expect(message.from_email).toBe(email)
    expect(message.text_body).toContain("lands on the login page")
    expect(message.text_body).toContain("Additional context:\nrequest-42")
    expect(message.text_body).toContain(`Reported by: `)
    expect(message.text_body).toContain("Page: https://liaison.test/threads/abc")
    expect(message.text_body).toContain("Filed through: MCP client")
  })

  test("kernel:report_bug never forwards to the Liaison team, even with forwarding on (S5.8)", async () => {
    const mutableEnv = env as unknown as Record<string, string>
    const savedEndpoint = env.LIAISON_TEAM_ENDPOINT
    mutableEnv.LIAISON_TEAM_ENDPOINT = "http://127.0.0.1:9/webhooks/x/control"
    await sql`DELETE FROM kernel.control_plane_outbox`
    await sql`
      INSERT INTO kernel.instance_settings (key, value, decided_at) VALUES
        ('liaison_team.sharing', ${JSON.stringify({ register: true, forwardBugReports: true })}::jsonb, now()),
        ('liaison_team.identity', ${JSON.stringify({
          instanceId: crypto.randomUUID(),
          nonce: "A".repeat(43),
          keyCiphertext: null,
          state: "registered",
          registeredAt: new Date().toISOString(),
          authFailingSince: null,
          clockOffsetMs: 0,
        })}::jsonb, now())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
    try {
      const result = (await handleToolCall(
        {
          orgId,
          actor: actor(),
          connectionId,
          ownerUserId: userId,
          connectionThreadId: null,
          discovered: new Set(),
        },
        "kernel__report_bug",
        { title: "Forward check", description: "An agent-filed report stays local." },
      )) as { structuredContent?: Record<string, unknown>; isError?: boolean }
      expect(result.isError).toBeFalsy()
      expect(result.structuredContent?.ticketId).toBeTruthy()
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM kernel.control_plane_outbox
         WHERE type IN ('bug-report', 'bug-report-attachment')`
      expect(row?.n).toBe(0)
    } finally {
      mutableEnv.LIAISON_TEAM_ENDPOINT = savedEndpoint
      await sql`DELETE FROM kernel.instance_settings WHERE key LIKE 'liaison_team.%'`
    }
  })

  test("an agent-bound connection under an agent ceiling still lists report_bug, and no other tool outside the ceiling", async () => {
    const { agentId } = await seedAgentForOrg(orgId, {})
    const full: UserContext = {
      ...actor(),
      scopes: ["kernel:bug_reports:file", "kernel:threads:read", "tickets:tickets:read"],
    }
    // The agent's ceiling names neither the bug scope nor tickets.
    const listed = (
      await listMcpTools({ orgId, actor: full, agentId }, undefined, ["kernel:threads:read"])
    ).map((t) => t.name)
    expect(listed).toContain("kernel__report_bug")
    expect(listed.filter((n) => n.startsWith("tickets__"))).toEqual([])
  })
})
