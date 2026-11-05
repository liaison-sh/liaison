// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S19 / A6: the system prompt never names an app turned Off for the workspace,
// not its guide or summary line in "## Apps", not its tools in the deferred
// catalog, not its shipped skills.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { z } from "zod"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import { assembleContext, systemPartsToText } from "~/modules/agent/context/context"
import {
  agentInstructionsRegistry,
  skillRegistry,
  toolRegistry,
} from "~/modules/apps/app-registries"
import { setOrgAppStatus } from "~/modules/apps/org-app-service"
import { resetOrgRuntimeForTest } from "~/tests/helpers/org-runtime"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG_ID = "00000000-0000-0000-0000-0000000a2811"
const USER_ID = "00000000-0000-0000-0000-0000000a2812"
const THREAD_ID = "00000000-0000-0000-0000-0000000a2813"

const actor: UserContext = {
  actorType: "user",
  userId: USER_ID,
  orgId: ORG_ID,
  scopes: ["*"],
  dimensionGrants: {},
}

function plant() {
  // The deferred catalog is announced only to a turn that can call tool_search.
  toolRegistry.set([ORG_ID, "kernel", "tool_search"], {
    appName: "kernel",
    name: "tool_search",
    description: "Search the deferred catalog.",
    requiredScopes: ["kernel:threads:read"],
    handler: async () => null,
  } as unknown as Parameters<typeof toolRegistry.set>[1])
  skillRegistry.set([ORG_ID, "invoicing", "issue-an-invoice"], {
    name: "issue-an-invoice",
    description: "How to issue an invoice",
    body: "body",
    requiredScopes: [],
  })
  agentInstructionsRegistry.set(
    [ORG_ID, "invoicing"],
    "Invoicing issues invoices and credit notes.",
  )
  for (const name of ["documents_search", "drafts_create"]) {
    toolRegistry.set([ORG_ID, "invoicing", name], {
      appName: "invoicing",
      name,
      description: `invoicing ${name}`,
      requiredScopes: ["invoicing:documents:read"],
      params: z.object({}),
      handler: async () => ({ ok: true }),
    } as unknown as Parameters<typeof toolRegistry.set>[1])
  }
}

async function promptText(): Promise<string> {
  const result = await assembleContext({ threadId: THREAD_ID, orgId: ORG_ID, actor })
  return systemPartsToText(result.system)
}

describe("Off apps: prompt listings", () => {
  beforeAll(async () => {
    await acquireTestLock()
    resetOrgRuntimeForTest(ORG_ID)
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'HiddenCtxOrg', 'hidden-ctx-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER_ID}, ${ORG_ID}, 'hidden-ctx@test.com', 'Hidden Ctx') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${THREAD_ID}, ${ORG_ID}, 'hidden-ctx-1', 'agent_chat', ${USER_ID}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD_ID}, ${USER_ID}, ${ORG_ID}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.apps (org_id, name, version) VALUES (${ORG_ID}, 'invoicing', '1.0.0') ON CONFLICT DO NOTHING`
  })
  afterEach(async () => {
    toolRegistry.deleteByPrefix([ORG_ID])
    skillRegistry.deleteByPrefix([ORG_ID])
    agentInstructionsRegistry.deleteByPrefix([ORG_ID])
    await setOrgAppStatus(ORG_ID, "invoicing", "active")
  })
  afterAll(async () => {
    resetOrgRuntimeForTest(ORG_ID)
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.apps WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
    await releaseTestLock()
  })

  it("discriminator: an app that is On appears in the app summaries and the deferred catalog", async () => {
    plant()
    const text = await promptText()
    expect(text).toContain("**invoicing**")
    expect(text).toContain("- invoicing: documents_search, drafts_create")
    expect(text).toContain("- issue-an-invoice — How to issue an invoice")
  })

  it("an Off app appears in neither", async () => {
    plant()
    await setOrgAppStatus(ORG_ID, "invoicing", "disabled")
    const text = await promptText()
    expect(text).not.toContain("**invoicing**")
    expect(text).not.toContain("documents_search")
    expect(text).not.toContain("Invoicing issues invoices")
    expect(text).not.toContain("issue-an-invoice")
  })
})
