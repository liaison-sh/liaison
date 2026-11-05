// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Changes to what the organization's members and agents can do are a person's decision, as role
// edits are (kernel:create_role): turning an app on, and overwriting an existing sub-agent role
// (its instructions and ceiling, for every later spawn). An agent's call parks one approval card;
// registering a NEW sub-agent role runs directly, bounded by the author's own scopes.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { executeToolCore } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let admin: minimal.Session
let threadId: string

const agentCall = (toolName: string, params: unknown) =>
  executeToolCore({
    toolName,
    orgId: admin.orgId,
    actor: {
      actorType: "user" as const,
      userId: admin.userId,
      orgId: admin.orgId,
      scopes: ["*"],
      dimensionGrants: {},
    },
    params,
    threadId,
    origin: "in-app-agent",
  })

const role = (slug: string, whenToUse: string) => ({
  agentType: slug,
  whenToUse,
  scopeCeiling: ["kernel:agent:web"],
  systemPrompt: `You research ${whenToUse}.`,
})

describe("access-changing kernel tools park for a person", () => {
  beforeAll(async () => {
    await acquireTestLock()
    admin = await minimal.adminSession((await createTestOrg()).id)
    threadId = await minimal.thread(admin.orgId, admin.userId)
    await ensureAppsForOrg(admin.orgId)
  })

  afterAll(async () => {
    await releaseTestLock()
  })

  it("enable_app parks one approval card", async () => {
    const res = await agentCall("kernel:enable_app", { appName: "invoicing" })
    expect("blocked" in res).toBe(true)
    const [card] = await sql`
      SELECT summary FROM kernel.approval_requests
      WHERE org_id = ${admin.orgId} AND tool_name = 'kernel:enable_app' AND status = 'pending'`
    expect(String(card?.summary?.title ?? "")).toBe("Turn on the invoicing app for the workspace")
  })

  it("switching an app to the state it is already in answers at once, with no card", async () => {
    const res = await agentCall("kernel:apps_set_enabled", { appName: "tickets", enabled: true })
    expect("blocked" in res).toBe(false)
    expect(res).toMatchObject({ data: { appName: "tickets", changed: false } })
    const rows = await sql`
      SELECT 1 FROM kernel.approval_requests
      WHERE org_id = ${admin.orgId} AND tool_name = 'kernel:apps_set_enabled'`
    expect(rows).toHaveLength(0)
  })

  it("subagent_create registers a new role directly, and parks an overwrite of an existing one", async () => {
    const slug = `researcher-${crypto.randomUUID().slice(0, 8)}`
    const created = await agentCall("kernel:subagent_create", role(slug, "dealers"))
    expect("blocked" in created).toBe(false)

    const overwrite = await agentCall("kernel:subagent_create", role(slug, "anything at all"))
    expect("blocked" in overwrite).toBe(true)
    const [row] = await sql`
      SELECT when_to_use FROM kernel.sub_agent_definitions
      WHERE org_id = ${admin.orgId} AND agent_type = ${slug}`
    expect(row?.when_to_use).toBe("dealers")
    const [card] = await sql`
      SELECT summary FROM kernel.approval_requests
      WHERE org_id = ${admin.orgId} AND tool_name = 'kernel:subagent_create' AND status = 'pending'`
    expect(String(card?.summary?.title ?? "")).toBe(`Change the existing sub-agent role "${slug}"`)
  })

  it("subagent_delete parks the deletion of an existing role; an unknown slug runs directly", async () => {
    const slug = `deleter-${crypto.randomUUID().slice(0, 8)}`
    expect("blocked" in (await agentCall("kernel:subagent_create", role(slug, "invoices")))).toBe(
      false,
    )

    const del = await agentCall("kernel:subagent_delete", { agentType: slug })
    expect("blocked" in del).toBe(true)
    const [row] = await sql`
      SELECT 1 AS present FROM kernel.sub_agent_definitions
      WHERE org_id = ${admin.orgId} AND agent_type = ${slug}`
    expect(row?.present).toBe(1)
    const [card] = await sql`
      SELECT summary FROM kernel.approval_requests
      WHERE org_id = ${admin.orgId} AND tool_name = 'kernel:subagent_delete' AND status = 'pending'`
    expect(String(card?.summary?.title ?? "")).toBe(`Delete the sub-agent role "${slug}"`)

    const none = await agentCall("kernel:subagent_delete", { agentType: `${slug}-none` })
    expect("blocked" in none).toBe(false)
  })
})
