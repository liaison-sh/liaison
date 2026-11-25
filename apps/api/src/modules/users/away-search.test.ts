// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Reach of the away tool in an org's registered catalog (kernel and in-tree apps): `set_away` is
// loaded with every turn's tools, as the memory tools are, so a person's days off are recorded
// where they set them away rather than noted. A project member and a project lead hold what it
// asks for (a colleague's days need the lead's projects:capacity:write, checked by the tool).

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { isDeferredTool } from "~/modules/agent/tools/tool-bridge"
import {
  agentInstructionsRegistry,
  skillRegistry,
  toolRegistry,
} from "~/modules/apps/app-registries"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { createTestOrg } from "~/tests/helpers/org"

const PROJECTS_MANIFEST = join(import.meta.dir, "../../apps/projects/app.manifest.json")

interface Role {
  extends?: string
  scopes: string[]
}

/** A projects role's scopes, its parent's included, as the manifest declares them. */
function projectsRole(name: string): string[] {
  const roles = (
    JSON.parse(readFileSync(PROJECTS_MANIFEST, "utf8")) as { roles: Record<string, Role> }
  ).roles
  const role = roles[name]
  if (!role) throw new Error(`no projects role ${name}`)
  return [...(role.extends ? projectsRole(role.extends) : []), ...role.scopes]
}

const MEMBER = ["kernel:threads:read", ...projectsRole("member")]
const LEAD = ["kernel:threads:read", ...projectsRole("lead")]

let orgId = ""

beforeAll(async () => {
  orgId = (await createTestOrg()).id
  await ensureAppsForOrg(orgId)
  const { registerKernelAgentTools } = await import("~/modules/agent/tools/kernel-tools")
  await registerKernelAgentTools(orgId)
})

afterAll(() => {
  toolRegistry.deleteByPrefix([orgId])
  skillRegistry.deleteByPrefix([orgId])
  agentInstructionsRegistry.deleteByPrefix([orgId])
})

describe("the away tool is at hand on every turn", () => {
  it("set_away is loaded with the turn's tools, never behind a search", () => {
    const def = toolRegistry.get([orgId, "kernel", "set_away"])
    expect(def).toBeDefined()
    expect(isDeferredTool("kernel", def as { deferLoading?: boolean })).toBe(false)
  })

  it("a member and a lead may call it: it asks only for what every member holds", () => {
    const def = toolRegistry.get([orgId, "kernel", "set_away"]) as { requiredScopes?: string[] }
    for (const scopes of [MEMBER, LEAD]) {
      for (const s of def.requiredScopes ?? []) expect(scopes).toContain(s)
    }
  })

  it("the lead role holds the scope that sets a colleague's days", () => {
    expect(LEAD).toContain("projects:capacity:write")
  })
})
