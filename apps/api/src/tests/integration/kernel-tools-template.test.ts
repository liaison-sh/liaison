// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The kernel's tools are built once per process and replayed per org
// (kernel-tools.ts, registries.ts `captureRegistrationTemplate`). An org
// registered from the template must hold exactly what building them for it
// would have written, key for key and in the same order, and every org must
// share the definitions instead of holding a copy.
import { describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import {
  KernelToolsTestAccess,
  refreshWebSearchToolRegistration,
  registerKernelAgentTools,
} from "~/modules/agent/tools/kernel-tools"
import { dimensionDefRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { RegistriesTestAccess, TEMPLATE_ORG } from "~/modules/apps/registries"

async function newOrg(tag: string): Promise<string> {
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Template Org', ${`kt-template-${tag}-${Date.now()}`}) RETURNING id`),
  )
  return org.id
}

describe("kernel tools template", () => {
  it("writes for an org exactly what building them for it writes, shared across orgs", async () => {
    KernelToolsTestAccess.resetTemplate()
    const [viaTemplate, built, another] = [await newOrg("a"), await newOrg("b"), await newOrg("c")]
    await registerKernelAgentTools(viaTemplate)
    await KernelToolsTestAccess.buildWithoutTemplate(built)
    await refreshWebSearchToolRegistration(built)
    await registerKernelAgentTools(another)

    const fromTemplate = RegistriesTestAccess.keysUnder(viaTemplate)
    const direct = RegistriesTestAccess.keysUnder(built)
    expect(fromTemplate.size).toBeGreaterThan(0)
    expect([...fromTemplate.keys()]).toEqual([...direct.keys()])
    for (const [registryId, keys] of direct) expect(fromTemplate.get(registryId)).toEqual(keys)
    expect(toolRegistry.has([viaTemplate, "kernel", "user_memory_get"])).toBe(true)

    // Shared, not copied: the same definition object in every org.
    const a = toolRegistry.get([viaTemplate, "kernel", "user_memory_get"])
    expect(toolRegistry.get([another, "kernel", "user_memory_get"])).toBe(a)
    expect(toolRegistry.get([built, "kernel", "user_memory_get"])).not.toBe(a)

    // Nothing is left under the capture org.
    expect(RegistriesTestAccess.keysUnder(TEMPLATE_ORG).size).toBe(0)
  })

  it("re-establishes the cross-org entries on every registration, after a registry reset", async () => {
    const org = await newOrg("d")
    await registerKernelAgentTools(org)
    dimensionDefRegistry.delete(["*", "kernel", "skills_domain"])
    await registerKernelAgentTools(org)
    expect(dimensionDefRegistry.get(["*", "kernel", "skills_domain"])).toBeDefined()
  })
})
