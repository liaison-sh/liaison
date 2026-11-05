// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Standing invariant over the WHOLE registered catalog, not one tool: every
// tool schema the agent hands a provider must project to JSON Schema with
// `items` as a single schema, sitting only on a node that describes an array.
// Gemini's function_declarations are a protobuf projection where `items` is
// not a repeating field, so one tuple anywhere in the catalog 400s the entire
// turn (finishReason "error") whatever tool the model was reaching for.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { asSchema } from "ai"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import { ALL_DEFERRED_TOOLS_UNLOCKED, buildToolSet } from "~/modules/agent/tools/tool-bridge"
import {
  agentInstructionsRegistry,
  skillRegistry,
  toolRegistry,
} from "~/modules/apps/app-registries"
import { findProviderSchemaViolations } from "./provider-schema"

const ORG_ID = "00000000-0000-0000-0000-000000db0001"

describe("tool schemas are provider-safe", () => {
  beforeAll(async () => {
    const { registerKernelAgentTools } = await import("~/modules/agent/tools/kernel-tools")
    await registerKernelAgentTools(ORG_ID)
  })

  afterAll(async () => {
    toolRegistry.deleteByPrefix([ORG_ID])
    skillRegistry.deleteByPrefix([ORG_ID])
    agentInstructionsRegistry.deleteByPrefix([ORG_ID])
    await sql`DELETE FROM kernel.role_scope_grants WHERE role_id IN (SELECT id FROM kernel.roles WHERE org_id = ${ORG_ID})`
    await sql`DELETE FROM kernel.user_roles WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.roles WHERE org_id = ${ORG_ID}`
  })

  it("every registered tool projects an items that is a single schema on an array", () => {
    const actor: UserContext = {
      actorType: "user",
      userId: "00000000-0000-0000-0000-000000db0002",
      orgId: ORG_ID,
      scopes: ["*"],
      dimensionGrants: {},
    }
    const tools = buildToolSet(ORG_ID, actor, undefined, ALL_DEFERRED_TOOLS_UNLOCKED)
    expect(Object.keys(tools).length).toBeGreaterThan(10)
    const offenders: string[] = []
    for (const [name, def] of Object.entries(tools)) {
      const projected = asSchema((def as { inputSchema: never }).inputSchema)
      for (const v of findProviderSchemaViolations(projected.jsonSchema))
        offenders.push(`${name} ${v}`)
    }
    expect(offenders).toEqual([])
  })
})
