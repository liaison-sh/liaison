// SPDX-License-Identifier: FSL-1.1-ALv2
//
// create_routine from an agent conversation files ONE approval card, and that card is the user's
// confirmation of the routine's scopes. There is no earlier "propose the scopes, end the turn, call
// again" step: a small model never ran that protocol and told the user an approval card was waiting
// when none had been filed. Approving the card creates the routine with exactly the scopes it lists;
// rejecting it creates nothing.
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import * as eventBusModule from "~/infra/events/event-bus"
import { registerSkillRoutineTools } from "~/modules/agent/tools/skills-routines-tools"
import { decideApproval } from "~/modules/approvals/decide"
import { executeTool } from "~/modules/apps/execute-tool"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"

const broadcastSpy = spyOn(eventBusModule, "broadcastEphemeral").mockImplementation(async () => {})

describe("create_routine: the approval card is the scopes confirmation", () => {
  let admin: minimal.Session
  let threadId: string
  const actor = (): UserContext => ({
    actorType: "user",
    userId: admin.userId,
    orgId: admin.orgId,
    scopes: ["*"],
    dimensionGrants: {},
  })

  beforeAll(async () => {
    admin = await minimal.adminSession((await createTestOrg()).id)
    threadId = await minimal.thread(admin.orgId, admin.userId)
    await registerSkillRoutineTools(admin.orgId)
  })

  afterAll(() => {
    broadcastSpy.mockRestore()
  })

  // The agent calls create_routine in the user's conversation with nothing said about scopes yet.
  const propose = (name: string, scopes: string[]) =>
    executeTool({
      toolName: "kernel:create_routine",
      orgId: admin.orgId,
      actor: actor(),
      params: {
        name,
        description: "Daily ticket digest",
        kind: "recurring",
        cron: "0 8 * * *",
        timezone: "UTC",
        prompt: "Search open tickets and post a short digest.",
        scopes,
      },
      threadId,
      origin: "in-app-agent",
      stepBundleId: null,
    })

  const summaryLines = (res: { blocked?: { summary?: unknown } }): string[] =>
    (res.blocked?.summary as { lines?: string[] } | undefined)?.lines ?? []

  const routinesNamed = (name: string) =>
    sql<Array<{ id: string; scopes: string[] }>>`
      SELECT id, scopes FROM kernel.routines WHERE org_id = ${admin.orgId} AND name = ${name}`

  it("files a pending approval whose summary says in words what the routine reads and changes", async () => {
    const res = await propose("digest-pending", ["tickets:tickets:read", "tickets:tickets:reply"])
    const approvalId = res.blocked?.approvalRequestId
    expect(approvalId).toMatch(/^[0-9a-f-]{36}$/)
    const [row] = await sql<Array<{ status: string; tool_name: string }>>`
      SELECT status, tool_name FROM kernel.approval_requests WHERE id = ${approvalId as string}`
    expect(row).toMatchObject({ status: "pending", tool_name: "kernel:create_routine" })
    expect(await routinesNamed("digest-pending")).toHaveLength(0)

    const lines = summaryLines(res).join("\n")
    // Plain words, split into what it reads and what it changes, within the card's first lines.
    const firstLines = summaryLines(res).slice(0, 8)
    expect(firstLines.some((l) => /^It will read: /.test(l))).toBe(true)
    expect(firstLines.some((l) => /^It will change: /.test(l))).toBe(true)
    const reads = firstLines.find((l) => l.startsWith("It will read: ")) ?? ""
    const changes = firstLines.find((l) => l.startsWith("It will change: ")) ?? ""
    expect(reads).not.toContain("tickets:tickets:read")
    expect(changes).not.toContain("tickets:tickets:reply")
    expect(reads.toLowerCase()).toContain("ticket")
    expect(changes.toLowerCase()).toContain("ticket")
    expect(lines).not.toMatch(/END THIS TURN|NOT CREATED/)
  })

  it("approving it creates the routine with exactly the listed scopes", async () => {
    const scopes = ["tickets:tickets:read"]
    const res = await propose("digest-approved", scopes)
    const approvalId = res.blocked?.approvalRequestId as string
    expect(approvalId).toBeDefined()
    await decideApproval({
      orgId: admin.orgId,
      requestId: approvalId,
      actor: { ...actor(), scopes: ["*", "kernel:approve"] },
      decision: "approve",
    })
    const created = await routinesNamed("digest-approved")
    expect(created).toHaveLength(1)
    expect(created[0]?.scopes).toEqual(scopes)
  })

  it("rejecting it creates nothing", async () => {
    const res = await propose("digest-rejected", ["tickets:tickets:read"])
    const approvalId = res.blocked?.approvalRequestId as string
    expect(approvalId).toBeDefined()
    await decideApproval({
      orgId: admin.orgId,
      requestId: approvalId,
      actor: { ...actor(), scopes: ["*", "kernel:approve"] },
      decision: "deny",
    })
    expect(await routinesNamed("digest-rejected")).toHaveLength(0)
  })

  it("a routine that needs no scope says so on the card and is filed the same way", async () => {
    const res = await propose("reminder-no-scopes", [])
    expect(res.blocked?.approvalRequestId).toBeDefined()
    expect(
      summaryLines(res)
        .slice(0, 8)
        .some((l) => /needs no access/i.test(l)),
    ).toBe(true)
  })
})
