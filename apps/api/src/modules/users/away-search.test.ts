// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Reach of the away tool through the real search path: an org's registered catalog (kernel and
// in-tree apps), searched by tool_search with a project member's and a project lead's own scopes.
// A plain "I'm off" request finds `set_away` usable (not locked), for the person's own days and for
// a lead naming a colleague. A query whose every term matches loads it for the next step; one with
// a term it does not hold ("Friday") lists it with the way to load it.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { handleToolSearch } from "~/modules/agent/tools/tool-search"
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

async function search(query: string, scopes: string[]) {
  const frame = {
    runId: crypto.randomUUID(),
    parentRunId: null,
    rootRunId: crypto.randomUUID(),
    nestingDepth: 0,
    discoveredTools: new Set<string>(),
  }
  const res = await runContextStore.run(frame, () =>
    handleToolSearch({ query }, { orgId, userId: crypto.randomUUID(), scopes }),
  )
  const hit = res.matches.find((m) => m.name === "kernel__set_away")
  return { hit, loaded: frame.discoveredTools.has("kernel__set_away"), res }
}

/** Loaded for the next step, or listed by name with the way to load it. */
function reachable(loaded: boolean, note: string | undefined): boolean {
  return loaded || /Listed but NOT loaded: [^;]*kernel__set_away/.test(note ?? "")
}

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

describe("the away tool through tool search", () => {
  it("a member saying they are off finds it usable and loaded", async () => {
    for (const query of ["I'm off next Friday", "off next Friday", "away", "out of office"]) {
      const { hit, loaded, res } = await search(query, MEMBER)
      expect(hit, `${query}: ${res.matches.map((m) => m.name).join(", ")}`).toBeDefined()
      expect(hit?.locked, query).toBeUndefined()
      expect(reachable(loaded, res.note), query).toBe(true)
    }
  })

  it("a lead saying a colleague is off finds it usable and loaded, beside company days off", async () => {
    for (const query of ["Nadia is off week 48", "off week 48", "Nadia is off next Friday"]) {
      const { hit, loaded, res } = await search(query, LEAD)
      expect(hit, `${query}: ${res.matches.map((m) => m.name).join(", ")}`).toBeDefined()
      expect(hit?.locked, query).toBeUndefined()
      expect(reachable(loaded, res.note), query).toBe(true)
    }
  })

  it("a request that names a week or says away loads it at once", async () => {
    for (const query of ["away", "off week 48", "Nadia is off week 48"]) {
      expect((await search(query, LEAD)).loaded, query).toBe(true)
    }
  })

  it("the lead role holds the scope that sets a colleague's days", () => {
    expect(LEAD).toContain("projects:capacity:write")
  })
})
